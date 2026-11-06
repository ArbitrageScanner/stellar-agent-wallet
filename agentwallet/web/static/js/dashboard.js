// Dashboard: account card (balance, withdraw, add funds), agents (limit gauge,
// chat, change limit, revoke/restore, API keys), "Add agent", recent payments.

import { api, describeError } from './api.js';
import { state, on, accountUrl } from './state.js';
import { refreshAll, refreshPayments, expectUsdc, isSyncing } from './data.js';
import { runOp } from './ops.js';
import { openModal, closeModal, promptAmount } from './modal.js';
import { fundingPanel } from './onboarding.js';
import { statusBadge, limitGauge, payItem, apiKeyReveal, addrLine } from './widgets.js';
import { h, icon, ICONS, short, fmtAmount, fmtRelTime, normAmount, copyBtn, plural, toast } from './util.js';
import { isDev } from './signer.js';

let openChat = () => {};
const openKeys = new Set();   // agent ids whose API key panel is open
let lastAgentsKey = '';
let lastAccountKey = '';

export function initDashboard({ onChat }) {
  openChat = onChat;
  const form = document.getElementById('add-agent-form');
  form.addEventListener('submit', (e) => { e.preventDefault(); addAgent(form); });
  document.getElementById('add-agent-jump').addEventListener('click', () => {
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('agent-name').focus({ preventScroll: true });
  });
  document.getElementById('payments-filter').addEventListener('change', (e) => {
    state.payFilter = e.target.value;
    document.getElementById('payments-list').replaceChildren(h('div', { class: 'state-box state-loading' }, h('span', { class: 'spinner' }), 'Loading…'));
    refreshPayments().catch((err) => renderPaymentsError(err));
  });
  on('account', () => renderAccount());
  on('me', () => renderAccount());
  on('sync', () => renderAccount());
  on('agents', () => { renderAgents(); renderFilter(); });
  on('payments', () => renderPayments());
}

export function renderDashboard({ force = false } = {}) {
  if (force) { lastAgentsKey = ''; lastAccountKey = ''; }
  renderAccount();
  renderAgents();
  renderFilter();
  renderPayments();
}

export function resetDashboard() {
  openKeys.clear();
  lastAgentsKey = '';
  lastAccountKey = '';
  document.getElementById('account-card').replaceChildren();
  document.getElementById('agent-list').replaceChildren();
  document.getElementById('payments-list').replaceChildren();
  document.getElementById('add-agent-form').reset();
}

/* ---------- account ---------- */

export function accountUsdc() {
  const b = ((state.account && state.account.balances) || []).find((x) => /^usdc/i.test(x.asset || ''));
  return b ? b.amount : null;
}

function renderAccount() {
  const el = document.getElementById('account-card');
  const me = state.me;
  const acc = state.account;
  if (!me) return;
  const key = JSON.stringify([me, acc && acc.balances, acc && acc.address, isDev(), isSyncing()]);
  if (key === lastAccountKey && el.firstChild) return;
  lastAccountKey = key;
  const address = (acc && acc.address) || me.account;
  const url = (acc && acc.url) || me.account_url || accountUrl(address);
  const bal = accountUsdc();
  const w = me.wallet || {};
  el.replaceChildren(h('section', { class: 'card account-card', 'data-testid': 'account-card', 'aria-label': 'Your agent wallet' },
    h('div', { class: 'lcd' },
      h('div', { class: 'account-lcd-main' },
        h('div', { class: 'lcd-row' },
          h('span', {}, `agent wallet, ${(state.config && state.config.network) || 'testnet'}`),
          addrLine(address, url, 'account-address')),
        h('div', {},
          h('span', { class: 'lcd-num', 'data-testid': 'account-balance' }, acc ? fmtAmount(bal ?? 0) : '…'),
          h('span', { class: 'lcd-unit' }, ' USDC')),
        h('div', { class: 'lcd-row' }, isSyncing()
          ? h('span', { 'data-testid': 'syncing' }, 'confirmed, waiting for Stellar RPC to catch up…')
          : h('span', {}, 'shared by all your agents'))),
      h('div', { class: 'account-actions' },
        h('button', { class: 'btn btn-sm', type: 'button', 'data-testid': 'add-funds', onClick: addFunds }, icon(ICONS.down), 'Add funds'),
        h('button', { class: 'btn btn-sm', type: 'button', 'data-testid': 'withdraw', onClick: withdraw, disabled: !(Number(bal) > 0) }, icon(ICONS.up), 'Withdraw'))),
    h('div', { class: 'owner-line' },
      h('span', {}, 'Owner on rule 0'),
      h('span', { class: 'owner-addr' },
        h('code', { title: me.address }, short(me.address, 5, 5)),
        isDev() ? h('span', { class: 'tag tag-warn' }, 'Test key') : h('span', { class: 'tag' }, 'Freighter')),
      h('span', { class: 'owner-bal' },
        `Your wallet holds ${fmtAmount(w.xlm ?? 0)} XLM and `, h('span', { 'data-testid': 'wallet-usdc-dash' }, fmtAmount(w.usdc ?? 0)), ' USDC'))));
}

