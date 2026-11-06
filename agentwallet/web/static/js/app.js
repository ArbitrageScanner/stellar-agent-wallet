// Entry point: config, theme, session lifecycle and routing.
//
// Views: landing (signed out) · onboarding (account not deployed) ·
// dashboard · chat · how. Routes: #dashboard, #chat, #how (#home = landing).

import { api, onUnauthorized, describeError } from './api.js';
import { state, on, emit } from './state.js';
import { initLanding, renderLanding, showSignedOutReason } from './landing.js';
import { initOnboarding, renderOnboarding, resetOnboarding } from './onboarding.js';
import { initDashboard, renderDashboard, resetDashboard } from './dashboard.js';
import { initChat, showChat, resetChat } from './chat.js';
import { refreshAll, startPolling, resetData, lastError } from './data.js';
import { closeModal, isModalOpen } from './modal.js';
import * as Dev from './devwallet.js';
import { h, icon, ICONS, store, short, sleep, toast, fmtAmount, fmtApprox } from './util.js';

const VIEWS = ['boot', 'landing', 'onboarding', 'dashboard', 'chat', 'how'];
const K_SESSION = 'aw.session';

let booting = true;
let pendingChatAgent = null;

/* ---------- routing ---------- */

const route = () => location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || '';

function viewFor(r) {
  if (r === 'how') return 'how';
  if (!state.session) return booting ? 'boot' : 'landing';
  if (!state.me) return 'boot';
  if (!state.me.account_deployed || state.onboarding) return 'onboarding';
  if (r === 'chat') return 'chat';
  return 'dashboard';
}

function tabsFor() {
  if (!state.session) return [['home', 'Home'], ['how', 'How it works']];
  if (!state.me || !state.me.account_deployed || state.onboarding) return [['dashboard', 'Get started'], ['how', 'How it works']];
  return [['dashboard', 'Dashboard'], ['chat', 'Chat'], ['how', 'How it works']];
}

const TAB_OF_VIEW = { landing: 'home', boot: 'home', onboarding: 'dashboard', dashboard: 'dashboard', chat: 'chat', how: 'how' };

function render() {
  const view = viewFor(route());
  const prev = document.body.dataset.view;
  for (const v of VIEWS) document.getElementById(`view-${v}`).hidden = v !== view;
  document.body.dataset.view = view;
  renderTabs(TAB_OF_VIEW[view]);
  renderUser();
  if (view === 'landing') renderLanding();
  else if (view === 'onboarding') renderOnboarding();
  else if (view === 'dashboard') renderDashboard({ force: prev !== 'dashboard' });
  else if (view === 'chat') { showChat(pendingChatAgent); pendingChatAgent = null; }
  if (prev !== view && prev !== 'boot') window.scrollTo(0, 0);
}

function renderTabs(active) {
  const nav = document.getElementById('tabs');
  const tabs = tabsFor();
  const key = tabs.map((t) => t[0]).join('|');
  if (nav.dataset.key !== key) {
    nav.dataset.key = key;
    nav.replaceChildren(...tabs.map(([id, label]) => h('a', { class: 'tab', href: `#${id}`, id: `tab-${id}`, dataset: { tab: id } }, label)));
  }
  for (const a of nav.querySelectorAll('.tab')) {
    const on_ = a.dataset.tab === active;
    a.classList.toggle('active', on_);
    if (on_) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

function renderUser() {
  const area = document.getElementById('user-area');
  const s = state.session;
  area.hidden = !s;
  if (!s) return;
  const chip = document.getElementById('user-chip');
  chip.title = s.address;
  chip.replaceChildren(
    h('span', { class: 'user-dot', 'aria-hidden': 'true' }),
    h('code', {}, short(s.address, 4, 4)),
    s.signer === 'dev' ? h('span', { class: 'tag tag-warn' }, 'Test key') : h('span', { class: 'tag' }, 'Freighter'));
}

/** Opens the chat for one agent (from a dashboard card). */
function openChat(agentId) {
  pendingChatAgent = agentId;
  state.chatAgent = agentId;
  if (route() === 'chat') render();
  else location.hash = '#chat';
}

/* ---------- session ---------- */

function readHint() {
  try { const o = JSON.parse(store.get(K_SESSION, 'null')); return o && o.address ? o : null; } catch { return null; }
}

async function signedIn(session) {
  booting = false;
  state.session = { address: session.address, signer: session.signer };
  state.onboarding = false;
  store.set(K_SESSION, JSON.stringify(state.session));
  if (session.warning) toast(session.warning, 'bad');
  await loadUserData();
  startPolling();
  if (route() === 'how' || route() === 'home' || !route()) history.replaceState(null, '', '#dashboard');
  render();
}

async function loadUserData() {
  for (;;) {
    await refreshAll();
    if (!state.session) return; // a 401 signed us out
    if (state.me) { banner(null); return; }
    await new Promise((resolve) => banner([
      icon(ICONS.alert),
      h('span', {}, `Could not load your account: ${describeError(lastError)}`),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => { banner(null); resolve(); } }, icon(ICONS.retry), 'Retry'),
    ]));
  }
}

