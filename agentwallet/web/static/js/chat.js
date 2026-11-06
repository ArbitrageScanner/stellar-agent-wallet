// Chat view: agent picker, SSE streaming, tool cards, error cards, approvals,
// history restore and the selected agent's side panel. Conversation ids are
// kept per agent in localStorage (aw.conv.<agent_id>).

import { api, chatStream, describeError } from './api.js';
import { state, on, accountUrl, agentById, ledgerSeconds } from './state.js';
import { renderMarkdown } from './markdown.js';
import { refreshAll, expectUsdc, isSyncing, agentsSyncing } from './data.js';
import { statusBadge, limitGauge, payItem, addrLine, segBar } from './widgets.js';
import { h, icon, ICONS, short, fmtAmount, fmtApprox, fmtPeriod, plural, store, extLink, parseMaybeJSON, copyBtn, waitLine, SLOW_RPC } from './util.js';

const K_MODEL = 'aw.model';
const K_AGENT = 'aw.agent';
const convKey = (agentId) => `aw.conv.${agentId}`;

let log, emptyEl, chipsEl, suggestEl, apprBar, input, sendBtn, stopBtn, modelSel, agentSel, panel;
let agentId = null;          // agent the log belongs to
let conversationId = null;
let busy = false;
let modelsLoaded = false;
let panelPayments = null;    // recent payments of the selected agent
let panelKey = '';
let controller = null;
let lastUserText = '';
let stick = true;

export function initChat() {
  log = document.getElementById('chat-log');
  emptyEl = document.getElementById('empty-state');
  chipsEl = document.getElementById('chips');
  suggestEl = document.getElementById('suggest');
  apprBar = document.getElementById('appr-bar');
  input = document.getElementById('composer-input');
  sendBtn = document.getElementById('send-btn');
  stopBtn = document.getElementById('stop-btn');
  modelSel = document.getElementById('model-select');
  agentSel = document.getElementById('agent-select');
  panel = document.getElementById('agent-panel');

  document.getElementById('composer').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  input.addEventListener('input', autosize);
  stopBtn.addEventListener('click', stop);
  document.getElementById('new-chat').addEventListener('click', newChat);
  log.addEventListener('scroll', () => { stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80; }, { passive: true });
  modelSel.addEventListener('change', () => store.set(K_MODEL, modelSel.value));
  agentSel.addEventListener('change', () => selectAgent(agentSel.value));

  const wide = window.matchMedia('(min-width: 640px)');
  const setPh = () => { input.placeholder = wide.matches ? 'Message the agent… (Enter to send, Shift+Enter for a new line)' : 'Message the agent…'; };
  wide.addEventListener?.('change', setPh);
  setPh();
  renderChips();
  on('config', () => { renderChips(); updateLLMNotice(); });
  on('agents', () => { if (document.body.dataset.view === 'chat') syncAgents(); });
  on('sync', () => { if (document.body.dataset.view === 'chat') renderPanel(); });
  on('me', () => renderQuota());
  on('account', () => { if (document.body.dataset.view === 'chat') renderPanel(); });
}

/* ---------- agent selection ---------- */

/** Called when the chat view is shown (optionally for a given agent). */
export function showChat(wantAgent = null) {
  if (!modelsLoaded) { modelsLoaded = true; loadModels(); }
  const maxChars = state.config && state.config.limits && state.config.limits.chat_max_chars;
  if (maxChars > 0) input.maxLength = maxChars;
  renderQuota();
  if (wantAgent) state.chatAgent = wantAgent;
  syncAgents();
  if (!busy) input.focus({ preventScroll: true });
}

function syncAgents() {
  const agents = state.agents || [];
  const none = state.agents !== null && !agents.length;
  document.getElementById('chat-none').hidden = !none;
  document.querySelector('#view-chat .chat-layout').hidden = none;
  const ids = agents.map((a) => `${a.id}:${a.status}:${a.name}`).join('|');
  if (agentSel.dataset.ids !== ids) {
    agentSel.dataset.ids = ids;
    agentSel.replaceChildren(...agents.map((a) => h('option', { value: a.id }, a.status === 'active' ? a.name : `${a.name} (${a.status})`)));
  }
  let want = state.chatAgent || agentId || store.get(K_AGENT, null);
  if (!agents.some((a) => a.id === want)) want = (agents.find((a) => a.status === 'active') || agents[0] || {}).id || null;
  if (want && want !== agentId) selectAgent(want);
  else { if (want) agentSel.value = want; renderAgentState(); }
}

function selectAgent(id) {
  if (!id) return;
  if (id === agentId) { agentSel.value = id; renderAgentState(); return; }
  stop();
  agentId = id;
  state.chatAgent = id;
  store.set(K_AGENT, id);
  agentSel.value = id;
  clearLog();
  conversationId = store.get(convKey(id), null);
  panelPayments = null;
  panelKey = '';
  renderAgentState();
  loadPanelPayments();
  if (conversationId) restore(conversationId, id);
}

