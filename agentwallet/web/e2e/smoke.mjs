// Headless-Chromium smoke test for the multi-tenant agentwallet UI against mock.mjs.
//
//   bash run-e2e.sh                 # installs deps, prepares Chromium, runs this
//   node smoke.mjs                  # if env (.pw/env.sh) is already sourced
//
// Starts two mocks on random ports (one normal with MOCK_VERIFY=1, so the dev
// wallet's ed25519 signatures are really verified; one with MOCK_LLM=0),
// drives the UI with playwright-core and saves screenshots to e2e/shots/.
// Exit code 1 if any step fails.

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');
mkdirSync(SHOTS, { recursive: true });
const PAYEE = 'GB3WNAVXMVP6TDJ6CN3TVD5GO5LDZA52U7G44X76UQR7JAKXE6DAEBN6';
const T = 10_000;
const G_RE = /^G[A-Z2-7]{55}$/;

/* ---------- harness ---------- */

const results = [];
let currentPage = null;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ ok: true, name });
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ ok: false, name, err: e });
    console.log(`FAIL  ${name}\n      ${String(e.message || e).split('\n').slice(0, 4).join('\n      ')}`);
    if (currentPage) await currentPage.screenshot({ path: path.join(SHOTS, `FAIL-${results.length}.png`) }).catch(() => {});
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

function startMock(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(HERE, 'mock.mjs')], {
      env: { ...process.env, PORT: '0', MOCK_SPEED: '0.35', ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const timer = setTimeout(() => reject(new Error('mock did not start')), 5000);
    p.stdout.on('data', (d) => {
      const m = /listening on (http:\/\/\S+)/.exec(String(d));
      if (m) { clearTimeout(timer); resolve({ proc: p, url: m[1] }); }
    });
    p.on('exit', (c) => reject(new Error(`mock exited with ${c}`)));
  });
}

function watchConsole(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location() || {};
    errors.push(`${m.text()} @ ${loc.url || '?'}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function overflowX(page) {
  return page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
}
async function noOverflow(page, where) {
  const o = await overflowX(page);
  assert(o.sw <= o.cw, `${where}: scrollWidth ${o.sw} > clientWidth ${o.cw}`);
  const wide = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter((el) => {
      if (!el.getClientRects().length) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return false;
      // ignore content inside horizontally scrollable boxes (code blocks, tab strip)
      for (let p = el.parentElement; p; p = p.parentElement) { const ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return false; }
      return r.right > window.innerWidth + 0.5;
    })
    .slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${el.className}`));
  eq(wide.length, 0, `${where}: elements past the right edge: ${wide.join(', ')}`);
}

const view = (page, name) => page.locator(`#view-${name}`).waitFor({ state: 'visible', timeout: T });
const text = async (loc) => ((await loc.textContent()) || '').replace(/\s+/g, ' ').trim();

async function sendText(page, t) {
  const ta = page.locator('#composer-input');
  await ta.fill(t);
  await ta.press('Enter');
}
const idle = (page) => page.locator('#send-btn').waitFor({ state: 'visible', timeout: T });

/** Waits for the op modal to finish successfully; returns the tx href. */
async function opDone(page) {
  const op = page.locator('#modal [data-testid=op]');
  await op.waitFor({ timeout: T });
  await page.waitForFunction(() => ['done', 'failed', 'rejected'].includes(document.querySelector('#modal [data-testid=op]')?.dataset.state), null, { timeout: T });
  const st = await op.getAttribute('data-state');
  if (st !== 'done') throw new Error(`op ended in state ${st}: ${await text(page.locator('#modal [data-testid=op-result]'))}`);
  const href = await page.locator('#modal [data-testid=op-tx] a.tx-link').first().getAttribute('href');
  assert(/^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/.test(href || ''), `tx href ${href}`);
  return href;
}
/** Waits until prepare has returned and the op summary is shown; returns its text. */
async function opSummary(page) {
  const el = page.locator('#modal [data-testid=op-summary]');
  await el.waitFor({ state: 'visible', timeout: T });
  return text(el);
}
async function closeModal(page) {
  const done = page.locator('#modal [data-testid=op-close], #modal [data-testid=key-done]');
  if (await done.count()) await done.first().click();
  else await page.locator('#modal-close').click();
  await page.waitForFunction(() => !document.getElementById('modal').open, null, { timeout: T });
}

async function signInWithTestKey(page) {
  await page.locator('[data-testid=use-test-key]').click();
  await page.waitForFunction(() => ['onboarding', 'dashboard'].includes(document.body.dataset.view), null, { timeout: T });
}

async function onboard(page, { fund = '8' } = {}) {
  await view(page, 'onboarding');
  await page.locator('[data-testid=create-account]').click();
  await page.locator('[data-testid=step-1][data-state=done]').waitFor({ timeout: T });
  await page.locator('[data-testid=get-test-usdc]').click();
  await opDone(page);
  await closeModal(page);
  await page.waitForFunction(() => document.querySelector('[data-testid=wallet-usdc]')?.textContent === '10', null, { timeout: T });
  await page.locator('[data-testid=fund-amount]').fill(fund);
  await page.locator('[data-testid=fund-account]').click();
  await opDone(page);
  await closeModal(page);
  await page.waitForFunction((v) => document.querySelector('[data-testid=account-usdc-onb]')?.textContent === v, fund, { timeout: T });
}