function addFunds() {
  openModal({
    title: 'Add funds',
    content: [h('p', { class: 'muted small' }, 'Get test USDC into your wallet, then move it into your agent wallet.'), fundingPanel({ inModal: true })],
  });
}

async function withdraw() {
  const bal = accountUsdc();
  const v = await promptAmount({
    title: 'Withdraw USDC',
    label: 'Amount',
    max: bal !== null ? String(Number(bal)) : null,
    value: '',
    help: 'Moves USDC from your smart account back to your wallet. Your wallet signs an authorization entry for rule 0.',
    testid: 'withdraw-form',
  });
  if (!v) return;
  runOp({
    title: 'Withdraw USDC',
    prepare: () => api.withdraw(v),
    okText: () => `Withdrew ${fmtAmount(v)} USDC to your wallet.`,
    done: () => expectUsdc({ account: -Number(v), wallet: Number(v) }),
    after: () => refreshAll(),
  });
}

/* ---------- agents ---------- */

function renderAgents() {
  const list = document.getElementById('agent-list');
  const agents = state.agents;
  document.getElementById('agents-count').textContent = agents && agents.length ? String(agents.length) : '';
  if (!agents) {
    if (!list.firstChild) list.replaceChildren(h('div', { class: 'state-box state-loading' }, h('span', { class: 'spinner' }), 'Loading agents…'));
    return;
  }
  const key = JSON.stringify([agents.map((a) => ({ ...a, limit: { ...a.limit, resets_in_seconds: null } })), [...openKeys]]);
  if (key === lastAgentsKey && list.firstChild) {
    // Only the countdown base moved; refresh the countdown attributes in place.
    for (const a of agents) {
      const el = list.querySelector(`[data-agent-id="${CSS.escape(a.id)}"] [data-countdown]`);
      if (el && a.limit && a.limit.resets_in_seconds !== null && a.limit.resets_in_seconds !== undefined) {
        el.dataset.countdown = String(a.limit.resets_in_seconds);
        el.dataset.at = String(state.agentsAt);
      }
    }
    return;
  }
  lastAgentsKey = key;
  if (!agents.length) {
    list.replaceChildren(h('div', { class: 'empty-agents', 'data-testid': 'no-agents' },
      h('b', {}, 'No agents yet.'),
      h('span', { class: 'muted' }, ' Add your first agent: give it a name and a daily limit, then sign in your wallet.')));
    return;
  }
  list.replaceChildren(...agents.map(agentCard));
}

