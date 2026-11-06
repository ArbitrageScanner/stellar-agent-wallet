// Shared UI pieces: agent status badge, limit gauge, payment rows, API key
// reveal (shown once) with MCP connect snippets, and a 1 s countdown ticker.

import { state, ledgerSeconds } from './state.js';
import { h, icon, ICONS, short, fmtAmount, fmtCountdown, fmtPeriod, fmtRelTime, copyBtn, copyText, toast, extLink, slug } from './util.js';

const STATUS = {
  active: { cls: 'badge-ok', label: 'active' },
  pending: { cls: 'badge-warn', label: 'pending' },
  revoked: { cls: 'badge-bad', label: 'revoked' },
  expired: { cls: 'badge-muted', label: 'expired' },
};

export function statusBadge(status) {
  const s = STATUS[status] || { cls: '', label: status || 'unknown' };
  return h('span', { class: `badge ${s.cls}`, 'data-testid': 'agent-status', dataset: { status: status || '' } }, h('span', { class: 'dot' }), s.label);
}

const SEGMENTS = 20;

/**
 * The LCD segment bar: `spent` of `limit` as lit segments, `over` (a refused
 * request beyond the limit) as hatched ones, and a hard stop at the right end.
 */
export function segBar(spent, limit, { over = 0, label = 'Spent of the limit' } = {}) {
  const lim = Number(limit) || 0;
  const sp = Number(spent) || 0;
  const on = lim > 0 ? Math.min(SEGMENTS, Math.round((sp / lim) * SEGMENTS)) : SEGMENTS;
  const ov = lim > 0 ? Math.min(SEGMENTS - on, Math.ceil(((Number(over) || 0) / lim) * SEGMENTS)) : 0;
  const cells = [];
  for (let i = 0; i < SEGMENTS; i++) cells.push(h('i', { class: i < on ? 'on' : i < on + ov ? 'over' : null }));
  return h('div', {
    class: 'seg', role: 'progressbar', 'aria-label': label,
    'aria-valuemin': '0', 'aria-valuemax': String(lim), 'aria-valuenow': String(sp),
  }, cells);
}

/** The agent's limit as a small LCD: what is left today, the segment bar with its stop, spent / limit and the reset. */
export function limitGauge(lim, { at = Date.now() } = {}) {
  lim = lim || {};
  if (!lim.installed) {
    return h('div', { class: 'w-limit w-limit-none', 'data-testid': 'limit' },
      icon(ICONS.alert),
      h('div', {}, h('b', {}, 'No limit installed.'), ' This agent can spend the whole account balance. Set a daily limit.'));
  }
  const limit = Number(lim.limit) || 0;
  const spent = Number(lim.spent) || 0;
  const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 100;
  const level = pct >= 100 ? 'full' : pct >= 70 ? 'high' : 'ok';
  const period = fmtPeriod(lim.period_ledgers, ledgerSeconds());
  const resets = lim.resets_in_seconds;
  return h('div', { class: `w-limit lcd lvl-${level}`, 'data-testid': 'limit' },
    h('div', { class: 'lcd-row' },
      h('span', { class: 'w-label' }, period === 'day' ? 'left today' : `left this ${period}`),
      h('span', { class: 'w-limit-nums', 'data-testid': 'limit-nums' }, h('b', {}, fmtAmount(lim.spent)), ` / ${fmtAmount(lim.limit)} USDC`)),
    h('div', { 'data-testid': 'remaining', class: 'w-remaining' },
      h('span', { class: 'lcd-num' }, fmtAmount(lim.remaining)), h('span', { class: 'lcd-unit' }, ' USDC')),
    segBar(spent, limit),
    h('div', { class: 'w-limit-bottom' },
      h('span', {}, level === 'full' ? 'at the stop' : `limit ${fmtAmount(lim.limit)} a ${period}`),
      h('span', {}, resets === null || resets === undefined
        ? 'nothing spent yet'
        : ['resets in ', countdown(resets, at)])));
}

export function countdown(seconds, at = Date.now()) {
  return h('span', { 'data-countdown': String(seconds), 'data-at': String(at) }, fmtCountdown(seconds));
}

setInterval(() => {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-countdown]')) {
    const left = Number(el.dataset.countdown) - (now - Number(el.dataset.at || now)) / 1000;
    el.textContent = fmtCountdown(left);
  }
}, 1000);

