#!/usr/bin/env node
// Dependency-free mock of the multi-tenant agentwallet HTTP API
// (agentwallet/docs/API.md). Serves ../static at "/" and keeps per-user state
// in memory: sessions (aw_session cookie), smart accounts, agents with limits
// and statuses, API keys, payments, conversations and a scripted chat agent.
//
//   node agentwallet/web/e2e/mock.mjs            # http://127.0.0.1:8090
//   PORT=0 node mock.mjs                         # random port, printed on stdout
//
// Env:
//   PORT=8090         listen port (0 = random)
//   HOST=127.0.0.1    listen address
//   DEV_WALLET=1      dev_wallet in /api/config and POST /api/dev/fund (default 1; 0 turns it off)
//   MOCK_LLM=0        pretend LLM_API_KEY is missing (llm_configured=false, no models)
//   MOCK_VERIFY=1     verify raw {signature} submissions as ed25519 over `hash` with the user's
//                     G key (default off: any signature is accepted, as the contract allows)
//   MOCK_SPEED=1      multiplier for all delays (0.2 = 5x faster)
//
// Every non-GET /api/* request must carry "X-Agentwallet: 1" or gets 403 csrf.
// GET /api/_mock/stats reports how many requests were rejected that way.
//
// Scripted chat (per agent; English phrase matching):
//   "How much money do I have?" / "balance"  -> wallet_info
//   "Pay 1 USDC to G..."                     -> pay -> tool_result ok -> tx -> text
//   "Pay 10 USDC ..." (over the agent limit) -> pay -> tool_result spending_limit_exceeded
//   "Pay 3 USDC ..."  (> approval 2)         -> pay -> approval_required -> (POST approve) -> approval_resolved -> tool_result -> tx
//   "Simulate / check 2 USDC"                -> simulate_payment
//   "Why did the payment fail?"              -> payment_history + explanation
//   "Show payment history"                   -> payment_history
//   "server error"                           -> fatal `error` event (for the retry UI)
//   anything else                            -> help text

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes, createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.resolve(HERE, '../static');
const PORT = Number(process.env.PORT ?? 8090);
const HOST = process.env.HOST || '127.0.0.1';
const LLM = process.env.MOCK_LLM !== '0';
const DEV_WALLET = process.env.DEV_WALLET !== '0';
const VERIFY = process.env.MOCK_VERIFY === '1';
const SPEED = Math.max(0, Number(process.env.MOCK_SPEED ?? 1));

const EXPLORER = 'https://stellar.expert/explorer/testnet';
const PASSPHRASE = 'Test SDF Network ; September 2015';
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const VERIFIER = 'CACX7VUUKW6MUJ5FCNHZRTK7ZXAAQ6RSHRGX24HNVNMX2TXMUKS4POZ7';
const POLICY = 'CBTDPBAOKKRC4UYNQOHNKT63NL76RMD6W2HRQTMUIEGA6NLUQJVP4YJP';
const PAYEE = 'GB3WNAVXMVP6TDJ6CN3TVD5GO5LDZA52U7G44X76UQR7JAKXE6DAEBN6';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const APPROVAL_THRESHOLD = 2;
const PERIOD = 17280;
const LEDGER_SECONDS = 5;
const OP_TTL_MS = 10 * 60 * 1000;
const XLM_PER_USDC = 6.2;

/* ---------------- helpers ---------------- */