function agentCard(a) {
  const lim = a.limit || {};
  const pending = a.status === 'pending';
  const active = a.status === 'active';
  const keys = a.api_keys || [];
  const keysOpen = openKeys.has(a.id);
  const validUntil = a.valid_until !== null && a.valid_until !== undefined;
  const card = h('article', { class: 'agent', 'data-testid': 'agent-card', dataset: { agentId: a.id, status: a.status || '' } },
    h('div', { class: 'agent-head' },
      h('div', { class: 'agent-title' },
        h('h4', { 'data-testid': 'agent-name' }, a.name || a.id),
        statusBadge(a.status)),
      h('span', { class: 'agent-rule muted small' }, a.rule_id !== null && a.rule_id !== undefined ? `rule ${a.rule_id}` : '')),
    h('div', { class: 'agent-meta muted small' },
      h('span', { class: 'agent-key' }, 'key ', h('code', { title: a.public_key }, short(a.public_key, 5, 5)), a.public_key ? copyBtn(a.public_key, 'Copy agent key') : null),
      h('span', {}, validUntil ? `valid until ledger ${Number(a.valid_until).toLocaleString('en-US')}` : 'no expiry'),
      a.created_at ? h('span', {}, `added ${fmtRelTime(a.created_at)}`) : null),
    pending
      ? h('div', { class: 'notice notice-warn small' }, h('strong', {}, 'Waiting for your signature.'), ' This agent becomes active once the add-agent operation is signed and submitted.')
      : limitGauge(lim, { at: state.agentsAt }),
    h('div', { class: 'agent-stats muted small' },
      h('span', { 'data-testid': 'payments-count' }, `${a.payments_count ?? 0} ${plural(a.payments_count ?? 0, 'payment')}`),
      h('span', {}, `${keys.length} API ${plural(keys.length, 'key')}`)),
    h('div', { class: 'agent-actions' },
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-testid': 'agent-chat', disabled: pending, onClick: () => openChat(a.id) }, icon(ICONS.chat), 'Chat'),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-testid': 'agent-limit', disabled: pending, onClick: () => changeLimit(a) }, icon(ICONS.gauge), 'Change limit'),
      active
        ? h('button', { class: 'btn btn-ghost btn-sm btn-danger-ghost', type: 'button', 'data-testid': 'agent-revoke', onClick: () => revoke(a) }, icon(ICONS.pause), 'Revoke')
        : h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-testid': 'agent-restore', disabled: pending, onClick: () => restore(a) }, icon(ICONS.play), 'Restore'),
      h('button', {
        class: `btn btn-ghost btn-sm ${keysOpen ? 'is-open' : ''}`, type: 'button', 'data-testid': 'agent-keys', disabled: pending,
        'aria-expanded': String(keysOpen), onClick: () => toggleKeys(a.id),
      }, icon(ICONS.key), 'API keys')),
    keysOpen && !pending ? keysPanel(a) : null);
  return card;
}

function toggleKeys(id) {
  if (openKeys.has(id)) openKeys.delete(id); else openKeys.add(id);
  lastAgentsKey = '';
  renderAgents();
}

function keysPanel(a) {
  const keys = a.api_keys || [];
  return h('div', { class: 'keys', 'data-testid': 'keys-panel' },
    keys.length
      ? h('ul', { class: 'key-list' }, keys.map((k) => h('li', { class: 'key-item', 'data-testid': 'key-item', dataset: { prefix: k.prefix } },
        h('code', { class: 'key-prefix' }, `${k.prefix}…`),
        h('span', { class: 'muted small' }, `created ${fmtRelTime(k.created_at) || '—'}`),
        h('span', { class: 'muted small' }, k.last_used_at ? `last used ${fmtRelTime(k.last_used_at)}` : 'never used'),
        h('button', { class: 'btn btn-ghost btn-sm btn-danger-ghost', type: 'button', 'data-testid': 'key-revoke', onClick: () => revokeKey(a, k.prefix) }, icon(ICONS.trash), 'Revoke'))))
      : h('div', { class: 'muted small' }, 'No API keys. Create one to connect an external agent over MCP.'),
    h('div', { class: 'keys-foot' },
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-testid': 'key-create', onClick: (e) => createKey(a, e.currentTarget) }, icon(ICONS.plus), 'Create new key'),
      h('span', { class: 'muted small' }, 'Keys are shown once and stored hashed.')));
}

async function createKey(a, btn) {
  btn.disabled = true;
  try {
    const r = await api.createKey(a.id);
    openModal({
      title: `New API key for ${a.name}`,
      content: [apiKeyReveal(a.name, r.api_key), h('div', { class: 'modal-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', 'data-testid': 'key-done', onClick: () => closeModal() }, 'Done'))],
    });
    refreshAll();
  } catch (err) {
    toast(`Could not create a key: ${describeError(err)}`, 'bad');
  } finally {
    btn.disabled = false;
  }
}

function revokeKey(a, prefix) {
  const status = h('div', { class: 'op-status' });
  const yes = h('button', { class: 'btn btn-danger', type: 'button', 'data-testid': 'key-revoke-confirm' }, 'Revoke key');
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    status.replaceChildren(h('span', { class: 'spinner' }), ' Revoking…');
    try {
      await api.revokeKey(a.id, prefix);
      closeModal();
      toast(`API key ${prefix}… revoked`);
      refreshAll();
    } catch (err) {
      yes.disabled = false;
      status.replaceChildren(h('span', { class: 'bad' }, describeError(err)));
    }
  });
  openModal({
    title: 'Revoke API key',
    content: [
      h('p', {}, 'Revoke ', h('code', {}, `${prefix}…`), ` for "${a.name}"? Any MCP client using it stops working right away. This is off-chain, so nothing needs signing.`),
      status,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => closeModal() }, 'Cancel'), yes),
    ],
  });
}