function renderAgentState() {
  const a = agentById(agentId);
  document.getElementById('empty-title').textContent = a ? `Chat with ${a.name}` : 'Chat with your agent';
  const notice = document.getElementById('agent-inactive-notice');
  if (a && a.status !== 'active') {
    notice.hidden = false;
    notice.replaceChildren(h('strong', {}, `"${a.name}" is ${a.status}.`), ' Its payments will be rejected with agent_inactive. ',
      a.status === 'pending' ? 'Finish adding it on the dashboard.' : 'Restore it on the dashboard.');
  } else {
    notice.hidden = true;
  }
  renderPanel();
}

async function loadPanelPayments() {
  const id = agentId;
  if (!id) return;
  try {
    const r = await api.payments({ agent: id, limit: 5 });
    if (id !== agentId) return;
    panelPayments = r.items || [];
  } catch {
    if (id !== agentId) return;
    panelPayments = panelPayments || null;
  }
  renderPanel();
}

function renderPanel() {
  const a = agentById(agentId);
  if (!a) { panel.replaceChildren(); panelKey = ''; return; }
  const acc = state.account;
  const bal = ((acc && acc.balances) || []).find((x) => /^usdc/i.test(x.asset || ''));
  const syncing = isSyncing();
  const key = JSON.stringify([a, bal, panelPayments, acc && acc.address, syncing, agentsSyncing()]);
  if (key === panelKey) return;
  panelKey = key;
  const pays = panelPayments;
  panel.replaceChildren(
    h('div', { class: 'w-card', 'data-testid': 'agent-panel' },
      h('div', { class: 'w-head' },
        h('div', { class: 'w-title' }, h('span', { 'data-testid': 'panel-agent-name' }, a.name), statusBadge(a.status)),
        h('div', { class: 'muted small' }, `Rule ${a.rule_id ?? '?'}, key `, h('code', { title: a.public_key }, short(a.public_key, 5, 5)))),
      limitGauge(a.limit, { at: state.agentsAt }),
      syncing ? h('div', { class: 'sync-note', 'data-testid': 'panel-syncing', role: 'status' }, h('span', { class: 'spinner' }),
        'Confirmed on-chain. Updating from Stellar RPC: the numbers here can lag a few seconds.') : null,
      h('div', { class: 'panel-acc' },
        h('span', { class: 'w-label' }, 'Agent wallet balance'),
        h('div', { class: 'w-balance' },
          h('div', { class: 'w-balance-num w-balance-sm', 'data-testid': 'balance' }, fmtAmount(bal ? bal.amount : 0)),
          h('div', { class: 'w-balance-unit' }, 'USDC')),
        acc ? addrLine(acc.address, acc.url || accountUrl(acc.address)) : null)),
    h('div', { class: 'w-section-static' },
      h('div', { class: 'w-section-head' }, h('span', {}, 'Recent payments'), h('a', { class: 'small', href: '#dashboard' }, 'All payments')),
      pays === null ? h('div', { class: 'muted small pad' }, 'Loading…')
        : !pays.length ? h('div', { class: 'empty-mini' }, 'No payments yet')
          : h('ul', { class: 'pay-list', 'data-testid': 'panel-payments' }, pays.map((p) => payItem(p, { showAgent: false })))));
}

function afterTx() {
  refreshAll();
  loadPanelPayments();
}

/** Drops everything (sign-out). */
export function resetChat() {
  stop();
  agentId = null;
  conversationId = null;
  panelPayments = null;
  panelKey = '';
  agentSel.replaceChildren();
  delete agentSel.dataset.ids;
  panel.replaceChildren();
  clearLog();
}

function clearLog() {
  for (const el of [...log.children]) if (el !== emptyEl) el.remove();
  emptyEl.hidden = false;
  hideSuggest();
  hideApprovalBar();
}

/* ---------- toolbar ---------- */

async function loadModels() {
  const cfg = state.config || {};
  const fallback = cfg.default_model || 'openai/gpt-4o-mini';
  let items = [], def = fallback;
  try {
    const r = await api.models();
    items = Array.isArray(r.items) ? r.items : [];
    def = r.default || fallback;
  } catch { /* fall back to default_model */ }
  const saved = store.get(K_MODEL, null);
  if (!items.some((m) => m.id === def)) items.unshift({ id: def, name: def });
  items.sort((a, b) => (a.id === def ? -1 : b.id === def ? 1 : (a.name || a.id).localeCompare(b.name || b.id)));
  modelSel.replaceChildren(...items.map((m) => h('option', { value: m.id, title: m.id }, m.name && m.name !== m.id ? `${m.name}` : m.id)));
  modelSel.value = saved && items.some((m) => m.id === saved) ? saved : def;
  modelSel.title = modelSel.value;
}

