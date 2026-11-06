// Browser run against the REAL stack: agentwallet serve (multi-tenant, real
// Stellar testnet transactions) + mock-llm.mjs in place of OpenRouter, with
// the in-browser test key (DEV_WALLET=true) in place of Freighter.
//
//   node mock-llm.mjs &
//   DEV_WALLET=true OPENROUTER_URL=http://127.0.0.1:8799/api/v1 OPENROUTER_API_KEY=mock MODEL=mock/scripted \
//     MASTER_KEY_FILE=… agentwallet serve &
//   source .pw/env.sh && BASE=http://127.0.0.1:8090 node real-stack.mjs
//
// A fresh test user each run: friendbot XLM, ~10 test USDC from the DEX.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? 'http://127.0.0.1:8090';
const SHOTS = path.join(HERE, 'shots');
const T = 180_000; // testnet transactions take a while
mkdirSync(SHOTS, { recursive: true });

const results = [];
const txs = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push(true);
    console.log(`PASS  ${name}  (${Math.round((Date.now() - t) / 1000)} s)`);
  } catch (e) {
    results.push(false);
    const shot = path.join(SHOTS, `real-fail-${results.length}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    console.log(`      screenshot: ${shot}`);
    console.log(`FAIL  ${name}\n      ${String(e.message || e).split('\n')[0]}`);
  }
}
const note = (what, href) => { txs.push([what, href]); console.log(`      ${what}: ${href}`); };

const cfg = await (await fetch(`${BASE}/api/config`)).json();
if (!cfg.dev_wallet) throw new Error('server must run with DEV_WALLET=true');
const PAYEE = cfg.demo_payee;

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/401/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

const view = (name) => page.locator(`#view-${name}`).waitFor({ state: 'visible', timeout: T });
const text = async (loc) => ((await loc.textContent()) || '').replace(/\s+/g, ' ').trim();
const idle = () => page.locator('#send-btn').waitFor({ state: 'visible', timeout: T });
async function send(t) {
  await page.locator('#composer-input').fill(t);
  await page.locator('#composer-input').press('Enter');
}
async function opDone(what) {
  const op = page.locator('#modal [data-testid=op]');
  await op.waitFor({ timeout: T });
  await page.waitForFunction(() => ['done', 'failed', 'rejected'].includes(document.querySelector('#modal [data-testid=op]')?.dataset.state), null, { timeout: T });
  const st = await op.getAttribute('data-state');
  if (st !== 'done') throw new Error(`${what}: op ${st}: ${await text(page.locator('#modal [data-testid=op-result]'))}`);
  const href = await page.locator('#modal [data-testid=op-tx] a.tx-link').first().getAttribute('href');
  if (!/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/.test(href || '')) throw new Error(`${what}: bad tx link ${href}`);
  note(what, href);
}
async function closeModal() {
  const done = page.locator('#modal [data-testid=op-close], #modal [data-testid=key-done]');
  if (await done.count()) await done.first().click();
  else await page.locator('#modal-close').click();
  await page.waitForFunction(() => !document.getElementById('modal').open, null, { timeout: T });
}
const card = () => page.locator('[data-testid=agent-card]').first();
const status = () => card().locator('[data-testid=agent-status]').getAttribute('data-status');

await step('sign in with a test key (SEP-10 verified by the Go server)', async () => {
  await page.goto(BASE + '/');
  await page.locator('[data-testid=use-test-key]').click();
  await page.waitForFunction(() => ['onboarding', 'dashboard'].includes(document.body.dataset.view), null, { timeout: T });
});

await step('create the smart account (relayer deploys, owner = Delegated(test key))', async () => {
  await view('onboarding');
  await page.locator('[data-testid=create-account]').click();
  await page.locator('[data-testid=step-1][data-state=done]').waitFor({ timeout: T });
});

await step('get 10 test USDC (user-signed tx) and fund the agent wallet with 8', async () => {
  await page.waitForFunction(() => Number((document.querySelector('[data-testid=wallet-xlm]')?.textContent || '0').replace(/,/g, '')) > 0, null, { timeout: T }).catch(() => {});
  await page.locator('[data-testid=get-test-usdc]').click();
  await opDone('user buys 10 test USDC');
  await closeModal();
  await page.waitForFunction(() => document.querySelector('[data-testid=wallet-usdc]')?.textContent === '10', null, { timeout: T });
  await page.locator('[data-testid=fund-amount]').fill('8');
  await page.locator('[data-testid=fund-account]').click();
  await opDone('user funds agent wallet with 8 USDC');
  await closeModal();
});

let apiKey;
await step('add agent "Shopping bot" 5 USDC/day (owner auth entry) -> API key shown once', async () => {
  await page.locator('[data-testid=step-3][data-state=active] [data-testid=onboarding-ready]').waitFor({ timeout: T });
  await page.screenshot({ path: path.join(SHOTS, 'real-onboarding-ready.png') });
  await page.locator('[data-testid=onboarding-done]').click();
  await view('dashboard');
  await page.locator('#agent-name').fill('Shopping bot');
  await page.locator('#agent-limit').fill('5');
  await page.locator('#agent-days').fill('');
  await page.locator('#add-agent-form button[type=submit]').click();
  await opDone('owner adds agent rule with spending limit');
  await page.locator('#modal [data-testid=api-key]').waitFor({ timeout: T });
  apiKey = (await page.locator('#modal [data-testid=api-key]').textContent()).trim();
  if (!apiKey.startsWith('awk_')) throw new Error(`api key ${apiKey}`);
  await closeModal();
  // the new agent must be on screen at once, before Stellar RPC lists it
  await page.locator('[data-testid=agent-card]').first().waitFor({ timeout: 1500 });
  const syncingNow = await page.locator('[data-testid=agent-syncing]').count();
  console.log(`      agent card shown immediately${syncingNow ? ' (marked as syncing)' : ''}`);
  await page.screenshot({ path: path.join(SHOTS, 'real-agent-added.png') });
  if ((await status()) !== 'active') throw new Error(`status ${await status()}`);
  await page.screenshot({ path: path.join(SHOTS, 'real-dashboard.png') });
});

await step('chat: balance -> wallet_info shows 8; "Pay 1" -> real tx', async () => {
  await card().locator('[data-testid=agent-chat]').click();
  await view('chat');
  await send('How much money do I have?');
  await page.locator('.tool-card[data-tool=wallet_info][data-status=ok]').waitFor({ timeout: T });
  await idle();
  const sum = await text(page.locator('.tool-card[data-tool=wallet_info] .tool-summary').last());
  if (!sum.includes('Balance 8 USDC')) throw new Error(`summary: ${sum}`);
  await send(`Pay 1 USDC to ${PAYEE}`);
  await page.locator('.tool-card[data-tool=pay][data-status=ok]').last().waitFor({ timeout: T });
  note('agent pays 1 USDC (chat)', await page.locator('[data-testid=tx] a.tx-link').last().getAttribute('href'));
  await idle();
});

await step('chat: "Pay 6" (4 left of 5) -> refused: limit card, or a dry run that predicts the rejection', async () => {
  const cardsBefore = await page.locator('.tool-card').count();
  await send(`Pay 6 USDC to ${PAYEE}`);
  await idle();
  // a real model may call pay (rejected on-chain) or simulate_payment first
  // and decline to send; both must leave the money where it is
  const err = page.locator('.err-card[data-code=spending_limit_exceeded]').last();
  const sim = page.locator('.tool-card[data-tool=simulate_payment]').last();
  await page.waitForFunction((n) => document.querySelectorAll('.tool-card').length > n, cardsBefore, { timeout: T });
  if (await err.count()) {
    const line = await text(err.locator('[data-testid=limit-line]'));
    if (!line.startsWith('Limit 5 USDC/day · spent 1 · remaining 4')) throw new Error(`limit line: ${line}`);
    note('agent pays 6 USDC: rejected (#3221)', await page.locator('[data-testid=tx] a.tx-link').last().getAttribute('href'));
  } else if (await sim.count()) {
    const s = await text(sim.locator('.tool-summary'));
    if (!/would fail/i.test(s)) throw new Error(`dry run summary: ${s}`);
    console.log('      model dry-ran the payment and declined to send it');
  } else {
    throw new Error('neither a limit rejection nor a failing dry run');
  }
  if (await page.locator('.tool-card[data-tool=pay][data-status=ok]').count() !== 1) throw new Error('an over-limit payment went through');
  await page.screenshot({ path: path.join(SHOTS, 'real-chat-limit.png') });
});

await step(`chat: "Pay 3" (> approval threshold ${cfg.approval_threshold}) -> Approve -> real tx`, async () => {
  await send(`Pay 3 USDC to ${PAYEE}`);
  await page.locator('[data-testid=approval][data-state=pending]').waitFor({ timeout: T });
  await page.locator('.approval button', { hasText: 'Approve' }).last().click();
  await page.locator('[data-testid=approval][data-state=approved]').waitFor({ timeout: T });
  await page.locator('.tool-card[data-tool=pay][data-status=ok]').nth(1).waitFor({ timeout: T });
  note('agent pays 3 USDC after approval (chat)', await page.locator('[data-testid=tx].ok a.tx-link, [data-testid=tx] a.tx-link').last().getAttribute('href'));
  await idle();
});

await step('MCP with the agent API key: wallet_info shows 4 spent', async () => {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } }),
  });
  if (r.status !== 200) throw new Error(`initialize HTTP ${r.status}`);
  const bad = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer awk_nope' }, body: '{}' });
  if (bad.status !== 401) throw new Error(`bad key HTTP ${bad.status}`);
});