const LEDGER0 = 5572300;
const T0 = Date.now();
const ledger = () => LEDGER0 + Math.floor((Date.now() - T0) / (LEDGER_SECONDS * 1000));
const isoNow = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const hex = (n = 32) => randomBytes(n).toString('hex');
const fmt = (n) => String(Number(Number(n).toFixed(7)));
const short = (s) => (s && s.length > 9 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
const txUrl = (h) => `${EXPLORER}/tx/${h}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));
const AMOUNT = /^\d+(\.\d{1,7})?$/;

// StrKey (independent of the UI's implementation, so the e2e test cross-checks it).
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function crc16(buf) {
  let crc = 0;
  for (const b of buf) { crc ^= b << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  return crc;
}
function strkey(version, payload) {
  const data = Buffer.alloc(35);
  data[0] = version; payload.copy(data, 1);
  data.writeUInt16LE(crc16(data.subarray(0, 33)), 33);
  let bits = '', out = '';
  for (const b of data) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function unstrkey(version, s) {
  if (typeof s !== 'string' || !/^[A-Z2-7]{56}$/.test(s)) return null;
  let bits = '';
  for (const c of s) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const data = Buffer.alloc(35);
  for (let i = 0; i < 35; i++) data[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  if (data[0] !== version || data.readUInt16LE(33) !== crc16(data.subarray(0, 33))) return null;
  return data.subarray(1, 33);
}
const G = (buf) => strkey(6 << 3, buf);
const C = (buf) => strkey(2 << 3, buf);
const isG = (s) => !!unstrkey(6 << 3, s);
const randomG = () => G(randomBytes(32));
const accountOf = (address) => C(createHash('sha256').update(`agentwallet:${address}`).digest());

function verifySig(address, hashHex, sigB64) {
  const pub = unstrkey(6 << 3, address);
  if (!pub) return false;
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]), format: 'der', type: 'spki' });
  try { return edVerify(null, Buffer.from(hashHex, 'hex'), key, Buffer.from(sigB64, 'base64')); } catch { return false; }
}

/* ---------------- state ---------------- */

const users = new Map();      // G address -> user
const sessions = new Map();   // session id -> address
const ops = new Map();        // op_id -> op
const conversations = new Map();
const apiKeys = new Map();    // sha256(key) -> {agentId, address}
const stats = { csrf_rejections: 0, unauthorized: 0, bad_signatures: 0, requests: 0 };

function user(address) {
  let u = users.get(address);
  if (!u) {
    u = {
      address, account: accountOf(address), deployed: false,
      wallet: { xlm: 0, usdc: 0, trustline: false },
      balance: 0, agents: [], payments: [], nextRule: 1,
    };
    users.set(address, u);
  }
  return u;
}

function limitInfo(a) {
  if (!a.limit) return { installed: false, limit: null, spent: null, remaining: null, period_ledgers: null, resets_in_seconds: null };
  const L = ledger();
  const win = a.history.filter((x) => L - x.ledger < PERIOD);
  const spent = win.reduce((s, x) => s + x.amount, 0);
  const oldest = win.reduce((m, x) => Math.min(m, x.ledger), Infinity);
  return {
    installed: true, limit: fmt(a.limit), spent: fmt(spent), remaining: fmt(Math.max(0, a.limit - spent)),
    period_ledgers: PERIOD, resets_in_seconds: win.length ? (oldest + PERIOD - L) * LEDGER_SECONDS : null,
  };
}

function status(a) {
  if (a.pending) return 'pending';
  if (a.revoked) return 'revoked';
  if (a.validUntil !== null && ledger() > a.validUntil) return 'expired';
  return 'active';
}

function agentJSON(u, a) {
  return {
    id: a.id, name: a.name, public_key: a.publicKey, rule_id: a.ruleId, status: status(a),
    valid_until: a.validUntil, created_at: a.createdAt, limit: limitInfo(a),
    api_keys: a.keys.map((k) => ({ prefix: k.prefix, created_at: k.createdAt, last_used_at: k.lastUsedAt })),
    payments_count: u.payments.filter((p) => p.agent_id === a.id).length,
  };
}

function meJSON(u) {
  return {
    address: u.address, account: u.account, account_deployed: u.deployed,
    wallet: { xlm: fmt(u.wallet.xlm), usdc: fmt(u.wallet.usdc), usdc_trustline: u.wallet.trustline },
    account_url: `${EXPLORER}/contract/${u.account}`,
    chat: chatUsage(u),
  };
}

const CHAT_DAILY = Number(process.env.MOCK_CHAT_DAILY ?? 50);
function chatUsage(u) {
  const d = new Date();
  const resets = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
  return { used: u.chatUsed || 0, limit: CHAT_DAILY, resets_at: resets };
}

function accountJSON(u) {
  return {
    address: u.account, url: `${EXPLORER}/contract/${u.account}`,
    balances: [{ asset: 'USDC', contract: USDC, amount: fmt(u.balance) }],
    latest_ledger: ledger(),
    rules: [
      { id: 0, name: 'owner', context_type: 'Default', target: null, signers: [{ kind: 'Delegated', address: u.address }], policies: [], valid_until: null },
      ...u.agents.filter((a) => !a.pending).map((a) => ({
        id: a.ruleId, name: a.name, context_type: 'CallContract', target: USDC,
        signers: [{ kind: 'External', verifier: VERIFIER, key: a.publicKey }], policies: a.limit ? [POLICY] : [], valid_until: a.validUntil,
      })),
    ],
    agents: u.agents.map((a) => agentJSON(u, a)),
  };
}

function configJSON() {
  return {
    network: 'testnet', network_passphrase: PASSPHRASE, explorer: EXPLORER, usdc_contract: USDC,
    default_model: DEFAULT_MODEL, llm_configured: LLM, approval_threshold: String(APPROVAL_THRESHOLD),
    dev_wallet: DEV_WALLET, demo_payee: PAYEE, period_ledgers: PERIOD, ledger_seconds: LEDGER_SECONDS,
    limits: { chat_max_chars: 4000, chat_daily: CHAT_DAILY },
  };
}

const MODELS = [
  { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o-mini', context_length: 128000 },
  { id: 'mistralai/mistral-small-3.2', name: 'Mistral: Small 3.2', context_length: 128000 },
  { id: 'google/gemini-2.5-flash', name: 'Google: Gemini 2.5 Flash', context_length: 1048576 },
  { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Meta: Llama 3.3 70B Instruct', context_length: 131072 },
];

/* ---------------- ops ---------------- */

class ApiErr extends Error {
  constructor(status, code, message, details = null) { super(message); this.status = status; this.code = code; this.details = details; }
}
class OpFail extends Error {
  constructor(code, message, details = null) { super(message); this.code = code; this.details = details; }
}

/** Creates an op. apply(u) runs on submit and returns the `result` (or throws OpFail). */
function makeOp(address, kind, summary, apply, { challenge = false } = {}) {
  const raw = randomBytes(kind === 'auth' ? 96 : 180);
  const b64 = raw.toString('base64');
  const op = {
    op_id: `op_${hex(8)}`, kind, summary,
    network_passphrase: PASSPHRASE,
    expires_at: new Date(Date.now() + OP_TTL_MS).toISOString().replace(/\.\d+Z$/, 'Z'),
    hash: createHash('sha256').update(raw).digest('hex'),
  };
  if (kind === 'auth') op.preimage = b64; else op.xdr = b64;
  ops.set(op.op_id, { ...op, owner: address, apply, challenge, expires: Date.now() + OP_TTL_MS });
  return op;
}

function signatureOf(body) {
  const given = ['signed_auth_entry', 'signed_xdr', 'signature'].filter((k) => body[k] !== undefined && body[k] !== null && body[k] !== '');
  if (given.length !== 1) throw new ApiErr(400, 'invalid_argument', 'send exactly one of signed_auth_entry, signed_xdr or signature');
  const k = given[0];
  if (typeof body[k] !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(body[k])) throw new ApiErr(400, 'invalid_argument', `"${k}" must be base64`);
  return k;
}

function takeOp(id, address, body, { challenge = false } = {}) {
  const op = ops.get(id);
  if (!op || op.challenge !== challenge) throw new ApiErr(404, 'not_found', 'op not found');
  if (op.owner !== address) throw new ApiErr(403, 'forbidden', 'this op belongs to another user');
  if (Date.now() > op.expires) { ops.delete(id); throw new ApiErr(410, 'op_expired', 'the op expired; prepare it again'); }
  const k = signatureOf(body);
  if (op.kind === 'auth' && k === 'signed_xdr') throw new ApiErr(400, 'invalid_argument', 'this op is an auth entry; send signed_auth_entry or signature');
  if (op.kind === 'tx' && k === 'signed_auth_entry') throw new ApiErr(400, 'invalid_argument', 'this op is a transaction; send signed_xdr or signature');
  ops.delete(id);
  if (VERIFY && k === 'signature' && !verifySig(address, op.hash, body.signature)) {
    stats.bad_signatures++;
    return { op, badSig: true };
  }
  return { op, badSig: false };
}

const newTx = () => { const h = hex(); return { hash: h, url: txUrl(h), status: 'SUCCESS' }; };

function amountArg(v, name = 'amount') {
  const s = String(v ?? '');
  if (!AMOUNT.test(s) || !(Number(s) > 0)) throw new ApiErr(400, 'invalid_argument', `"${name}" must be a positive decimal string`);
  return Number(s);
}

function findAgent(u, id) {
  const a = u.agents.find((x) => x.id === id);
  if (!a) throw new ApiErr(404, 'not_found', 'agent not found');
  return a;
}

function requireDeployed(u) {
  if (!u.deployed) throw new ApiErr(409, 'account_not_deployed', 'deploy your account first (POST /api/account)');
}

function newApiKey(u, a) {
  const key = `awk_${hex(24)}`;
  const k = { prefix: key.slice(0, 8), createdAt: isoNow(), lastUsedAt: null, hash: createHash('sha256').update(key).digest('hex') };
  a.keys.push(k);
  apiKeys.set(k.hash, { address: u.address, agentId: a.id });
  return key;
}

/* ---------------- tools ---------------- */

const toolErr = (code, message, details = null) => ({ ok: false, result: null, error: { code, message, details } });
const toolOk = (result) => ({ ok: true, result, error: null });

function walletInfo(u, a) {
  return toolOk({
    address: u.account, url: `${EXPLORER}/contract/${u.account}`,
    balances: [{ asset: 'USDC', contract: USDC, amount: fmt(u.balance) }], limit: limitInfo(a),
    agent: { id: a.id, name: a.name, public_key: a.publicKey, rule_id: a.ruleId, status: status(a), active: status(a) === 'active', valid_until: a.validUntil },
    latest_ledger: ledger(),
  });
}

function checkPayment(u, a, to, amount) {
  if (!/^[GC][A-Z2-7]{55}$/.test(to || '')) return toolErr('invalid_argument', `"to" must be a Stellar G… or C… address, got ${JSON.stringify(to)}`);
  if (!(amount > 0)) return toolErr('invalid_argument', '"amount" must be a positive decimal');
  const st = status(a);
  if (st !== 'active') return toolErr('agent_inactive', `Agent "${a.name}" (rule #${a.ruleId}) is ${st}${a.validUntil !== null ? `: valid_until ledger ${a.validUntil}` : ''}`, { status: st, valid_until: a.validUntil });
  // Same order as on-chain: the policy runs in __check_auth before the SAC checks the balance.
  const lim = limitInfo(a);
  if (lim.installed && amount > Number(lim.remaining)) {
    return toolErr('spending_limit_exceeded', 'Error(Contract, #3221): the spending-limit policy rejected the agent signature in __check_auth', {
      limit: lim.limit, spent: lim.spent, remaining: lim.remaining, requested: fmt(amount), resets_in_seconds: lim.resets_in_seconds,
    });
  }
  if (amount > u.balance) return toolErr('insufficient_balance', 'The agent wallet balance is lower than the amount', { balance: fmt(u.balance), requested: fmt(amount) });
  return null;
}

function payRecord(u, a, fields) {
  const L = ledger();
  const p = { hash: null, url: null, agent_id: a.id, agent_name: a.name, asset: 'USDC', error: null, ledger: L, created_at: isoNow(), source: 'chat', ...fields };
  u.payments.unshift(p);
  return p;
}

function settle(u, a, to, amount) {
  const h = hex();
  u.balance -= amount;
  a.history.push({ amount, ledger: ledger() });
  return payRecord(u, a, { hash: h, url: txUrl(h), to, amount: fmt(amount), status: 'SUCCESS' });
}

const historyOf = (u, a, limit = 20) => u.payments.filter((p) => p.agent_id === a.id).slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));