export function reloadModels() { loadModels(); }

function updateLLMNotice() {
  const cfg = state.config;
  document.getElementById('llm-notice').hidden = !cfg || cfg.llm_configured !== false;
}

function chipDefs() {
  const payee = (state.config && state.config.demo_payee) || '';
  const p = payee ? short(payee) : '…';
  return [
    { key: 'balance', label: 'How much money do I have?', text: 'How much money do I have?' },
    { key: 'pay1', label: `Pay 1 USDC to ${p}`, text: `Pay 1 USDC to ${payee}`, needsPayee: true, payee },
    { key: 'pay10', label: `Pay 10 USDC to ${p}`, text: `Pay 10 USDC to ${payee}`, hint: 'over limit', needsPayee: true, payee },
    { key: 'pay3', label: `Pay 3 USDC to ${p}`, text: `Pay 3 USDC to ${payee}`, hint: 'needs approval', needsPayee: true, payee },
    { key: 'why', label: 'Why did the payment fail?', text: 'Why did the payment fail?' },
    { key: 'history', label: 'Show payment history', text: 'Show payment history' },
  ];
}

function chipButton(c) {
  return h('button', {
    class: 'chip', type: 'button', disabled: !c.payee && c.needsPayee ? true : null,
    onClick: () => send(c.text),
  }, c.label, c.hint ? h('span', { class: 'chip-hint' }, c.hint) : null);
}

function renderChips() {
  chipsEl.replaceChildren(...chipDefs().map(chipButton));
}

/* What to suggest after a turn, by how it ended (Turn.outcome). */
const NEXT = {
  limit: ['why', 'pay1', 'balance'],
  paid: ['history', 'balance', 'pay10'],
  rejected: ['pay1', 'balance', 'history'],
  inactive: ['history', 'balance'],
  error: ['balance', 'history'],
};
const NEXT_DEFAULT = ['balance', 'pay1', 'pay10', 'pay3', 'history'];

/** The row of suggested next messages above the composer. */
function renderSuggest(outcome = null) {
  const keys = NEXT[outcome] || NEXT_DEFAULT;
  const defs = chipDefs()
    .filter((c) => keys.includes(c.key) && c.text !== lastUserText && !(c.needsPayee && !c.payee))
    .sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key))
    .slice(0, 3);
  suggestEl.replaceChildren(h('span', { class: 'suggest-label' }, 'Try next'), ...defs.map(chipButton));
  suggestEl.hidden = !defs.length;
}

const hideSuggest = () => { suggestEl.hidden = true; };

/* ---------- the pending-approval bar above the composer ---------- */

let barOwner = null;
const BASE_TITLE = document.title;

function showApprovalBar(ap) {
  barOwner = ap;
  apprBar.replaceChildren(...ap.barNodes);
  apprBar.hidden = false;
  document.title = `Approval needed: ${BASE_TITLE}`;
}