async function signOut(reason = null, { server = true } = {}) {
  const wasSignedIn = !!state.session;
  if (server && wasSignedIn) { try { await api.logout(); } catch { /* the cookie may already be gone */ } }
  state.session = null;
  state.onboarding = false;
  booting = false;
  store.del(K_SESSION);
  resetData();
  resetChat();
  resetDashboard();
  resetOnboarding();
  if (isModalOpen()) closeModal();
  if (route() !== 'how') history.replaceState(null, '', location.pathname + location.search);
  render();
  if (reason) showSignedOutReason(reason);
}

onUnauthorized(() => {
  if (state.session) signOut('Your session has ended. Sign in again.', { server: false });
});

/* ---------- theme ---------- */

function effectiveTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function initTheme() {
  const btn = document.getElementById('theme-toggle');
  const label = () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    btn.title = `Switch to ${next} theme`;
    btn.setAttribute('aria-label', btn.title);
  };
  btn.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.set('aw.theme', next);
    label();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', label);
  label();
}

/* ---------- config ---------- */

function banner(content, kind = 'error') {
  const el = document.getElementById('global-banner');
  if (!content) { el.hidden = true; el.replaceChildren(); return; }
  el.className = `global-banner ${kind}`;
  el.replaceChildren(...[].concat(content));
  el.hidden = false;
}

async function loadConfig() {
  for (let attempt = 0; ; attempt++) {
    try {
      const cfg = await api.config();
      state.config = cfg;
      banner(null);
      document.getElementById('net-pill').textContent = cfg.network || 'testnet';
      document.getElementById('how-threshold').textContent = fmtAmount(cfg.approval_threshold ?? '2');
      const pl = cfg.period_ledgers || 17280;
      document.getElementById('how-period').textContent = `${pl.toLocaleString('en-US')} ledgers (${fmtApprox(pl * (cfg.ledger_seconds || 5))})`;
      emit('config', cfg);
      return cfg;
    } catch (err) {
      if (attempt < 1) { await sleep(800); continue; }
      await new Promise((resolve) => {
        banner([
          icon(ICONS.alert),
          h('span', {}, `Could not load server settings: ${err.message || err}`),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => { banner(null); resolve(); } }, icon(ICONS.retry), 'Retry'),
        ]);
      });
      attempt = -1;
    }
  }
}

/* ---------- boot ---------- */

async function main() {
  initTheme();
  initLanding({ onSignedIn: signedIn });
  initOnboarding({ onDone: () => { state.onboarding = false; history.replaceState(null, '', '#dashboard'); render(); } });
  initDashboard({ onChat: openChat });
  initChat();
  document.getElementById('logout-btn').replaceChildren(icon(ICONS.logout));
  document.getElementById('logout-btn').addEventListener('click', () => signOut());
  window.addEventListener('hashchange', render);
  // Re-route when the deploy state changes (e.g. after "Create my agent wallet").
  on('me', () => { if (viewFor(route()) !== document.body.dataset.view) render(); });
  on('agents', () => { if (viewFor(route()) !== document.body.dataset.view) render(); });
  render();

  await loadConfig();
  const hint = readHint();
  if (!hint) { booting = false; render(); return; }

  // Resume the session from the cookie (the hint only says "try /api/me").
  state.session = { address: hint.address, signer: hint.signer === 'dev' ? 'dev' : 'freighter' };
  render();
  await loadUserData();
  booting = false;
  if (!state.session) { render(); return; }
  const me = state.me;
  if (me && me.address && me.address !== state.session.address) {
    state.session = { address: me.address, signer: Dev.storedAddress() === me.address ? 'dev' : 'freighter' };
    store.set(K_SESSION, JSON.stringify(state.session));
  }
  if (state.session.signer === 'dev' && Dev.storedAddress() !== state.session.address) {
    banner([icon(ICONS.alert), h('span', {}, 'This session was signed in with a test key from another tab, so this tab cannot sign operations. Sign out and sign in again here.')], 'warn');
  }
  startPolling();
  render();
}

main();