/* ---------------- chat ---------------- */

class Aborted extends Error {}

function turnContext(res, conv) {
  const ctx = {
    aborted: false,
    assistant: null,
    send(event, data) {
      if (ctx.aborted) throw new Aborted();
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    async sleep(ms) {
      const end = Date.now() + ms * SPEED;
      while (Date.now() < end) {
        if (ctx.aborted) throw new Aborted();
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(25, end - Date.now()))));
      }
      if (ctx.aborted) throw new Aborted();
    },
    msg() {
      if (!ctx.assistant) {
        ctx.assistant = { role: 'assistant', content: '', tool_calls: [] };
        conv.messages.push(ctx.assistant);
      }
      return ctx.assistant;
    },
    async say(text) {
      const m = ctx.msg();
      let i = 0;
      while (i < text.length) {
        const n = 2 + Math.floor(Math.random() * 6);
        const chunk = text.slice(i, i + n);
        i += n;
        m.content += chunk;
        ctx.send('text_delta', { text: chunk });
        await ctx.sleep(12 + Math.random() * 22);
      }
    },
    async tool(name, args, run) {
      const id = `call_${hex(6)}`;
      const m = ctx.msg();
      m.tool_calls.push({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      ctx.send('tool_call', { id, name, arguments: args });
      await ctx.sleep(350 + Math.random() * 300);
      const r = await run(id);
      conv.messages.push({ role: 'tool', tool_call_id: id, name, content: JSON.stringify(r.out) });
      ctx.assistant = null;
      ctx.send('tool_result', { id, name, ok: r.out.ok, result: r.out.result, error: r.out.error });
      if (r.tx) ctx.send('tx', r.tx);
      return r.out;
    },
  };
  return ctx;
}