function hideApprovalBar(ap = null) {
  if (ap && ap !== barOwner) return;
  barOwner = null;
  apprBar.hidden = true;
  apprBar.replaceChildren();
  document.title = BASE_TITLE;
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function setBusy(b) {
  busy = b;
  sendBtn.hidden = b;
  stopBtn.hidden = !b;
  log.setAttribute('aria-busy', String(b));
  document.body.classList.toggle('chat-busy', b);
}

function submit() {
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = '';
  autosize();
  send(text);
}

function stop() { if (controller) controller.abort(); }

function newChat() {
  stop();
  conversationId = null;
  if (agentId) store.del(convKey(agentId));
  clearLog();
  input.focus();
}

function scrollDown(force = false) {
  if (force || stick) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

/* ---------- sending ---------- */

export async function send(text) {
  if (busy) return;
  if (!agentId) return;
  const forAgent = agentId;
  lastUserText = text;
  emptyEl.hidden = true;
  hideSuggest();
  log.append(userBubble(text));
  const turn = new Turn();
  log.append(turn.el);
  stick = true;
  scrollDown(true);
  setBusy(true);
  controller = new AbortController();
  let gotDone = false, gotError = false;
  try {
    const body = { agent_id: forAgent, message: text, model: modelSel.value || undefined };
    if (conversationId) body.conversation_id = conversationId;
    for await (const { event, data } of chatStream(body, controller.signal)) {
      switch (event) {
        case 'conversation':
          if (data && data.id) { conversationId = data.id; store.set(convKey(forAgent), data.id); }
          break;
        case 'text_delta': turn.text(data.text || ''); break;
        case 'tool_call': turn.toolCall(data); break;
        case 'tool_result':
          turn.toolResult(data);
          if (data && data.ok && data.name === 'pay' && data.result && Number(data.result.amount) > 0 && !data.result.duplicate) {
            expectUsdc({ account: -Number(data.result.amount), agents: true });
          }
          break;
        case 'tx': turn.tx(data); afterTx(); break;
        case 'approval_required': turn.approval(data); break;
        case 'approval_resolved': turn.approvalResolved(data); break;
        case 'error': gotError = true; turn.fatal(data.message || 'Error', () => retry()); break;
        case 'done':
          gotDone = true;
          if (data && data.usage && state.me) { state.me.chat = data.usage; renderQuota(); }
          break;
        default: break;
      }
      scrollDown();
    }
    if (!gotDone && !gotError) turn.fatal('The response was cut off. The server may have restarted.', () => retry());
  } catch (err) {
    if (err && err.name === 'AbortError') turn.note('Stopped', 'stopped');
    else if (err && err.status === 404 && conversationId) {
      conversationId = null;
      store.del(convKey(forAgent));
      turn.fatal('Conversation not found on the server. Start a new one.', () => retry());
    } else if (err && err.status === 401) {
      turn.fatal('Your session has ended. Sign in again.', null);
    } else if (err && err.code === 'daily_limit_reached') {
      if (state.me && state.me.chat) { state.me.chat.used = state.me.chat.limit; renderQuota(); }
      turn.fatal(err.message, null);
    } else turn.fatal(err && err.message ? err.message : String(err), () => retry());
  } finally {
    turn.finish();
    controller = null;
    setBusy(false);
    if (forAgent === agentId && turn.el.isConnected) renderSuggest(turn.outcome);
    scrollDown();
    if (state.session) afterTx();
  }
}

function retry() { if (!busy && lastUserText) send(lastUserText); }

/** "N of 50 messages left today" under the composer. */
function renderQuota() {
  const el = document.getElementById('chat-quota');
  const q = state.me && state.me.chat;
  if (!el) return;
  if (!q || !(q.limit > 0)) { el.hidden = true; return; }
  const left = Math.max(0, q.limit - (q.used || 0));
  const reset = q.resets_at ? new Date(q.resets_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
  el.hidden = false;
  el.classList.toggle('is-out', left === 0);
  el.textContent = left === 0
    ? `Daily chat limit reached (${q.limit} messages). It resets at ${reset}. Agents can still pay over MCP.`
    : `${left} of ${q.limit} ${plural(q.limit, 'message')} left today`;
}

function userBubble(text) {
  return h('div', { class: 'msg msg-user' }, h('div', { class: 'bubble' }, text));
}

/* ---------- restore ---------- */

async function restore(id, forAgent) {
  const loading = h('div', { class: 'state-box' }, waitLine('Loading conversation…', [[6_000, SLOW_RPC]]));
  emptyEl.hidden = true;
  log.append(loading);
  try {
    const conv = await api.conversation(id);
    loading.remove();
    if (forAgent !== agentId) return; // the user switched agents meanwhile
    if (conv && conv.agent_id && conv.agent_id !== forAgent) {
      conversationId = null;
      store.del(convKey(forAgent));
      emptyEl.hidden = false;
      return;
    }
    const msgs = (conv && conv.messages) || [];
    if (!msgs.length) { emptyEl.hidden = false; return; }
    let turn = null;
    for (const m of msgs) {
      if (m.role === 'user') {
        turn = null;
        log.append(userBubble(m.content || ''));
      } else if (m.role === 'assistant') {
        if (!turn) { turn = new Turn(true); log.append(turn.el); }
        if (m.content) { turn.text(m.content); turn.seal(); }
        for (const tc of m.tool_calls || []) turn.toolCall(normalizeToolCall(tc));
      } else if (m.role === 'tool') {
        if (!turn) { turn = new Turn(true); log.append(turn.el); }
        turn.toolResult(normalizeToolMessage(m), true);
      }
    }
    for (const el of log.querySelectorAll('.turn')) el.__turn?.finish(true);
    renderSuggest(null);
    scrollDown(true);
  } catch (err) {
    loading.remove();
    if (forAgent !== agentId) return;
    if (err && (err.status === 404 || err.status === 403)) {
      conversationId = null;
      store.del(convKey(forAgent));
      emptyEl.hidden = false;
      return;
    }
    if (err && err.status === 401) return;
    const box = h('div', { class: 'state-box state-error' },
      icon(ICONS.alert),
      h('div', { class: 'state-title' }, 'Could not load the conversation'),
      h('div', { class: 'state-text' }, err.message || String(err)),
      h('div', { class: 'row-gap' },
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => { box.remove(); restore(id, forAgent); } }, icon(ICONS.retry), 'Retry'),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => { box.remove(); newChat(); } }, 'New chat')));
    log.append(box);
  }
}