async function addAgent(page, name, limit, days = '') {
  await page.locator('#agent-name').fill(name);
  await page.locator('#agent-limit').fill(limit);
  await page.locator('#agent-days').fill(days);
  await page.locator('#add-agent-form button[type=submit]').click();
  await opDone(page);
  await page.locator('#modal [data-testid=api-key]').waitFor({ timeout: T });
  return (await page.locator('#modal [data-testid=api-key]').textContent()).trim();
}

const agentCard = (page, name) => page.locator('[data-testid=agent-card]', { has: page.locator('[data-testid=agent-name]', { hasText: name }) });

async function mockStats(base) {
  return (await fetch(`${base}/api/_mock/stats`)).json();
}

/* ---------- run ---------- */

// Unit check of the StrKey encoder in Node, before any browser work.
const strkey = await import(pathToFileURL(path.join(HERE, '../static/js/strkey.js')).href);
await step('StrKey encoder: known vectors, round trip, checksum', async () => {
  eq(strkey.encodePublicKey(new Uint8Array(32)), 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', 'all-zero pubkey');
  eq(strkey.encodePublicKey(Uint8Array.from({ length: 32 }, (_, i) => i)), 'GAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB7JZX', 'bytes 0..31 (stellar-sdk)');
  const pub = Uint8Array.from(Buffer.from('361e7a0157ae247931b9a92728dd3198c5207a3d392719b12214a2743a78a9bf', 'hex'));
  eq(strkey.encodePublicKey(pub), 'GA3B46QBK6XCI6JRXGUSOKG5GGMMKID2HU4SOGNREIKKE5B2PCU36IET', 'known key pair (stellar-sdk)');
  eq(Buffer.from(strkey.decodePublicKey('GA3B46QBK6XCI6JRXGUSOKG5GGMMKID2HU4SOGNREIKKE5B2PCU36IET')).toString('hex'), Buffer.from(pub).toString('hex'), 'decode');
  eq(strkey.encodeContract(new Uint8Array(32)), 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4', 'all-zero contract');
  eq(strkey.crc16xmodem(new TextEncoder().encode('123456789')), 0x31c3, 'CRC16-XModem check value');
  assert(!strkey.isPublicKey('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHG'), 'bad checksum rejected');
  assert(!strkey.isPublicKey('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'), 'C address is not a G key');
  for (let i = 0; i < 50; i++) {
    const b = crypto.getRandomValues(new Uint8Array(32));
    const g = strkey.encodePublicKey(b);
    assert(G_RE.test(g), `shape ${g}`);
    eq(Buffer.from(strkey.decodePublicKey(g)).toString('hex'), Buffer.from(b).toString('hex'), 'random round trip');
  }
});

const main = await startMock({ MOCK_VERIFY: '1' });
const noLLM = await startMock({ MOCK_LLM: '0', MOCK_VERIFY: '1' });
const base = main.url;
console.log(`mock: ${base} (MOCK_VERIFY=1), ${noLLM.url} (MOCK_LLM=0)`);

await step('every non-GET /api request needs X-Agentwallet: 1 (403 without it)', async () => {
  const r = await fetch(`${base}/api/auth/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: PAYEE }) });
  eq(r.status, 403, 'status without header');
  eq((await r.json()).error.code, 'csrf', 'error code');
  const r2 = await fetch(`${base}/api/me`);
  eq(r2.status, 401, '🔒 endpoint without a session');
});
const csrfBaseline = (await mockStats(base)).csrf_rejections;

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
console.log(`chromium ${browser.version()}`);

try {
  /* ===== desktop, dev wallet ===== */
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 }, colorScheme: 'light' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await ctx.newPage();
  currentPage = page;
  const errors = watchConsole(page);
  let agentId = null;
  let userAddress = null;

  await step('signed out: landing pitch, Connect Freighter + Use test key, StrKey in the browser', async () => {
    await page.goto(base + '/', { waitUntil: 'load' });
    await view(page, 'landing');
    eq(await text(page.locator('.hero-title')), 'A spending limit built like hardware.', 'pitch');
    assert(await page.locator('[data-testid=connect-freighter]').isVisible(), 'Connect Freighter visible');
    assert(await page.locator('[data-testid=use-test-key]').isVisible(), 'Use test key visible (dev_wallet: true)');
    assert((await text(page.locator('#test-key-note'))).includes('Test key'), 'test key labelled');
    eq(await page.evaluate(() => document.documentElement.lang), 'en', 'html lang');
    eq((await page.locator('.tabs .tab').allTextContents()).join('|'), 'Home|How it works', 'signed-out tabs');
    assert(await page.locator('#user-area').isHidden(), 'no user chip');
    const browserKey = await page.evaluate(async () => (await import('./js/strkey.js')).encodePublicKey(new Uint8Array(32)));
    eq(browserKey, 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', 'browser StrKey');
    await page.screenshot({ path: path.join(SHOTS, 'desktop-landing.png') });
  });

  await step('Connect Freighter without the extension -> clear "not installed" message', async () => {
    await page.locator('[data-testid=connect-freighter]').click();
    const msg = page.locator('[data-testid=login-message][data-reason=not_installed]');
    await msg.waitFor({ timeout: 5000 });
    assert((await text(msg)).includes('Freighter is not installed'), 'message text');
    assert(await msg.locator('a[href="https://www.freighter.app/"]').count() === 1, 'install link');
    await page.screenshot({ path: path.join(SHOTS, 'desktop-no-freighter.png') });
  });

  await step('1. sign in with the test key (WebCrypto ed25519, friendbot, SEP-10 signature verified by the mock)', async () => {
    await signInWithTestKey(page);
    await view(page, 'onboarding');
    const chip = await text(page.locator('[data-testid=user-chip]'));
    assert(chip.includes('Test key'), `chip labelled: ${chip}`);
    const key = await page.evaluate(() => JSON.parse(sessionStorage.getItem('aw.devKey')));
    assert(key && G_RE.test(key.address) && strkey.isPublicKey(key.address), `dev key address ${key && key.address}`);
    userAddress = key.address;
    eq(Buffer.from(strkey.decodePublicKey(key.address)).toString('base64'), key.pub, 'address encodes the WebCrypto public key');
    eq(JSON.parse(await page.evaluate(() => localStorage.getItem('aw.session'))).signer, 'dev', 'session hint');
    const cookies = await ctx.cookies(base);
    const c = cookies.find((x) => x.name === 'aw_session');
    assert(c && c.httpOnly, 'HttpOnly aw_session cookie');
    eq((await page.locator('.tabs .tab').allTextContents()).join('|'), 'Get started|How it works', 'onboarding tabs');
    await page.screenshot({ path: path.join(SHOTS, 'desktop-onboarding.png') });
  });

  await step('2. create the account (POST /api/account, no signature)', async () => {
    await page.locator('[data-testid=create-account]').click();
    await page.locator('[data-testid=step-1][data-state=done]').waitFor({ timeout: T });
    const addr = await page.locator('[data-testid=step-1] [data-testid=account-address]').getAttribute('title');
    assert(/^C[A-Z2-7]{55}$/.test(addr || ''), `account address ${addr}`);
    assert(await page.locator('[data-testid=step-2][data-state=active]').count() === 1, 'funding step active');
    eq(await page.locator('[data-testid=wallet-xlm]').textContent(), '10,000', 'friendbot XLM shown');
  });

  await step('3. get 10 test USDC (tx op) and fund the agent wallet with 8 (tx op)', async () => {
    await page.locator('[data-testid=get-test-usdc]').click();
    assert((await opSummary(page)).includes('10 test USDC'), 'op summary shown');
    await opDone(page);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-op-done.png') });
    await closeModal(page);
    await page.waitForFunction(() => document.querySelector('[data-testid=wallet-usdc]')?.textContent === '10', null, { timeout: T });
    await page.locator('[data-testid=fund-amount]').fill('8');
    await page.locator('[data-testid=fund-account]').click();
    await opDone(page);
    await closeModal(page);
    await page.waitForFunction(() => document.querySelector('[data-testid=account-usdc-onb]')?.textContent === '8', null, { timeout: T });
    eq(await page.locator('[data-testid=wallet-usdc]').textContent(), '2', 'wallet USDC after funding');
    await page.locator('[data-testid=onboarding-done]').click();
    await view(page, 'dashboard');
    eq(await page.locator('[data-testid=account-balance]').textContent(), '8', 'dashboard balance');
    eq((await page.locator('.tabs .tab').allTextContents()).join('|'), 'Dashboard|Chat|How it works', 'signed-in tabs');
    assert(await page.locator('[data-testid=no-agents]').isVisible(), 'empty agents state');
  });

  let firstKey;
  await step('4. add an agent (auth op) -> API key shown once with copy + MCP snippets', async () => {
    firstKey = await addAgent(page, 'Shopping bot', '5');
    assert(/^awk_[0-9a-f]{48}$/.test(firstKey), `api key ${firstKey}`);
    eq(await text(page.locator('#modal-title')), 'Agent added', 'modal title');
    eq(await text(page.locator('#modal [data-testid=mcp-cli] code')),
      `claude mcp add --transport http shopping-bot ${base}/mcp --header "Authorization: Bearer ${firstKey}"`, 'claude mcp add command');
    await page.locator('#modal .key-json summary').click();
    const cfg = JSON.parse(await page.locator('#modal [data-testid=mcp-json] code').textContent());
    eq(cfg.mcpServers['shopping-bot'].url, `${base}/mcp`, '.mcp.json url');
    eq(cfg.mcpServers['shopping-bot'].headers.Authorization, `Bearer ${firstKey}`, '.mcp.json header');
    await page.locator('#modal [data-testid=copy-key]').click();
    await page.locator('#toast', { hasText: 'Copied' }).waitFor({ timeout: T });
    eq(await page.evaluate(() => navigator.clipboard.readText()), firstKey, 'clipboard has the key');
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${firstKey}`, 'X-Agentwallet': '1' } });
    eq(mcp.status, 501, 'the key is accepted by /mcp (mock answers 501 not_implemented)');
    await page.screenshot({ path: path.join(SHOTS, 'desktop-api-key.png') });
    await closeModal(page);
    const card = agentCard(page, 'Shopping bot');
    await card.waitFor({ timeout: T });
    eq(await card.locator('[data-testid=agent-status]').getAttribute('data-status'), 'active', 'status');
    eq(await text(card.locator('[data-testid=limit-nums]')), '0 / 5 USDC', 'limit gauge');
    agentId = await card.getAttribute('data-agent-id');
    assert(/^ag_/.test(agentId || ''), `agent id ${agentId}`);
    eq(await page.locator('#modal-body').evaluate((el) => el.children.length), 0, 'modal content dropped after close (key not kept in the DOM)');
    await page.screenshot({ path: path.join(SHOTS, 'desktop-dashboard.png') });
  });

  await step('5a. chat: agent picker, "How much" -> wallet_info, "Pay 1" -> tx, panel balance 7', async () => {
    await agentCard(page, 'Shopping bot').locator('[data-testid=agent-chat]').click();
    await view(page, 'chat');
    eq(await page.locator('#agent-select').inputValue(), agentId, 'agent selected');
    eq(await text(page.locator('#empty-title')), 'Chat with Shopping bot', 'empty title');
    await page.waitForFunction(() => document.querySelectorAll('#model-select option').length > 1, null, { timeout: T });
    const chips = await page.locator('#chips .chip').allTextContents();
    eq(chips.length, 6, 'chip count');
    await page.locator('#chips .chip', { hasText: 'How much money do I have?' }).click();
    await page.locator('.tool-card[data-tool=wallet_info][data-status=ok]').waitFor({ timeout: T });
    await idle(page);
    await page.locator('#suggest .chip').first().waitFor({ timeout: T }); // suggested next messages after a turn
    assert(!(await page.locator('#suggest .chip', { hasText: 'How much money do I have?' }).count()), 'the message just sent is not suggested again');
    assert((await text(page.locator('.tool-card[data-tool=wallet_info] .tool-summary'))).includes('Balance 8 USDC'), 'wallet_info summary');
    await sendText(page, `Pay 1 USDC to ${PAYEE}`);
    await page.locator('.tool-card[data-tool=pay][data-status=ok]').waitFor({ timeout: T });
    const tx = page.locator('[data-testid=tx]').last();
    await tx.waitFor({ timeout: T });
    assert(/^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/.test(await tx.locator('a.tx-link').getAttribute('href')), 'tx link');
    await idle(page);
    await page.waitForFunction(() => document.querySelector('#agent-panel [data-testid=balance]')?.textContent === '7', null, { timeout: T });
    await page.locator('#agent-panel [data-testid=panel-payments] li').first().waitFor({ timeout: T });
    const conv = await page.evaluate((id) => localStorage.getItem(`aw.conv.${id}`), agentId);
    assert(/^conv_/.test(conv || ''), `conversation id kept per agent: ${conv}`);
    const quota = await text(page.locator('[data-testid=chat-quota]'));
    assert(/^\d+ of 50 messages left today$/.test(quota), `chat quota line: ${quota}`);
    eq(await page.locator('#composer-input').getAttribute('maxlength'), '4000', 'composer maxlength from config');
  });

  await step('5b. chat: "Pay 10" -> red spending_limit_exceeded card', async () => {
    await sendText(page, `Pay 10 USDC to ${PAYEE}`);
    const err = page.locator('.err-card[data-code=spending_limit_exceeded]').last();
    await err.waitFor({ timeout: T });
    eq(await text(err.locator('[data-testid=limit-line]')), 'Limit 5 USDC/day, spent 1, remaining 4, resets in ~1 day', 'limit line');
    eq(await text(err.locator('.err-title-text')), 'Payment rejected by the smart account', 'headline');
    await idle(page);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-chat.png') });
  });

  await step('5c. chat: approval flow (Reject, then Approve) + stop + reload restores history', async () => {
    await sendText(page, `Pay 3 USDC to ${PAYEE}`);
    await page.locator('[data-testid=approval][data-state=pending]').waitFor({ timeout: T });
    eq(await page.locator('.tool-card[data-tool=pay]').last().getAttribute('data-status'), 'waiting', 'card waits');
    assert(await page.locator('[data-testid=approval-bar]').isVisible(), 'approval bar pinned above the composer');
    assert((await page.title()).startsWith('Approval needed'), 'tab title flags the approval');
    assert(await page.locator('#suggest').isHidden(), 'no suggestions while the agent waits');
    await page.locator('.approval button', { hasText: 'Reject' }).last().click();
    await page.locator('[data-testid=approval][data-state=rejected]').waitFor({ timeout: T });
    assert(await page.locator('[data-testid=approval-bar]').isHidden(), 'approval bar gone after the decision');
    await page.locator('.err-card[data-code=rejected_by_user]').waitFor({ timeout: T });
    await idle(page);
    await sendText(page, `Pay 3 USDC to ${PAYEE}`);
    await page.locator('[data-testid=approval][data-state=pending]').waitFor({ timeout: T });
    await page.screenshot({ path: path.join(SHOTS, 'desktop-approval.png') });
    await page.locator('[data-testid=approval-bar-approve]').click(); // approve from the pinned bar
    await page.locator('[data-testid=approval][data-state=approved]').waitFor({ timeout: T });
    await page.locator('.tool-card[data-tool=pay][data-status=ok]').nth(1).waitFor({ timeout: T });
    await idle(page);
    await page.waitForFunction(() => document.querySelector('#agent-panel [data-testid=balance]')?.textContent === '4', null, { timeout: T });
    await page.waitForFunction(() => document.querySelector('#agent-panel [data-testid=remaining]')?.textContent === '1 USDC', null, { timeout: T });

    await sendText(page, 'Hi! What can you do?');
    await page.locator('.md.streaming').waitFor({ timeout: T });
    await page.locator('#stop-btn').click();
    await page.locator('.turn-note.stopped').waitFor({ timeout: T });
    await idle(page);

    const users = await page.locator('.msg-user').count();
    await page.reload();
    await view(page, 'chat');
    await page.locator('.tool-card[data-tool=pay][data-status=ok]').first().waitFor({ timeout: T });
    eq(await page.locator('.msg-user').count(), users, 'user messages restored');
    assert(await page.locator('.err-card[data-code=spending_limit_exceeded]').count() >= 1, 'limit card restored');
    assert(await page.locator('[data-testid=tx]').count() >= 2, 'tx cards restored');
  });

  await step('6. revoke (auth op) -> revoked badge; chat pay -> agent_inactive; restore -> active', async () => {
    await page.locator('#tab-dashboard').click();
    await view(page, 'dashboard');
    const card = agentCard(page, 'Shopping bot');
    await card.locator('[data-testid=agent-revoke]').click();
    assert((await opSummary(page)).includes('Revoke agent "Shopping bot"'), 'revoke summary');
    await opDone(page);
    await closeModal(page);
    await page.waitForFunction(() => document.querySelector('[data-testid=agent-card] [data-testid=agent-status]')?.dataset.status === 'revoked', null, { timeout: T });
    assert(await card.locator('[data-testid=agent-restore]').isVisible(), 'Restore button');
    await page.screenshot({ path: path.join(SHOTS, 'desktop-revoked.png') });
    await card.locator('[data-testid=agent-chat]').click();
    await view(page, 'chat');
    assert(await page.locator('#agent-inactive-notice').isVisible(), 'inactive notice in chat');
    assert((await page.locator('#agent-select option').first().textContent()).includes('(revoked)'), 'picker shows status');
    await sendText(page, `Pay 1 USDC to ${PAYEE}`);
    await page.locator('.err-card[data-code=agent_inactive]').waitFor({ timeout: T });
    await idle(page);
    await page.locator('#tab-dashboard').click();
    await view(page, 'dashboard');
    await card.locator('[data-testid=agent-restore]').click();
    await opDone(page);
    await closeModal(page);
    await page.waitForFunction(() => document.querySelector('[data-testid=agent-card] [data-testid=agent-status]')?.dataset.status === 'active', null, { timeout: T });
  });

  await step('change limit (auth op) -> gauge shows the new limit', async () => {
    const card = agentCard(page, 'Shopping bot');
    await card.locator('[data-testid=agent-limit]').click();
    const form = page.locator('#modal [data-testid=limit-form]');
    await form.waitFor({ timeout: T });
    eq(await form.locator('input').inputValue(), '5', 'prefilled with the current limit');
    await form.locator('input').fill('6');
    await form.locator('button[type=submit]').click();
    await opDone(page);
    await closeModal(page);
    await page.waitForFunction(() => document.querySelector('[data-testid=agent-card] [data-testid=limit-nums]')?.textContent.includes('/ 6 USDC'), null, { timeout: T });
    eq(await card.locator('[data-testid=remaining]').textContent(), '2 USDC', 'remaining after the new limit');
  });

  await step('7. API keys: list prefixes, create (shown once), revoke', async () => {
    const card = agentCard(page, 'Shopping bot');
    await card.locator('[data-testid=agent-keys]').click();
    await card.locator('[data-testid=keys-panel]').waitFor({ timeout: T });
    eq(await card.locator('[data-testid=key-item]').count(), 1, 'one key');
    eq(await card.locator('[data-testid=key-item]').first().getAttribute('data-prefix'), firstKey.slice(0, 8), 'prefix listed');
    await card.locator('[data-testid=key-create]').click();
    await page.locator('#modal [data-testid=api-key]').waitFor({ timeout: T });
    const second = (await page.locator('#modal [data-testid=api-key]').textContent()).trim();
    assert(/^awk_[0-9a-f]{48}$/.test(second) && second !== firstKey, 'new key');
    await closeModal(page);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=agent-card] [data-testid=key-item]').length === 2, null, { timeout: T });
    await card.locator(`[data-testid=key-item][data-prefix="${firstKey.slice(0, 8)}"] [data-testid=key-revoke]`).click();
    await page.locator('#modal [data-testid=key-revoke-confirm]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=agent-card] [data-testid=key-item]').length === 1, null, { timeout: T });
    eq(await card.locator('[data-testid=key-item]').first().getAttribute('data-prefix'), second.slice(0, 8), 'the new key remains');
    const old = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${firstKey}`, 'X-Agentwallet': '1' } });
    eq(old.status, 401, 'revoked key rejected by /mcp');
  });

  await step('second agent with valid days; payments filter by agent', async () => {
    await addAgent(page, 'Research bot', '2', '7');
    await closeModal(page);
    const card = agentCard(page, 'Research bot');
    await card.waitFor({ timeout: T });
    assert((await text(card.locator('.agent-meta'))).includes('valid until ledger'), 'valid_until shown');
    const all = await page.locator('#payments-list [data-testid=payment]').count();
    assert(all >= 4, `all payments listed (${all})`);
    const research = await card.getAttribute('data-agent-id');
    await page.locator('#payments-filter').selectOption(research);
    await page.locator('[data-testid=no-payments]').waitFor({ timeout: T });
    await page.locator('#payments-filter').selectOption(agentId);
    await page.waitForFunction((id) => {
      const items = [...document.querySelectorAll('#payments-list [data-testid=payment]')];
      return items.length > 0 && items.every((li) => li.dataset.agent === id);
    }, agentId, { timeout: T });
    await page.locator('#payments-filter').selectOption('');
  });

  await step('8. withdraw (auth op) -> balances move back to the wallet', async () => {
    await page.locator('[data-testid=withdraw]').click();
    const form = page.locator('#modal [data-testid=withdraw-form]');
    await form.waitFor({ timeout: T });
    await form.locator('input').fill('2');
    await form.locator('button[type=submit]').click();
    assert((await opSummary(page)).includes('Withdraw 2 USDC'), 'withdraw summary');
    await opDone(page);
    await closeModal(page);
    await page.waitForFunction(() => document.querySelector('[data-testid=account-balance]')?.textContent === '2', null, { timeout: T });
    eq(await page.locator('[data-testid=wallet-usdc-dash]').textContent(), '4', 'wallet USDC');
  });

  await step('withdrawing more than the balance is caught before anything is signed', async () => {
    await page.locator('[data-testid=withdraw]').click();
    const form = page.locator('#modal [data-testid=withdraw-form]');
    await form.locator('input').fill('50');
    await form.locator('button[type=submit]').click();
    assert((await text(form.locator('.field-err'))).includes('more than the available'), 'client-side check');
    await page.locator('#modal-close').click();
  });

  await step('theme: dark dashboard, chat and how-it-works screenshots', async () => {
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const light = await bg();
    await page.locator('#theme-toggle').click();
    eq(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'data-theme');
    assert(light !== await bg(), 'background changes');
    await page.waitForTimeout(250); // let the .15 s key transitions settle before the screenshot
    await page.screenshot({ path: path.join(SHOTS, 'desktop-dashboard-dark.png') });
    await page.locator('#tab-chat').click();
    await view(page, 'chat');
    await page.locator('.tool-card').first().waitFor({ timeout: T });
    eq(await page.locator('.tabs .tab.active').getAttribute('data-tab'), 'chat', 'active tab');
    await page.waitForTimeout(250); // let the .15 s tab/theme transitions settle before the screenshot
    await page.screenshot({ path: path.join(SHOTS, 'desktop-chat-dark.png') });
    await page.locator('#tab-how').click();
    await view(page, 'how');
    eq(await page.locator('svg.diagram .dg-node').count(), 7, 'diagram nodes');
    const how = await text(page.locator('.how-points'));
    for (const s of ['Delegated', 'never holds the owner key', 'encrypted at rest', 'stored hashed', 'Each agent is a rule']) assert(how.includes(s), `how-it-works mentions "${s}"`);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-how-dark.png') });
    await page.locator('#theme-toggle').click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-how.png') });
    await page.locator('#tab-dashboard').click();
    await view(page, 'dashboard');
  });

  await step('9. logout -> signed-out screen, cookie cleared; signing in again reuses the test key', async () => {
    await page.locator('[data-testid=logout]').click();
    await view(page, 'landing');
    assert(await page.locator('#user-area').isHidden(), 'user chip hidden');
    eq(await page.evaluate(() => localStorage.getItem('aw.session')), null, 'session hint cleared');
    assert(!(await ctx.cookies(base)).some((c) => c.name === 'aw_session' && c.value), 'aw_session cookie cleared');
    assert((await text(page.locator('#test-key-existing'))).includes('will be reused'), 'existing test key offered');
    await page.waitForTimeout(300);
    await signInWithTestKey(page);
    await view(page, 'dashboard');
    eq(await page.locator('[data-testid=agent-card]').count(), 2, 'agents kept for the same user');
    eq((await page.locator('[data-testid=user-chip] code').getAttribute('title')) ?? (await page.locator('[data-testid=user-chip]').getAttribute('title')), userAddress, 'same address');
    await page.locator('[data-testid=logout]').click();
    await view(page, 'landing');
  });

  await step('11. 0 console errors on desktop; mock saw no CSRF or signature failures', async () => {
    eq(errors.length, 0, `console errors: ${errors.join(' | ')}`);
    const s = await mockStats(base);
    eq(s.csrf_rejections - csrfBaseline, 0, 'requests without X-Agentwallet');
    eq(s.bad_signatures, 0, 'dev wallet signatures that failed ed25519 verification');
  });
  await ctx.close();

  /* ===== mobile 390px ===== */
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mpage = await mctx.newPage();
  currentPage = mpage;
  const merrors = watchConsole(mpage);
  await step('10. mobile 390px: no horizontal overflow on landing, onboarding, dashboard, modal, chat, how', async () => {
    await mpage.goto(base + '/');
    await view(mpage, 'landing');
    await noOverflow(mpage, 'landing');
    await mpage.screenshot({ path: path.join(SHOTS, 'mobile-landing.png'), fullPage: true });
    await signInWithTestKey(mpage);
    await view(mpage, 'onboarding');
    await noOverflow(mpage, 'onboarding');
    await mpage.locator('[data-testid=create-account]').tap();
    await mpage.locator('[data-testid=step-1][data-state=done]').waitFor({ timeout: T });
    await noOverflow(mpage, 'onboarding funding');
    await mpage.screenshot({ path: path.join(SHOTS, 'mobile-onboarding.png'), fullPage: true });
    await mpage.locator('[data-testid=get-test-usdc]').tap();
    await opDone(mpage);
    await noOverflow(mpage, 'op modal');
    await mpage.screenshot({ path: path.join(SHOTS, 'mobile-op.png') });
    await closeModal(mpage);
    await mpage.waitForFunction(() => document.querySelector('[data-testid=wallet-usdc]')?.textContent === '10', null, { timeout: T });
    await mpage.locator('[data-testid=fund-amount]').fill('6');
    await mpage.locator('[data-testid=fund-account]').tap();
    await opDone(mpage);
    await closeModal(mpage);
    await mpage.locator('[data-testid=onboarding-done]').tap();
    await view(mpage, 'dashboard');
    await addAgent(mpage, 'Phone bot with a fairly long name', '5', '30');
    await noOverflow(mpage, 'API key modal');
    await mpage.screenshot({ path: path.join(SHOTS, 'mobile-api-key.png') });
    await closeModal(mpage);
    const card = agentCard(mpage, 'Phone bot');
    await card.locator('[data-testid=agent-keys]').tap();
    await noOverflow(mpage, 'dashboard');
    await mpage.screenshot({ path: path.join(SHOTS, 'mobile-dashboard.png'), fullPage: true });
    await card.locator('[data-testid=agent-chat]').tap();
    await view(mpage, 'chat');
    await mpage.locator('#chips .chip', { hasText: 'Pay 10 USDC' }).tap();
    await mpage.locator('.err-card').last().waitFor({ timeout: T });
    await idle(mpage);
    await mpage.locator('.tool-card summary', { hasText: 'Arguments' }).first().tap();
    await mpage.locator('.tool-card summary', { hasText: 'Error' }).first().tap();
    await noOverflow(mpage, 'chat with cards');
    await mpage.screenshot({ path: path.join(SHOTS, 'mobile-chat.png') });
    await mpage.screenshot({ path: path.join(SHOTS, 'mobile-chat-full.png'), fullPage: true });
    await mpage.locator('#tab-how').tap();
    await view(mpage, 'how');
    await noOverflow(mpage, 'how');
    await mpage.screenshot({ path: path.join(SHOTS, 'mobile-how.png'), fullPage: true });
    eq(merrors.length, 0, `console errors: ${merrors.join(' | ')}`);
  });
  await mctx.close();

  /* ===== simulated Freighter extension ===== */
  // A stand-in for the extension's content script: it answers the
  // FREIGHTER_EXTERNAL_MSG_REQUEST postMessages exactly as Freighter does.
  const FREIGHTER_ADDR = 'GAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB7JZX';
  const fctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await fctx.addInitScript((addr) => {
    const fk = window.__fk = { net: 'PUBLIC', reject: false, log: [], address: addr };
    const NETS = {
      PUBLIC: { network: 'PUBLIC', networkName: 'Main Net', networkUrl: 'https://horizon.stellar.org', networkPassphrase: 'Public Global Stellar Network ; September 2015' },
      TESTNET: { network: 'TESTNET', networkName: 'Test Net', networkUrl: 'https://horizon-testnet.stellar.org', networkPassphrase: 'Test SDF Network ; September 2015', sorobanRpcUrl: 'https://soroban-testnet.stellar.org' },
    };
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (e.source !== window || !d || d.source !== 'FREIGHTER_EXTERNAL_MSG_REQUEST') return;
      fk.log.push({ ...d });
      const reply = (x) => window.postMessage({ source: 'FREIGHTER_EXTERNAL_MSG_RESPONSE', messagedId: d.messageId, ...x }, window.location.origin);
      const declined = { apiError: { code: -4, message: 'The user rejected this request.' } };
      setTimeout(() => {
        switch (d.type) {
          case 'REQUEST_CONNECTION_STATUS': return reply({ isConnected: true });
          case 'REQUEST_ACCESS': return reply({ publicKey: fk.address });
          case 'REQUEST_PUBLIC_KEY': return reply({ publicKey: fk.address });
          case 'REQUEST_ALLOWED_STATUS': return reply({ isAllowed: true });
          case 'REQUEST_NETWORK_DETAILS': return reply({ networkDetails: NETS[fk.net] });
          case 'SUBMIT_TRANSACTION': return reply(fk.reject ? declined : { signedTransaction: btoa(`signed:${d.transactionXdr.slice(0, 16)}`), signerAddress: fk.address });
          case 'SUBMIT_AUTH_ENTRY': return reply(fk.reject ? declined : { signedAuthEntry: btoa('ed25519-signature-bytes'), signerAddress: fk.address });
          default: return reply({ apiError: { code: -1, message: `unsupported ${d.type}` } });
        }
      }, 40);
    });
  }, FREIGHTER_ADDR);
  const fpage = await fctx.newPage();
  currentPage = fpage;
  const ferrors = watchConsole(fpage);

  await step('Freighter (simulated extension): wrong network message, then sign-in via signTransaction', async () => {
    await fpage.goto(base + '/');
    await view(fpage, 'landing');
    await fpage.locator('[data-testid=connect-freighter]').click();
    const msg = fpage.locator('[data-testid=login-message][data-reason=wrong_network]');
    await msg.waitFor({ timeout: T });
    assert((await text(msg)).includes('Mainnet') && (await text(msg)).includes('Testnet'), `wrong network text: ${await text(msg)}`);
    await fpage.screenshot({ path: path.join(SHOTS, 'freighter-wrong-network.png') });
    await fpage.evaluate(() => { window.__fk.net = 'TESTNET'; });
    await fpage.locator('[data-testid=connect-freighter]').click();
    await view(fpage, 'onboarding');
    assert((await text(fpage.locator('[data-testid=user-chip]'))).includes('Freighter'), 'chip says Freighter');
    const log = await fpage.evaluate(() => window.__fk.log);
    const types = log.map((m) => m.type);
    for (const t of ['REQUEST_CONNECTION_STATUS', 'REQUEST_ACCESS', 'REQUEST_NETWORK_DETAILS', 'SUBMIT_TRANSACTION']) assert(types.includes(t), `sent ${t}`);
    const tx = log.find((m) => m.type === 'SUBMIT_TRANSACTION');
    eq(tx.accountToSign, FREIGHTER_ADDR, 'accountToSign');
    eq(tx.networkPassphrase, 'Test SDF Network ; September 2015', 'networkPassphrase');
    assert(typeof tx.transactionXdr === 'string' && tx.transactionXdr.length > 20, 'transactionXdr');
    assert(typeof tx.messageId === 'number', 'messageId');
  });

  await step('Freighter: unfunded wallet -> "Get test XLM" via friendbot in place; rejecting a signature is handled; retry succeeds', async () => {
    await fpage.locator('[data-testid=create-account]').click();
    await fpage.locator('[data-testid=step-1][data-state=done]').waitFor({ timeout: T });
    await fpage.locator('[data-testid=friendbot-notice]').waitFor({ timeout: T });
    assert(await fpage.locator('[data-testid=get-test-usdc]').isDisabled(), 'test USDC disabled without XLM');
    const pages = fpage.context().pages().length;
    await fpage.locator('[data-testid=get-test-xlm]').click();
    await fpage.locator('[data-testid=friendbot-progress]').waitFor({ timeout: T });
    assert(await fpage.locator('[data-testid=get-test-xlm]').isDisabled(), 'button disabled while friendbot runs');
    await fpage.locator('[data-testid=friendbot-notice]').waitFor({ state: 'detached', timeout: T });
    eq(fpage.context().pages().length, pages, 'no new tab opened');
    eq(await fpage.locator('[data-testid=wallet-xlm]').textContent(), '10,000', 'XLM shown after friendbot');
    await fpage.evaluate(() => { window.__fk.reject = true; });
    await fpage.locator('[data-testid=get-test-usdc]').click();
    await fpage.locator('#modal [data-testid=op][data-state=rejected]').waitFor({ timeout: T });
    assert((await text(fpage.locator('#modal [data-testid=op-result]'))).includes('You rejected the signature in Freighter'), 'rejection text');
    await fpage.screenshot({ path: path.join(SHOTS, 'freighter-rejected.png') });
    await fpage.evaluate(() => { window.__fk.reject = false; });
    await fpage.locator('#modal button', { hasText: 'Try again' }).click();
    await opDone(fpage);
    await closeModal(fpage);
    await fpage.waitForFunction(() => document.querySelector('[data-testid=wallet-usdc]')?.textContent === '10', null, { timeout: T });
  });

  await step('Freighter: fund (signTransaction) and add agent (signAuthEntry with the op preimage)', async () => {
    await fpage.locator('[data-testid=fund-amount]').fill('5');
    await fpage.locator('[data-testid=fund-account]').click();
    await opDone(fpage);
    await closeModal(fpage);
    await fpage.locator('[data-testid=onboarding-done]').click();
    await view(fpage, 'dashboard');
    let preimage = null;
    fpage.on('response', async (r) => { if (r.url().endsWith('/api/agents/prepare')) preimage = (await r.json()).preimage; });
    const key = await addAgent(fpage, 'Freighter bot', '3');
    assert(/^awk_/.test(key), 'api key');
    const ae = (await fpage.evaluate(() => window.__fk.log)).filter((m) => m.type === 'SUBMIT_AUTH_ENTRY').pop();
    assert(ae, 'SUBMIT_AUTH_ENTRY sent');
    eq(ae.entryXdr, preimage, 'entryXdr is the op preimage');
    eq(ae.apiVersion, '6.0.1', 'apiVersion');
    eq(ae.accountToSign, FREIGHTER_ADDR, 'accountToSign');
    eq(ae.networkPassphrase, 'Test SDF Network ; September 2015', 'networkPassphrase');
    await closeModal(fpage);
    eq(ferrors.length, 0, `console errors: ${ferrors.join(' | ')}`);
  });
  await fctx.close();

  /* ===== no LLM_API_KEY ===== */
  const nctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const npage = await nctx.newPage();
  currentPage = npage;
  const nerrors = watchConsole(npage);
  await step('llm_configured=false: chat notice, model falls back to default_model, fatal error card', async () => {
    await npage.goto(noLLM.url + '/');
    await signInWithTestKey(npage);
    await view(npage, 'onboarding');
    await npage.locator('[data-testid=create-account]').click();
    await npage.locator('[data-testid=onboarding-done]:not([disabled])').click();
    await view(npage, 'dashboard');
    await addAgent(npage, 'Quiet bot', '1');
    await closeModal(npage);
    await agentCard(npage, 'Quiet bot').locator('[data-testid=agent-chat]').click();
    await view(npage, 'chat');
    await npage.locator('#llm-notice').waitFor({ state: 'visible', timeout: T });
    await npage.waitForFunction(() => document.querySelector('#model-select option')?.value === 'openai/gpt-4o-mini', null, { timeout: T });
    eq(await npage.locator('#model-select option').count(), 1, 'single fallback model');
    await npage.locator('#chips .chip').first().click();
    await npage.locator('.err-fatal').waitFor({ timeout: T });
    await npage.screenshot({ path: path.join(SHOTS, 'nollm.png') });
    eq(nerrors.length, 0, `console errors: ${nerrors.join(' | ')}`);
  });
  await nctx.close();

  await step('mock totals: no CSRF rejections from the UI, no bad signatures', async () => {
    const s = await mockStats(base);
    eq(s.csrf_rejections - csrfBaseline, 0, 'CSRF rejections');
    eq(s.bad_signatures, 0, 'bad signatures');
    const n = await mockStats(noLLM.url);
    eq(n.csrf_rejections, 0, 'CSRF rejections (no-LLM mock)');
  });
} finally {
  await browser.close();
  main.proc.kill();
  noLLM.proc.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} failed` : ''}. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