async function changeLimit(a) {
  const v = await promptAmount({
    title: `Change the limit of ${a.name}`,
    label: 'Daily limit',
    value: (a.limit && a.limit.installed && a.limit.limit) || '',
    help: 'Installs or updates the spending-limit policy on this agent\'s rule. Your wallet signs an authorization entry.',
    submitLabel: 'Continue',
    testid: 'limit-form',
  });
  if (!v) return;
  runOp({
    title: `Change the limit of ${a.name}`,
    prepare: () => api.setLimit(a.id, v),
    okText: () => `The daily limit of "${a.name}" is now ${fmtAmount(v)} USDC.`,
    after: () => refreshAll(),
  });
}

function revoke(a) {
  runOp({
    title: `Revoke ${a.name}`,
    prepare: () => api.revoke(a.id),
    okText: () => `"${a.name}" is revoked. Its signatures stop passing within a few seconds.`,
    after: () => refreshAll(),
  });
}

function restore(a) {
  runOp({
    title: `Restore ${a.name}`,
    prepare: () => api.restore(a.id),
    okText: () => `"${a.name}" is active again.`,
    after: () => refreshAll(),
  });
}

function addAgent(form) {
  const err = document.getElementById('add-agent-err');
  err.textContent = '';
  const name = form.elements.name.value.trim();
  const limit = normAmount(form.elements.daily_limit.value);
  const daysRaw = form.elements.valid_days.value.trim();
  if (!name) { err.textContent = 'Give the agent a name.'; form.elements.name.focus(); return; }
  if (name.length > 40) { err.textContent = 'Keep the name under 40 characters.'; form.elements.name.focus(); return; }
  if (!limit) { err.textContent = 'Enter a daily limit in USDC, e.g. 5 or 2.5.'; form.elements.daily_limit.focus(); return; }
  let days = null;
  if (daysRaw) {
    if (!/^\d+$/.test(daysRaw) || Number(daysRaw) < 1 || Number(daysRaw) > 3650) { err.textContent = 'Valid days must be a whole number from 1 to 3650, or empty for no expiry.'; form.elements.valid_days.focus(); return; }
    days = Number(daysRaw);
  }
  const body = { name, daily_limit: limit };
  if (days) body.valid_days = days;
  runOp({
    title: 'Add agent',
    prepare: async () => {
      const op = await api.addAgent(body);
      refreshAll(); // show the pending agent
      return op;
    },
    okText: () => `"${name}" is active with a ${fmtAmount(limit)} USDC daily limit.`,
    done: (resp, view) => {
      const r = resp.result || {};
      view.modal.setTitle('Agent added');
      form.reset();
      form.elements.daily_limit.value = '5';
      if (r.api_key) view.extra.replaceChildren(apiKeyReveal((r.agent && r.agent.name) || name, r.api_key));
    },
    after: () => refreshAll(),
  }).then((resp) => { if (!resp) refreshAll(); });
}

/* ---------- payments ---------- */

function renderFilter() {
  const sel = document.getElementById('payments-filter');
  const agents = state.agents || [];
  const want = ['', ...agents.map((a) => a.id)].join('|');
  if (sel.dataset.ids === want) return;
  sel.dataset.ids = want;
  sel.replaceChildren(h('option', { value: '' }, 'All agents'), ...agents.map((a) => h('option', { value: a.id }, a.name || a.id)));
  sel.value = agents.some((a) => a.id === state.payFilter) ? state.payFilter : '';
}

function renderPayments() {
  const el = document.getElementById('payments-list');
  const items = state.payments;
  if (!items) { el.replaceChildren(h('div', { class: 'state-box state-loading' }, h('span', { class: 'spinner' }), 'Loading…')); return; }
  if (!items.length) {
    el.replaceChildren(h('div', { class: 'empty-mini', 'data-testid': 'no-payments' }, state.payFilter ? 'No payments by this agent yet.' : 'No payments yet. Chat with an agent or connect one over MCP.'));
    return;
  }
  el.replaceChildren(h('ul', { class: 'pay-list', 'data-testid': 'payments' }, items.map((p) => payItem(p, { showAgent: !state.payFilter }))));
}

function renderPaymentsError(err) {
  document.getElementById('payments-list').replaceChildren(h('div', { class: 'res res-bad' }, icon(ICONS.alert), h('span', {}, `Could not load payments: ${describeError(err)}`)));
}