function normalizeToolCall(tc) {
  // Accept both {id, name, arguments} and OpenAI's {id, function: {name, arguments}}.
  const fn = tc.function || {};
  return { id: tc.id, name: tc.name || fn.name, arguments: tc.arguments ?? fn.arguments };
}

function normalizeToolMessage(m) {
  const c = parseMaybeJSON(m.content);
  if (c && typeof c === 'object' && !Array.isArray(c) && 'ok' in c) {
    return { id: m.tool_call_id, name: m.name, ok: !!c.ok, result: c.result ?? null, error: c.error ?? null };
  }
  if (c && typeof c === 'object' && c.error && typeof c.error === 'object' && c.error.code) {
    return { id: m.tool_call_id, name: m.name, ok: false, result: null, error: c.error };
  }
  return { id: m.tool_call_id, name: m.name, ok: true, result: c, error: null };
}

/* ---------- a single assistant turn ---------- */

class Turn {
  constructor(restored = false) {
    this.restored = restored;
    this.body = h('div', { class: 'turn-body' });
    this.typing = h('div', { class: 'typing', 'aria-label': 'Agent is thinking' }, h('span'), h('span'), h('span'));
    if (!restored) {
      // Explain long waits next to the typing dots, only while nothing else explains them.
      const note = (text) => {
        if (!this.typing.isConnected) return;
        const n = this.typing.querySelector('.typing-note') || this.typing.appendChild(h('span', { class: 'typing-note' }));
        n.textContent = text;
      };
      setTimeout(() => { if (!this.md && !this.cards.size) note('The model is thinking…'); }, 6_000);
      setTimeout(() => note('Still working. Model replies and on-chain calls on Stellar testnet can take up to a minute.'), 25_000);
    }
    this.el = h('div', { class: 'msg msg-assistant turn' },
      this.body);
    this.el.__turn = this;
    if (!restored) this.body.append(this.typing);
    this.md = null;       // current markdown block
    this.mdText = '';
    this.raf = 0;
    this.cards = new Map(); // tool_call_id -> ToolCard
    this.approvals = new Map(); // approval_id -> Approval
  }

  place(node) {
    if (this.typing.isConnected) this.body.insertBefore(node, this.typing);
    else this.body.append(node);
  }

  text(t) {
    if (!t) return;
    if (!this.md) {
      this.md = h('div', { class: 'md' });
      this.mdText = '';
      this.place(this.md);
    }
    this.mdText += t;
    if (this.restored) { this.md.innerHTML = renderMarkdown(this.mdText); return; }
    this.md.classList.add('streaming');
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        if (this.md) this.md.innerHTML = renderMarkdown(this.mdText);
        scrollDown();
      });
    }
  }

  /** Ends the current text block so the next text starts below any cards. */
  seal() {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    if (this.md) { this.md.innerHTML = renderMarkdown(this.mdText); this.md.classList.remove('streaming'); }
    this.md = null;
  }

  toolCall(d) {
    this.seal();
    const card = new ToolCard(d);
    this.cards.set(d.id, card);
    this.place(card.el);
  }

  toolResult(d, restored = false) {
    let card = this.cards.get(d.id);
    if (!card) {
      card = new ToolCard({ id: d.id, name: d.name, arguments: null });
      this.cards.set(d.id, card);
      this.place(card.el);
    }
    card.setResult(d);
    if (d.ok === false || d.error) this.outcome = OUTCOME[(d.error && d.error.code) || ""] || "error";
    if (restored && d.ok && d.result && d.result.hash && d.result.url) this.tx({ hash: d.result.hash, url: d.result.url, status: d.result.status || 'SUCCESS' });
  }

  tx(d) {
    this.seal();
    const ok = d.status === 'SUCCESS';
    if (ok) this.outcome = "paid";
    const pending = !ok && d.status !== 'FAILED';
    this.place(h('div', { class: `tx-card ${ok ? 'ok' : pending ? 'pending' : 'bad'}`, 'data-testid': 'tx' },
      icon(ICONS.chain),
      h('span', { class: 'tx-label' }, ok ? 'Transaction on-chain' : pending ? `Transaction ${d.status || 'submitted'}` : 'Transaction failed'),
      h('code', { class: 'tx-hash', title: d.hash }, short(d.hash, 8, 6)),
      copyBtn(d.hash, 'Copy hash'),
      extLink(d.url, 'stellar.expert', 'tx-link')));
  }

  approval(d) {
    this.seal();
    const ap = new Approval(d);
    this.approvals.set(d.approval_id, ap);
    const card = this.cards.get(d.tool_call_id);
    if (card) card.attachApproval(ap);
    else this.place(ap.el);
  }

  approvalResolved(d) {
    if (d.approved === false) this.outcome = "rejected";
    const ap = this.approvals.get(d.approval_id);
    if (ap) ap.resolved(d.approved);
  }

  fatal(message, onRetry) {
    this.seal();
    this.place(h('div', { class: 'err-card err-fatal', role: 'alert' },
      h('div', { class: 'err-title' }, icon(ICONS.alert), h('span', { class: 'err-title-text' }, 'Turn interrupted')),
      h('div', { class: 'err-text' }, message),
      onRetry ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: onRetry }, icon(ICONS.retry), 'Retry') : null));
  }

  note(text, cls = '') {
    this.seal();
    this.place(h('div', { class: `turn-note ${cls}` }, text));
  }

  finish(restored = false) {
    this.seal();
    this.typing.remove();
    for (const c of this.cards.values()) c.finish(restored);
    for (const a of this.approvals.values()) a.finish();
    if (!this.body.children.length) this.body.append(h('div', { class: 'turn-note' }, 'Empty response'));
  }
}

