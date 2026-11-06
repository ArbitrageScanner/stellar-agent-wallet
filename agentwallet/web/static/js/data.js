// Loads the signed-in user's data (me, account, agents, payments) and keeps
// it fresh: every 10 s while the tab is visible, and right after ops/txs.

import { api } from './api.js';
import { state, emit } from './state.js';

const REFRESH_MS = 10_000;
let timer = null;
let inflight = null;
let queued = false;
let gen = 0; // bumps on sign-out so late responses are dropped

export let lastError = null;

/** Fetches everything the dashboard and chat need. Concurrent calls coalesce into one follow-up. */
export function refreshAll() {
  if (!state.session) return Promise.resolve();
  if (inflight) { queued = true; return inflight; }
  const my = gen;
  inflight = (async () => {
    try {
      const me = await api.me();
      if (my !== gen) return;
      state.me = me;
      onFresh('me');
      emit('me', me);
      if (me.account_deployed) {
        const [acc, ags, pays] = await Promise.allSettled([
          api.account(),
          api.agents(),
          api.payments({ agent: state.payFilter || null, limit: 20 }),
        ]);
        if (my !== gen) return;
        if (acc.status === 'fulfilled') { state.account = acc.value; onFresh('account'); emit('account', acc.value); }
        if (ags.status === 'fulfilled') { state.agents = ags.value.items || []; state.agentsAt = Date.now(); emit('agents', state.agents); }
        if (pays.status === 'fulfilled') { state.payments = pays.value.items || []; emit('payments', state.payments); }
        const failed = [acc, ags, pays].find((r) => r.status === 'rejected');
        lastError = failed ? failed.reason : null;
      } else {
        lastError = null;
      }
      emit('data', { error: lastError });
    } catch (e) {
      if (my !== gen) return;
      lastError = e;
      emit('data', { error: e });
    } finally {
      if (my === gen) {
        inflight = null;
        if (queued) { queued = false; setTimeout(refreshAll, 0); }
      }
    }
  })();
  return inflight;
}

export async function refreshPayments() {
  const my = gen;
  const r = await api.payments({ agent: state.payFilter || null, limit: 20 });
  if (my !== gen) return;
  state.payments = r.items || [];
  emit('payments', state.payments);
}

export function startPolling() {
  stopPolling();
  timer = setInterval(() => { if (!document.hidden && state.session) refreshAll(); }, REFRESH_MS);
}

export function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

/* ---------- expected balances after a confirmed op ----------
 * Stellar RPC can lag a confirmed transaction by several seconds, so a refresh
 * right after "fund" may still return the old balances. After an op that moves
 * USDC the new balances are known exactly: show them at once, poll faster, and
 * keep them on screen until a fresh server read agrees (or SYNC_MS passes, after
 * which the server's numbers win). */

const SYNC_MS = 60_000;
const SYNC_POLL_MS = 2_500;
let expectation = null; // { wallet: "5" | null, account: "5" | null, until }
let syncTimer = null;

export const isSyncing = () => !!expectation;

const num = (x) => Number(x) || 0;
const same = (a, b) => Math.abs(num(a) - num(b)) < 1e-7;
const fmt7 = (n) => String(Math.round(n * 1e7) / 1e7);
const usdcEntry = (acc) => ((acc && acc.balances) || []).find((x) => /^usdc/i.test(x.asset || ''));

/** A confirmed op moved USDC: { wallet: +/-n, account: +/-n } relative to what is shown now. */
export function expectUsdc({ wallet = 0, account = 0 }) {
  const curW = num(state.me && state.me.wallet && state.me.wallet.usdc);
  const curA = num(usdcEntry(state.account) && usdcEntry(state.account).amount);
  expectation = {
    wallet: wallet ? fmt7(Math.max(0, curW + wallet)) : null,
    account: account ? fmt7(Math.max(0, curA + account)) : null,
    until: Date.now() + SYNC_MS,
  };
  patch();
  if (state.me) emit('me', state.me);
  if (state.account) emit('account', state.account);
  emit('sync', true);
  clearInterval(syncTimer);
  syncTimer = setInterval(() => { if (state.session) refreshAll(); }, SYNC_POLL_MS);
}

/** Called right after state.me / state.account were replaced by a server read. */
function onFresh(kind) {
  const e = expectation;
  if (!e) return;
  if (kind === 'me' && e.wallet !== null && state.me && state.me.wallet && same(state.me.wallet.usdc, e.wallet)) e.wallet = null;
  if (kind === 'account' && e.account !== null && same((usdcEntry(state.account) || {}).amount, e.account)) e.account = null;
  if ((e.wallet === null && e.account === null) || Date.now() > e.until) { endSync(); return; }
  patch();
}

function patch() {
  const e = expectation;
  if (!e) return;
  const w = state.me && state.me.wallet;
  if (e.wallet !== null && w) {
    w.usdc = e.wallet;
    if (num(e.wallet) > 0) w.usdc_trustline = true;
  }
  if (e.account !== null && state.account) {
    const a = usdcEntry(state.account);
    if (a) a.amount = e.account;
    else (state.account.balances = state.account.balances || []).push({ asset: 'USDC', amount: e.account });
  }
}

function endSync(silent = false) {
  expectation = null;
  clearInterval(syncTimer);
  syncTimer = null;
  if (!silent) emit('sync', false);
}

/** Drops all user data (sign-out). */
export function resetData() {
  gen++;
  inflight = null;
  queued = false;
  lastError = null;
  endSync(true);
  stopPolling();
  Object.assign(state, { me: null, account: null, agents: null, agentsAt: 0, payments: null, payFilter: '', chatAgent: null });
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && state.session && timer) refreshAll(); });