const ERR_SHORT = {
  spending_limit_exceeded: 'refused, over the limit',
  insufficient_balance: 'low balance',
  agent_inactive: 'agent inactive',
  rejected_by_user: 'rejected',
  tx_failed: 'tx failed',
  rpc_error: 'RPC error',
};

/** One payment row. showAgent: include the agent name tag. */
export function payItem(p, { showAgent = true } = {}) {
  const ok = p.status === 'SUCCESS';
  const reason = !ok && p.error ? (ERR_SHORT[p.error.code] || p.error.code) : null;
  return h('li', { class: `pay ${ok ? 'ok' : 'bad'}`, 'data-testid': 'payment', dataset: { agent: p.agent_id || '' } },
    h('span', { class: 'pay-ico', 'aria-label': ok ? 'succeeded' : 'failed' }, icon(ok ? ICONS.check : ICONS.cross)),
    h('div', { class: 'pay-main' },
      h('div', { class: 'pay-line' },
        h('b', {}, `${fmtAmount(p.amount)} ${p.asset || 'USDC'}`),
        h('span', { class: 'muted' }, ' to '),
        h('span', { title: p.to }, short(p.to))),
      h('div', { class: 'pay-sub muted' },
        showAgent && p.agent_name ? h('span', { title: p.agent_id }, p.agent_name) : null,
        p.source ? h('span', { class: 'tag tag-soft' }, p.source === 'mcp' ? 'MCP' : p.source) : null,
        h('span', {}, fmtRelTime(p.created_at) || (p.ledger ? `ledger ${p.ledger}` : '')),
        reason ? h('span', { class: 'pay-reason', title: (p.error && p.error.message) || '' }, reason) : null)),
    p.url ? extLink(p.url, '', 'icon-btn icon-btn-sm ext-only') : h('span', { class: 'icon-btn-sm' }));
}

/* ---------- API key reveal + MCP snippets ---------- */

export function mcpUrl() {
  return new URL('mcp', document.baseURI).href;
}

export function mcpSnippets(agentName, key) {
  const name = slug(agentName);
  const url = mcpUrl();
  const cli = `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer ${key}"`;
  const cfg = JSON.stringify({ mcpServers: { [name]: { type: 'http', url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
  return { name, url, cli, json: cfg };
}

export function codeBlock(text, label, testid) {
  return h('div', { class: 'codeblock', 'data-testid': testid || null },
    h('pre', {}, h('code', {}, text)), copyBtn(text, label || 'Copy'));
}

/** The "shown once" API key panel with copy and the MCP connect snippets. */
export function apiKeyReveal(agentName, key) {
  const s = mcpSnippets(agentName, key);
  return h('div', { class: 'key-reveal', 'data-testid': 'api-key-reveal' },
    h('div', { class: 'key-warn' }, icon(ICONS.key),
      h('span', {}, h('b', {}, 'Copy this API key now.'), ' It is shown only once; the server keeps only its hash.')),
    h('div', { class: 'key-box' },
      h('code', { 'data-testid': 'api-key' }, key),
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-testid': 'copy-key', onClick: (e) => copyFrom(e.currentTarget, key) }, icon(ICONS.copy), 'Copy key')),
    h('div', { class: 'key-section' },
      h('div', { class: 'key-label' }, 'Connect Claude Code'),
      codeBlock(s.cli, 'Copy command', 'mcp-cli')),
    h('details', { class: 'json key-json' },
      h('summary', {}, '.mcp.json for any MCP client'),
      codeBlock(s.json, 'Copy .mcp.json', 'mcp-json')),
    h('p', { class: 'muted small' }, 'The key acts only for this agent and only within its on-chain limit. Revoke it any time under API keys.'));
}

async function copyFrom(btn, text) {
  const ok = await copyText(text);
  toast(ok ? 'Copied' : 'Could not copy', ok ? '' : 'bad');
  if (ok) { btn.classList.add('done'); setTimeout(() => btn.classList.remove('done'), 1200); }
}

export const shortAddr = (a) => short(a, 5, 5);

export function addrLine(addr, url, testid) {
  const ext = extLink(url, '', 'icon-btn icon-btn-sm ext-only');
  ext.setAttribute?.('aria-label', 'Open in stellar.expert');
  ext.setAttribute?.('title', 'Open in stellar.expert');
  return h('div', { class: 'w-addr' },
    h('code', { title: addr, 'data-testid': testid || null }, short(addr, 6, 6)),
    copyBtn(addr, 'Copy address'), ext);
}

export const agentName = (id) => ((state.agents || []).find((a) => a.id === id) || {}).name || id;