const OUTCOME = { spending_limit_exceeded: "limit", agent_inactive: "inactive", rejected_by_user: "rejected" };

/* ---------- tool card ---------- */

const TOOL_LABEL = {
  wallet_info: 'Wallet',
  simulate_payment: 'Payment simulation',
  pay: 'Payment',
  payment_history: 'Payment history',
};

function argsOf(d) {
  const a = parseMaybeJSON(d.arguments);
  return a && typeof a === 'object' ? a : {};
}

function callTitle(name, args) {
  const parts = [h('span', { class: 'arrow' }, '→ '), h('b', {}, name || 'tool')];
  if ((name === 'pay' || name === 'simulate_payment') && (args.amount || args.to)) {
    parts.push(h('span', { class: 'sep' }, ', '), `${fmtAmount(args.amount)} USDC`);
    if (args.to) parts.push(h('span', { class: 'sep' }, ' → '), h('code', { title: args.to }, short(args.to)));
  } else if (name === 'payment_history' && args.limit) {
    parts.push(h('span', { class: 'sep' }, ', '), `last ${args.limit}`);
  }
  return parts;
}

function resultSummary(name, r) {
  if (r === null || r === undefined) return 'Done';
  if (typeof r !== 'object') return String(r).slice(0, 160);
  const balances = r.balances || (r.wallet && r.wallet.balances);
  const lim = r.limit || (r.wallet && r.wallet.limit);
  if (name === 'wallet_info' || balances) {
    const b = Array.isArray(balances) ? balances.find((x) => /usdc/i.test(x.asset || '')) || balances[0] : null;
    const bits = [];
    if (b) bits.push(`Balance ${fmtAmount(b.amount)} ${b.asset || 'USDC'}`);
    else if (r.balance_usdc !== undefined) bits.push(`Balance ${fmtAmount(r.balance_usdc)} USDC`);
    else if (r.balance !== undefined) bits.push(`Balance ${fmtAmount(r.balance)} USDC`);
    if (lim && lim.installed) bits.push(`${fmtAmount(lim.remaining)} of ${fmtAmount(lim.limit)} remaining`);
    const sl = r.spending_limit;
    if (sl && typeof sl === 'object') bits.push(`${fmtAmount(sl.remaining_usdc)} of ${fmtAmount(sl.limit_usdc)} remaining`);
    if ((r.agent && r.agent.active === false) || r.agent_active === false) bits.push('agent revoked');
    if (bits.length) return bits.join(', ');
  }
  const list = r.payments || r.items;
  if (name === 'payment_history' || Array.isArray(list)) {
    const n = (list || []).length;
    const failed = (list || []).filter((x) => x.status === 'FAILED').length;
    return `${n} ${plural(n, 'payment')}${failed ? `, ${failed} failed` : ''}`;
  }
  if (name === 'simulate_payment') {
    return r.would_succeed === false || r.ok === false ? 'Simulation: the payment would fail' : 'Simulation passed: the payment would go through';
  }
  if (name === 'pay' || r.hash) {
    const amt = r.amount ? `${fmtAmount(r.amount)} ${r.asset || 'USDC'}` : 'Payment';
    return `${amt} sent${r.ledger ? `, ledger ${r.ledger}` : ''}`;
  }
  return 'Done';
}

function jsonDetails(label, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return h('details', { class: 'json' },
    h('summary', {}, label),
    h('div', { class: 'json-wrap' }, h('pre', {}, text), copyBtn(text, 'Copy JSON')));
}