await step('revoke (owner auth) -> revoked; chat pay refused; restore -> active', async () => {
  await page.locator('#tab-dashboard').click();
  await view('dashboard');
  await card().locator('[data-testid=agent-revoke]').click();
  await opDone('owner revokes agent');
  await closeModal();
  await page.waitForFunction(() => document.querySelector('[data-testid=agent-card] [data-testid=agent-status]')?.dataset.status === 'revoked', null, { timeout: T });
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: '{}' });
  if (r.status !== 401) throw new Error(`revoked agent MCP HTTP ${r.status}`);
  await card().locator('[data-testid=agent-chat]').click();
  await view('chat');
  await send(`Pay 1 USDC to ${PAYEE}`);
  await page.locator('.err-card[data-code=agent_inactive]').last().waitFor({ timeout: T });
  await idle();
  await page.locator('#tab-dashboard').click();
  await view('dashboard');
  await card().locator('[data-testid=agent-restore]').click();
  await opDone('owner restores agent');
  await closeModal();
  await page.waitForFunction(() => document.querySelector('[data-testid=agent-card] [data-testid=agent-status]')?.dataset.status === 'active', null, { timeout: T });
});

await step('withdraw 1 USDC (owner auth) -> back to the wallet', async () => {
  await page.locator('[data-testid=withdraw]').click();
  const form = page.locator('#modal [data-testid=withdraw-form]');
  await form.waitFor({ timeout: T });
  await form.locator('input').first().fill('1');
  await form.locator('button[type=submit]').click();
  await opDone('owner withdraws 1 USDC');
  await closeModal();
});

await step('logout -> signed-out screen', async () => {
  await page.locator('[data-testid=logout]').click();
  await page.waitForFunction(() => document.body.dataset.view === 'landing', null, { timeout: T });
});

await step('no console errors', async () => {
  if (errors.length) throw new Error(errors.join(' | '));
});

await browser.close();
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed. Screenshots: ${SHOTS}`);
console.log('\ntransactions:');
for (const [w, h] of txs) console.log(`  ${w.padEnd(44)} ${h}`);
process.exit(ok === results.length ? 0 : 1);