const RE_ADDR = /\b([GC][A-Z2-7]{55})\b/;

async function runTurn(ctx, conv, u, a, text) {
  const addr = (RE_ADDR.exec(text) || [])[1];
  const rest = text.replace(RE_ADDR, ' ');
  const amountM = /(\d+(?:[.,]\d+)?)/.exec(rest);
  const amount = amountM ? Number(amountM[1].replace(',', '.')) : null;
  const t = text.toLowerCase();

  if (/server error/.test(t)) {
    await ctx.say('One moment, checking the wallet…');
    await ctx.sleep(300);
    ctx.send('error', { message: 'Upstream model error: 502 Bad Gateway (mock)' });
    return;
  }

  if (/\bwhy\b|did(?:n't| not)? .*fail|\bfailed\b/.test(t)) return explainFailure(ctx, u, a);

  if (amount !== null && /(simulat|\bcheck|dry.?run|\bcan i\b)/.test(t)) {
    const to = addr || PAYEE;
    const out = await ctx.tool('simulate_payment', { to, amount: fmt(amount) }, async () => {
      const e = checkPayment(u, a, to, amount);
      return { out: e || toolOk({ would_succeed: true, to, amount: fmt(amount), asset: 'USDC', fee_xlm: '0.0012345', latest_ledger: ledger() }) };
    });
    if (out.ok) await ctx.say(`The simulation passed: a **${fmt(amount)} USDC** payment to \`${short(to)}\` would pass the smart account's checks. The fee is about 0.0012 XLM. Should I send it?`);
    else await ctx.say(`The simulation shows the payment **would fail**: ${explainCode(out.error)}`);
    return;
  }

  if (amount !== null && /\b(pay|send|transfer)/.test(t)) return pay(ctx, conv, u, a, addr || PAYEE, amount);

  if (/(history|payments|transactions)/.test(t)) {
    const out = await ctx.tool('payment_history', { limit: 5 }, async () => ({ out: toolOk({ items: historyOf(u, a, 5) }) }));
    const items = out.result.items;
    if (!items.length) return ctx.say('There have been no payments yet.');
    const lines = items.map((p) => {
      const st = p.status === 'SUCCESS' ? 'succeeded' : `**rejected** (\`${p.error?.code || 'error'}\`)`;
      return `- **${p.amount} USDC** → \`${short(p.to)}\`: ${st}${p.url ? ` · [tx](${p.url})` : ''}`;
    });
    return ctx.say(`My recent payments:\n\n${lines.join('\n')}\n\nAll links open stellar.expert.`);
  }

  if (/(how much|balance|money|funds|limit|wallet)/.test(t)) {
    const out = await ctx.tool('wallet_info', {}, async () => ({ out: walletInfo(u, a) }));
    const r = out.result;
    let s = `Your agent wallet holds **${r.balances[0].amount} USDC**.\n\n`;
    if (r.limit.installed) {
      const reset = r.limit.resets_in_seconds ? ` The window resets in ~${Math.round(r.limit.resets_in_seconds / 3600)} h.` : '';
      s += `My daily limit: **${r.limit.spent}** of **${r.limit.limit} USDC** spent, **${r.limit.remaining} USDC** remaining.${reset}\n\n`;
    } else {
      s += 'There is **no spending limit** on my rule right now; set one on the dashboard.\n\n';
    }
    if (!r.agent.active) s += `Note: I am **${r.agent.status}**, so I cannot pay right now.\n\n`;
    s += `Smart account: \`${short(r.address)}\`, [open in stellar.expert](${r.url}).`;
    return ctx.say(s);
  }

  return ctx.say([
    `I'm **${a.name}**, an agent with a key on your USDC smart account on Stellar testnet. Here is what I can do:`,
    '',
    '- show the **balance and my limit** (`wallet_info`);',
    '- check a payment without sending it (`simulate_payment`);',
    `- **pay** within my limit (\`pay\`). Amounts above ${APPROVAL_THRESHOLD} USDC need your approval first;`,
    '- show my **payment history** (`payment_history`).',
    '',
    'Your smart account enforces my daily limit, so even if someone asks me to spend more, the contract will not allow it.',
  ].join('\n'));
}

function explainCode(err) {
  const d = err.details || {};
  switch (err.code) {
    case 'spending_limit_exceeded':
      return `the daily limit is **${d.limit} USDC**, **${d.spent}** is already spent and **${d.remaining} USDC** remains, but **${d.requested}** was requested. The smart account rejects such a signature (\`Error(Contract, #3221)\`).`;
    case 'insufficient_balance':
      return `the agent wallet holds only **${d.balance} USDC**, but **${d.requested}** is needed.`;
    case 'agent_inactive':
      return 'the owner revoked my access (my rule is no longer valid).';
    case 'rejected_by_user':
      return 'you rejected this payment.';
    default:
      return err.message || err.code;
  }
}

async function pay(ctx, conv, u, a, to, amount) {
  let txOk = false;
  const out = await ctx.tool('pay', { to, amount: fmt(amount) }, async (callId) => {
    const e = checkPayment(u, a, to, amount);
    if (e) {
      if (e.error.code !== 'invalid_argument') payRecord(u, a, { to, amount: fmt(amount), status: 'FAILED', error: e.error });
      return { out: e };
    }
    if (amount > APPROVAL_THRESHOLD) {
      const approvalId = `appr_${hex(6)}`;
      let resolve;
      const decision = new Promise((r) => { resolve = r; });
      conv.approvals.set(approvalId, { resolve });
      ctx.send('approval_required', {
        approval_id: approvalId, tool_call_id: callId,
        summary: `${a.name} wants to pay ${fmt(amount)} USDC → ${short(to)}`, to, amount: fmt(amount), asset: 'USDC',
      });
      const timeout = setTimeout(() => resolve(false), 10 * 60 * 1000);
      const poll = setInterval(() => { if (ctx.aborted) resolve(null); }, 100);
      const approved = await decision;
      clearTimeout(timeout); clearInterval(poll);
      conv.approvals.delete(approvalId);
      if (approved === null) throw new Aborted();
      ctx.send('approval_resolved', { approval_id: approvalId, approved });
      if (!approved) return { out: toolErr('rejected_by_user', 'The user rejected the payment') };
      await ctx.sleep(300);
      const again = checkPayment(u, a, to, amount);
      if (again) return { out: again };
    }
    await ctx.sleep(700);
    const p = settle(u, a, to, amount);
    txOk = true;
    return {
      out: toolOk({ hash: p.hash, url: p.url, status: p.status, to, amount: p.amount, asset: 'USDC', ledger: p.ledger }),
      tx: { hash: p.hash, url: p.url, status: 'SUCCESS' },
    };
  });
  if (txOk) {
    const lim = limitInfo(a);
    const left = lim.installed ? `\n- Limit left today: **${lim.remaining} USDC**` : '';
    return ctx.say(`Done: sent **${out.result.amount} USDC** to \`${short(to)}\`.\n\n- Transaction: [${out.result.hash.slice(0, 12)}…](${out.result.url})\n- Agent wallet balance: **${fmt(u.balance)} USDC**${left}`);
  }
  const err = out.error;
  if (err.code === 'spending_limit_exceeded') {
    const d = err.details;
    return ctx.say(`That didn't work: the smart account **rejected** the ${d.requested} USDC payment. My limit is **${d.limit} USDC** per day, ${d.spent} is already spent and **${d.remaining} USDC** remains.\n\nThis check happens in the contract (\`Error(Contract, #3221)\`), and my key cannot bypass it.`);
  }
  if (err.code === 'rejected_by_user') return ctx.say('Got it, the payment is cancelled. The funds stay in the wallet.');
  return ctx.say(`The payment was not sent: ${explainCode(err)}`);
}

async function explainFailure(ctx, u, a) {
  const out = await ctx.tool('payment_history', { limit: 10 }, async () => ({ out: toolOk({ items: historyOf(u, a, 10) }) }));
  const failed = out.result.items.find((p) => p.status === 'FAILED');
  if (!failed) return ctx.say('None of my recent payments were rejected; they all went through.');
  const link = failed.url ? `\n\nThe failed transaction: [${failed.hash.slice(0, 12)}…](${failed.url}).` : '\n\nThe transaction was never submitted: the simulation with signature checks already rejected it.';
  return ctx.say(`The last failed payment: **${failed.amount} USDC** to \`${short(failed.to)}\`.\n\nReason: ${explainCode(failed.error)}${link}\n\nOnly your wallet (rule #0) can change my limit; I cannot.`);
}

async function handleChat(req, res, u) {
  const body = await readBody(req);
  const message = String(body.message || '').trim();
  if (!message) throw new ApiErr(400, 'invalid_argument', '"message" is required');
  if (!body.agent_id) throw new ApiErr(400, 'invalid_argument', '"agent_id" is required');
  const a = findAgent(u, body.agent_id);
  let conv;
  if (body.conversation_id) {
    conv = conversations.get(body.conversation_id);
    if (!conv || conv.owner !== u.address || conv.agent_id !== a.id) throw new ApiErr(404, 'not_found', 'conversation not found');
  } else {
    conv = { id: `conv_${hex(6)}`, owner: u.address, agent_id: a.id, messages: [], approvals: new Map() };
    conversations.set(conv.id, conv);
  }
  if ((u.chatUsed || 0) >= CHAT_DAILY) {
    throw new ApiErr(429, 'daily_limit_reached', `you have used all ${CHAT_DAILY} chat messages for today; they reset at midnight UTC`);
  }
  u.chatUsed = (u.chatUsed || 0) + 1;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const ctx = turnContext(res, conv);
  res.on('close', () => { ctx.aborted = true; });
  conv.messages.push({ role: 'user', content: message });
  try {
    ctx.send('conversation', { id: conv.id });
    if (!LLM) ctx.send('error', { message: 'LLM_API_KEY is not set: the model is unavailable' });
    else { await ctx.sleep(250); await runTurn(ctx, conv, u, a, message); }
    ctx.send('done', { usage: chatUsage(u) });
    res.end();
  } catch (e) {
    if (!(e instanceof Aborted)) {
      console.error('[mock] turn failed:', e);
      try { res.write(`event: error\ndata: ${JSON.stringify({ message: String(e.message || e) })}\n\nevent: done\ndata: {}\n\n`); } catch { /* closed */ }
    }
    res.end();
  }
}

/* ---------------- HTTP ---------------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1 << 20) throw new ApiErr(413, 'too_large', 'body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiErr(400, 'invalid_argument', 'invalid JSON'); }
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(STATIC, '.' + rel);
  if (file !== STATIC && !file.startsWith(STATIC + path.sep)) return json(res, 403, { error: { code: 'forbidden', message: 'forbidden' } });
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function sessionUser(req) {
  const sid = cookie(req, 'aw_session');
  const address = sid && sessions.get(sid);
  if (!address) { stats.unauthorized++; throw new ApiErr(401, 'unauthorized', 'sign in first'); }
  return user(address);
}

async function submitResponse(res, u, op, badSig) {
  await sleep(700);
  if (badSig) return json(res, 200, { ok: false, tx: null, error: { code: 'invalid_signature', message: 'the signature does not verify against your account key (simulation failed)', details: null } });
  try {
    const result = op.apply(u) || {};
    return json(res, 200, { ok: true, tx: result.tx === null ? null : newTx(), result: result.result ?? {} });
  } catch (e) {
    if (e instanceof OpFail) {
      const tx = { ...newTx(), status: 'FAILED' };
      return json(res, 200, { ok: false, tx, error: { code: e.code, message: e.message, details: e.details } });
    }
    throw e;
  }
}

async function route(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  let mm;

  if (p === '/api/config' && m === 'GET') return json(res, 200, configJSON());
  if (p === '/api/_mock/stats' && m === 'GET') return json(res, 200, stats);
  if (p === '/api/models' && m === 'GET') return json(res, 200, { default: DEFAULT_MODEL, items: LLM ? MODELS : [] });

  /* ----- auth ----- */
  if (p === '/api/auth/challenge' && m === 'POST') {
    const body = await readBody(req);
    if (!isG(body.address)) throw new ApiErr(400, 'invalid_argument', '"address" must be a Stellar G… address');
    await sleep(150);
    const op = makeOp(body.address, 'tx', 'Sign in to agentwallet', null, { challenge: true });
    return json(res, 200, op);
  }
  if (p === '/api/auth/login' && m === 'POST') {
    const body = await readBody(req);
    const op = ops.get(body.op_id);
    if (!op || !op.challenge) throw new ApiErr(400, 'invalid_challenge', 'unknown or used challenge');
    const { badSig } = takeOp(body.op_id, op.owner, body, { challenge: true });
    if (badSig) throw new ApiErr(401, 'invalid_signature', 'the challenge signature does not verify');
    const sid = hex(24);
    sessions.set(sid, op.owner);
    user(op.owner);
    return json(res, 200, { address: op.owner }, { 'set-cookie': `aw_session=${sid}; Path=/; HttpOnly; SameSite=Lax` });
  }
  if (p === '/api/auth/logout' && m === 'POST') {
    const sid = cookie(req, 'aw_session');
    if (sid) sessions.delete(sid);
    return json(res, 200, { ok: true }, { 'set-cookie': 'aw_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  }
  if (p === '/api/dev/fund' && m === 'POST') {
    if (!DEV_WALLET) throw new ApiErr(404, 'not_found', 'dev wallet is disabled');
    const body = await readBody(req);
    if (!isG(body.address)) throw new ApiErr(400, 'invalid_argument', '"address" must be a Stellar G… address');
    await sleep(400);
    const u = user(body.address);
    u.wallet.xlm = Math.max(u.wallet.xlm, 10000);
    return json(res, 200, { ok: true, address: body.address, xlm: fmt(u.wallet.xlm) });
  }

  if (!p.startsWith('/api/')) return null;

  /* ----- everything below needs a session ----- */
  const u = sessionUser(req);

  if (p === '/api/me' && m === 'GET') return json(res, 200, meJSON(u));

  if (p === '/api/me/friendbot' && m === 'POST') {
    await sleep(1200); // the real friendbot takes 10-20 s
    u.wallet.xlm = Math.max(u.wallet.xlm, 10000);
    return json(res, 200, { ok: true, wallet: meJSON(u).wallet });
  }

  if (p === '/api/account' && m === 'POST') {
    if (u.deployed) return json(res, 200, { account: u.account, tx: null });
    await sleep(900);
    u.deployed = true;
    return json(res, 200, { account: u.account, tx: newTx() });
  }
  if (p === '/api/account' && m === 'GET') {
    requireDeployed(u);
    return json(res, 200, accountJSON(u));
  }
  if (p === '/api/account/test-usdc/prepare' && m === 'POST') {
    const amount = amountArg((await readBody(req)).amount);
    if (u.wallet.xlm < amount * XLM_PER_USDC + 2) throw new ApiErr(400, 'insufficient_xlm', 'Your wallet needs XLM to buy test USDC. Fund it with friendbot first.', { xlm: fmt(u.wallet.xlm) });
    const summary = `${u.wallet.trustline ? '' : 'Add a USDC trustline and '}${u.wallet.trustline ? 'Buy' : 'buy'} ${fmt(amount)} test USDC for XLM on the testnet DEX`;
    return json(res, 200, makeOp(u.address, 'tx', summary, (uu) => {
      uu.wallet.trustline = true;
      uu.wallet.xlm -= amount * XLM_PER_USDC + 0.5;
      uu.wallet.usdc += amount;
      return { result: { usdc: fmt(uu.wallet.usdc) } };
    }));
  }
  if (p === '/api/account/fund/prepare' && m === 'POST') {
    requireDeployed(u);
    const amount = amountArg((await readBody(req)).amount);
    if (amount > u.wallet.usdc) throw new ApiErr(400, 'insufficient_balance', `Your wallet holds only ${fmt(u.wallet.usdc)} USDC.`, { balance: fmt(u.wallet.usdc), requested: fmt(amount) });
    return json(res, 200, makeOp(u.address, 'tx', `Move ${fmt(amount)} USDC from your wallet to your agent wallet ${short(u.account)}`, (uu) => {
      if (amount > uu.wallet.usdc) throw new OpFail('insufficient_balance', 'Your wallet balance changed and is now too low.');
      uu.wallet.usdc -= amount;
      uu.balance += amount;
      return { result: { balance: fmt(uu.balance) } };
    }));
  }
  if (p === '/api/account/withdraw/prepare' && m === 'POST') {
    requireDeployed(u);
    const amount = amountArg((await readBody(req)).amount);
    if (amount > u.balance) throw new ApiErr(400, 'insufficient_balance', `The agent wallet holds only ${fmt(u.balance)} USDC.`, { balance: fmt(u.balance), requested: fmt(amount) });
    return json(res, 200, makeOp(u.address, 'auth', `Withdraw ${fmt(amount)} USDC from your agent wallet to ${short(u.address)}`, (uu) => {
      if (amount > uu.balance) throw new OpFail('insufficient_balance', 'The agent wallet balance is now too low.');
      uu.balance -= amount;
      uu.wallet.usdc += amount;
      return { result: { balance: fmt(uu.balance) } };
    }));
  }

  if ((mm = /^\/api\/ops\/([^/]+)\/submit$/.exec(p)) && m === 'POST') {
    const body = await readBody(req);
    const { op, badSig } = takeOp(decodeURIComponent(mm[1]), u.address, body);
    return submitResponse(res, u, op, badSig);
  }

  /* ----- agents ----- */
  if (p === '/api/agents' && m === 'GET') return json(res, 200, { items: u.agents.map((a) => agentJSON(u, a)) });
  if (p === '/api/agents/prepare' && m === 'POST') {
    requireDeployed(u);
    const body = await readBody(req);
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 40) throw new ApiErr(400, 'invalid_argument', '"name" must be 1 to 40 characters');
    const limit = amountArg(body.daily_limit, 'daily_limit');
    let days = null;
    if (body.valid_days !== undefined && body.valid_days !== null) {
      days = Number(body.valid_days);
      if (!Number.isInteger(days) || days < 1 || days > 3650) throw new ApiErr(400, 'invalid_argument', '"valid_days" must be an integer from 1 to 3650');
    }
    const a = {
      id: `ag_${hex(5)}`, name, publicKey: randomG(), ruleId: null, pending: true, revoked: false, validUntil: null,
      createdAt: isoNow(), limit: null, history: [], keys: [],
    };
    u.agents.push(a);
    return json(res, 200, makeOp(u.address, 'auth', `Add agent "${name}" (${fmt(limit)} USDC / day)`, (uu) => {
      a.pending = false;
      a.ruleId = uu.nextRule++;
      a.limit = limit;
      a.validUntil = days ? ledger() + days * PERIOD : null;
      const apiKey = newApiKey(uu, a);
      return { result: { agent: agentJSON(uu, a), api_key: apiKey } };
    }));
  }
  if ((mm = /^\/api\/agents\/([^/]+)\/(limit|revoke|restore)\/prepare$/.exec(p)) && m === 'POST') {
    const a = findAgent(u, decodeURIComponent(mm[1]));
    const action = mm[2];
    const body = await readBody(req);
    if (a.pending) throw new ApiErr(409, 'invalid_state', 'the agent is still pending');
    if (action === 'limit') {
      const limit = amountArg(body.daily_limit, 'daily_limit');
      return json(res, 200, makeOp(u.address, 'auth', `Change the limit of "${a.name}" to ${fmt(limit)} USDC / day`, (uu) => {
        a.limit = limit;
        return { result: { agent: agentJSON(uu, a) } };
      }));
    }
    if (action === 'revoke') {
      if (status(a) !== 'active') throw new ApiErr(409, 'invalid_state', `the agent is ${status(a)}`);
      return json(res, 200, makeOp(u.address, 'auth', `Revoke agent "${a.name}" (rule #${a.ruleId})`, (uu) => {
        a.revoked = true;
        a.validUntil = ledger() + 2;
        return { result: { agent: agentJSON(uu, a) } };
      }));
    }
    if (status(a) === 'active') throw new ApiErr(409, 'invalid_state', 'the agent is already active');
    return json(res, 200, makeOp(u.address, 'auth', `Restore agent "${a.name}" (rule #${a.ruleId})`, (uu) => {
      a.revoked = false;
      a.validUntil = null;
      return { result: { agent: agentJSON(uu, a) } };
    }));
  }
  if ((mm = /^\/api\/agents\/([^/]+)\/keys$/.exec(p)) && m === 'POST') {
    const a = findAgent(u, decodeURIComponent(mm[1]));
    if (a.pending) throw new ApiErr(409, 'invalid_state', 'the agent is still pending');
    const key = newApiKey(u, a);
    return json(res, 200, { api_key: key, prefix: key.slice(0, 8) });
  }
  if ((mm = /^\/api\/agents\/([^/]+)\/keys\/([^/]+)$/.exec(p)) && m === 'DELETE') {
    const a = findAgent(u, decodeURIComponent(mm[1]));
    const prefix = decodeURIComponent(mm[2]);
    const i = a.keys.findIndex((k) => k.prefix === prefix);
    if (i < 0) throw new ApiErr(404, 'not_found', 'API key not found');
    apiKeys.delete(a.keys[i].hash);
    a.keys.splice(i, 1);
    return json(res, 200, { ok: true });
  }

  /* ----- payments ----- */
  if (p === '/api/payments' && m === 'GET') {
    const agent = url.searchParams.get('agent');
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
    const items = u.payments.filter((x) => !agent || x.agent_id === agent).slice(0, limit);
    return json(res, 200, { items });
  }

  /* ----- chat ----- */
  if (p === '/api/chat' && m === 'POST') return handleChat(req, res, u);
  if ((mm = /^\/api\/chat\/([^/]+)\/approvals\/([^/]+)$/.exec(p)) && m === 'POST') {
    const conv = conversations.get(decodeURIComponent(mm[1]));
    if (!conv || conv.owner !== u.address) throw new ApiErr(404, 'not_found', 'conversation not found');
    const ap = conv.approvals.get(decodeURIComponent(mm[2]));
    if (!ap) throw new ApiErr(404, 'not_found', 'approval not found or already resolved');
    const body = await readBody(req);
    if (typeof body.approve !== 'boolean') throw new ApiErr(400, 'invalid_argument', '"approve" must be a boolean');
    ap.resolve(body.approve);
    return json(res, 200, { ok: true });
  }
  if ((mm = /^\/api\/conversations\/([^/]+)$/.exec(p)) && m === 'GET') {
    const conv = conversations.get(decodeURIComponent(mm[1]));
    if (!conv || conv.owner !== u.address) throw new ApiErr(404, 'not_found', 'conversation not found');
    return json(res, 200, { id: conv.id, agent_id: conv.agent_id, messages: conv.messages });
  }

  throw new ApiErr(404, 'not_found', `no route ${m} ${p}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  stats.requests++;
  try {
    if (p.startsWith('/api/') && req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-agentwallet'] !== '1') {
      stats.csrf_rejections++;
      console.error(`[mock] 403 csrf: ${req.method} ${p} without X-Agentwallet: 1`);
      return json(res, 403, { error: { code: 'csrf', message: 'missing X-Agentwallet: 1 header' } });
    }
    if (p === '/mcp') {
      const auth = String(req.headers.authorization || '');
      const key = /^Bearer (awk_[0-9a-f]+)$/.exec(auth);
      const owner = key && apiKeys.get(createHash('sha256').update(key[1]).digest('hex'));
      if (!owner) return json(res, 401, { error: { code: 'unauthorized', message: 'Authorization: Bearer awk_… required' } });
      return json(res, 501, { error: { code: 'not_implemented', message: 'MCP is not mocked; the key is valid. Run the real agentwallet.' } });
    }
    const handled = await route(req, res, url);
    if (handled === null) {
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
      return json(res, 405, { error: { code: 'method_not_allowed', message: 'method not allowed' } });
    }
  } catch (e) {
    if (e instanceof ApiErr) {
      if (!res.headersSent) return json(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
      return res.end();
    }
    console.error('[mock]', e);
    if (!res.headersSent) json(res, 500, { error: { code: 'internal', message: String(e.message || e) } });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`agentwallet mock listening on http://${HOST}:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