class ToolCard {
  constructor(d) {
    this.id = d.id;
    this.name = d.name;
    this.args = argsOf(d);
    this.done = false;
    this.ico = h('span', { class: 'tool-ico' }, h('span', { class: 'spinner' }));
    this.stateEl = h('span', { class: 'tool-state' }, 'running…');
    this.summary = h('div', { class: 'tool-summary', hidden: true });
    this.extra = h('div', { class: 'tool-extra' });
    this.jsons = h('div', { class: 'tool-jsons' }, d.arguments !== null && d.arguments !== undefined ? jsonDetails('Arguments', this.args) : null);
    this.el = h('div', { class: 'tool-card', dataset: { status: 'running', tool: d.name || '', callId: d.id || '' }, 'data-testid': 'tool-card' },
      h('div', { class: 'tool-head' },
        this.ico,
        h('span', { class: 'tool-title', title: TOOL_LABEL[d.name] || d.name }, callTitle(d.name, this.args)),
        this.stateEl),
      this.summary, this.extra, this.jsons);
    // A tool that runs for a while gets a line on what it is waiting for.
    const onChain = d.name === 'pay';
    setTimeout(() => {
      if (this.done || this.el.dataset.status !== 'running') return;
      this.summary.hidden = false;
      this.summary.classList.add('tool-wait');
      this.summary.textContent = onChain
        ? 'Sending the payment on-chain: simulate, sign, submit, then wait for the ledger. Usually 5 to 15 seconds on testnet.'
        : 'Reading from Stellar testnet RPC…';
    }, onChain ? 3_000 : 5_000);
  }

  setResult(d) {
    this.done = true;
    this.summary.classList.remove('tool-wait');
    if (d.name && !this.name) this.name = d.name;
    const ok = d.ok !== false && !d.error;
    this.el.dataset.status = ok ? 'ok' : 'error';
    this.ico.replaceChildren(icon(ok ? ICONS.check : ICONS.cross));
    this.stateEl.textContent = ok ? 'done' : 'error';
    if (ok) {
      this.summary.hidden = false;
      this.summary.textContent = resultSummary(this.name, d.result);
    } else {
      this.summary.hidden = true;
      this.extra.append(errorCard(d.error || { code: 'unknown', message: 'The tool returned an error' }, this.args));
    }
    this.jsons.append(jsonDetails(ok ? 'Result' : 'Error', ok ? d.result : d.error));
  }

  attachApproval(ap) { this.extra.append(ap.el); this.stateEl.textContent = 'awaiting approval'; this.el.dataset.status = 'waiting'; }

  finish(restored) {
    if (this.done) return;
    this.el.dataset.status = restored ? 'unknown' : 'aborted';
    this.ico.replaceChildren(icon(ICONS.cross));
    this.stateEl.textContent = restored ? 'no result' : 'interrupted';
  }
}

/* ---------- error cards ---------- */

const ERR_TITLES = {
  spending_limit_exceeded: 'Payment rejected by the smart account',
  insufficient_balance: 'Not enough USDC in the wallet',
  agent_inactive: 'Agent access revoked',
  rejected_by_user: 'You rejected the payment',
  invalid_argument: 'Invalid parameters',
  rpc_error: 'Stellar RPC error',
  tx_failed: 'Transaction failed',
};

function errorCard(err, args = {}) {
  const code = err.code || 'error';
  const det = err.details || {};
  const title = ERR_TITLES[code] || 'Tool error';
  const kind = code === 'rejected_by_user' ? 'err-muted' : code === 'spending_limit_exceeded' ? 'err-limit' : 'err-generic';
  const el = h('div', { class: `err-card ${kind}`, role: 'group', 'data-code': code, 'data-testid': 'err-card' });
  // The limit refusal is shown on the agent's own LCD; every other error is a plain card.
  const body = code === 'spending_limit_exceeded' ? h('div', { class: 'lcd' }) : el;
  if (body !== el) el.append(body);
  body.append(h('div', { class: 'err-title' }, icon(code === 'spending_limit_exceeded' ? ICONS.shield : ICONS.alert), h('span', { class: 'err-title-text' }, title),
    h('code', { class: 'err-code' }, code)));

  if (code === 'spending_limit_exceeded') {
    const a = agentById(agentId);
    const period = fmtPeriod((a && a.limit && a.limit.period_ledgers) || (state.config && state.config.period_ledgers), ledgerSeconds());
    const bits = [`Limit ${fmtAmount(det.limit)} USDC/${period}`, `spent ${fmtAmount(det.spent)}`, `remaining ${fmtAmount(det.remaining)}`];
    const r = fmtApprox(det.resets_in_seconds);
    if (r) bits.push(`resets in ${r}`);
    body.append(h('div', { class: 'err-main', 'data-testid': 'limit-line' }, bits.join(', ')));
    const limit = Number(det.limit) || 0, spent = Number(det.spent) || 0, req = Number(det.requested ?? args.amount) || 0;
    if (limit > 0) body.append(segBar(spent, limit, { over: req, label: 'Spent, and the refused request past the stop' }));
    body.append(h('div', { class: 'err-text' },
      `Requested ${fmtAmount(det.requested ?? args.amount)} USDC. The spending-limit policy rejected the agent's signature in __check_auth (Error(Contract, #3221)); no funds were moved.`));
  } else if (code === 'insufficient_balance') {
    el.append(h('div', { class: 'err-main' }, `Balance ${fmtAmount(det.balance)} USDC, requested ${fmtAmount(det.requested ?? args.amount)} USDC`));
    el.append(h('div', { class: 'err-text' }, 'Fund your agent wallet from the dashboard (Add funds).'));
  } else if (code === 'agent_inactive') {
    el.append(h('div', { class: 'err-text' }, err.message || 'The agent rule has expired or was revoked.'),
      h('div', { class: 'err-text muted' }, 'You can restore the agent on the dashboard.'));
  } else if (code === 'rejected_by_user') {
    el.append(h('div', { class: 'err-text' }, err.message || 'The payment was not sent.'));
  } else {
    el.append(h('div', { class: 'err-text' }, err.message || 'No details.'));
  }
  return el;
}

/* ---------- approvals ---------- */

class Approval {
  constructor(d) {
    this.d = d;
    this.state = 'pending';
    this.status = h('div', { class: 'appr-status', 'aria-live': 'polite' });
    this.yes = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: () => this.decide(true) }, icon(ICONS.check), 'Approve');
    this.no = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => this.decide(false) }, icon(ICONS.cross), 'Reject');
    this.buttons = h('div', { class: 'appr-buttons' }, this.yes, this.no);
    const thr = state.config && state.config.approval_threshold;
    this.el = h('div', { class: 'approval', 'data-state': 'pending', 'data-testid': 'approval' },
      h('div', { class: 'appr-head' }, icon(ICONS.hand), h('b', {}, 'Your approval is needed')),
      h('div', { class: 'appr-summary' }, d.summary || `Transfer ${fmtAmount(d.amount)} ${d.asset || 'USDC'}`),
      h('div', { class: 'appr-facts' },
        h('span', {}, 'Amount ', h('b', {}, `${fmtAmount(d.amount)} ${d.asset || 'USDC'}`)),
        d.to ? h('span', {}, 'Recipient ', extLink(accountUrl(d.to), short(d.to, 5, 5), 'mono-link')) : null,
        thr ? h('span', { class: 'muted' }, `approval threshold ${fmtAmount(thr)} USDC`) : null),
      this.buttons, this.status);
    const who = (agentById(agentId) || {}).name || "The agent";
    this.barNodes = [
      h("span", { class: "led", "aria-hidden": "true" }),
      h("div", { class: "appr-bar-text" }, h("b", {}, `${who} is waiting for your approval. `), d.summary || `Transfer ${fmtAmount(d.amount)} ${d.asset || "USDC"}`),
      h("button", { class: "linkish", type: "button", onClick: () => this.el.scrollIntoView({ block: "center", behavior: "smooth" }) }, "Show details"),
      h("div", { class: "appr-buttons" },
        h("button", { class: "btn btn-primary btn-sm", type: "button", "data-testid": "approval-bar-approve", onClick: () => this.decide(true) }, icon(ICONS.check), "Approve"),
        h("button", { class: "btn btn-sm", type: "button", "data-testid": "approval-bar-reject", onClick: () => this.decide(false) }, icon(ICONS.cross), "Reject")),
    ];
    showApprovalBar(this);
  }

  async decide(approve) {
    if (this.state !== "pending") return;
    this.state = "sending";
    this.yes.disabled = this.no.disabled = true;
    hideApprovalBar(this);
    this.status.replaceChildren(h('span', { class: 'spinner' }), approve ? ' Sending approval…' : ' Sending rejection…');
    try {
      await api.approve(conversationId, this.d.approval_id, approve);
      if (this.state === 'sending') {
        this.state = 'sent';
        this.status.replaceChildren(h('span', { class: 'spinner' }), approve ? ' Approved, the agent is sending the payment…' : ' Rejected, waiting for the agent…');
      }
    } catch (err) {
      this.state = 'pending';
      this.yes.disabled = this.no.disabled = false;
      showApprovalBar(this);
      this.status.replaceChildren(h('span', { class: 'bad' }, `Could not send the decision: ${describeError(err)}`));
    }
  }

  resolved(approved) {
    this.state = 'resolved';
    hideApprovalBar(this);
    this.el.dataset.state = approved ? 'approved' : 'rejected';
    this.buttons.remove();
    this.status.replaceChildren(icon(approved ? ICONS.check : ICONS.cross), approved ? ' Approved' : ' Rejected');
  }

  finish() {
    if (this.state === 'resolved') return;
    this.state = 'resolved';
    hideApprovalBar(this);
    this.el.dataset.state = 'expired';
    this.buttons.remove();
    this.status.replaceChildren('This request is no longer active');
  }
}
