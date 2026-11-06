// Small DOM and formatting helpers shared by all modules.

/** Creates an element. attrs: class, text, dataset, on<Event>, any attribute. Children: nodes, strings, arrays, null. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Parses a trusted, static SVG/HTML snippet (icons only, never user data). */
export function icon(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstChild;
}

export const ICONS = {
  copy: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  ext: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cross: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  shield: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 9l6 6M15 9l-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  alert: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 4l9 16H3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  hand: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5v5l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  chain: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  retry: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  key: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="8" cy="15" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  chat: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  logout: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M10 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H10M15 8l4 4-4 4M19 12H9.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gauge: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4.5 17a8 8 0 1 1 15 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 14l4-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 9v6M14 9v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 8.8l5 3.2-5 3.2z" fill="currentColor"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5v10A1.5 1.5 0 0 0 5.5 19h13a1.5 1.5 0 0 0 1.5-1.5V9.5A1.5 1.5 0 0 0 18.5 8H6.5A2.5 2.5 0 0 1 4 7.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="16" cy="13.5" r="1.3" fill="currentColor"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 4v13M6.5 11.5L12 17l5.5-5.5M5 20h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 20V7M6.5 12.5L12 7l5.5 5.5M5 4h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l.8 12h8.4L17 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

export const short = (s, a = 4, b = 4) => {
  if (!s) return '';
  s = String(s);
  return s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s;
};

/** Decimal-string amount for display ("1.5000000" -> "1.5"). Returns "—" for null. */
export function fmtAmount(x) {
  if (x === null || x === undefined || x === '') return '—';
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x);
  return n.toLocaleString('en-US', { maximumFractionDigits: 7 });
}

/** English singular/plural: plural(1, 'payment') -> "payment", plural(3, 'payment') -> "payments". */
export function plural(n, one, many = `${one}s`) {
  return n === 1 ? one : many;
}

/** Approximate duration: "~14 h", "~35 min", "<1 min", "~2 days". */
export function fmtApprox(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return null;
  sec = Math.max(0, Number(sec));
  if (sec >= 86400 - 1800) { const d = Math.round(sec / 86400); return `~${d} ${plural(d, 'day')}`; }
  if (sec >= 3600) return `~${Math.round(sec / 3600)} h`;
  if (sec >= 60) return `~${Math.round(sec / 60)} min`;
  return '<1 min';
}

/** Countdown: "13 h 59 min", "4 min 05 s". */
export function fmtCountdown(sec) {
  sec = Math.max(0, Math.floor(sec));
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  if (hh > 0) return `${hh} h ${String(mm).padStart(2, '0')} min`;
  if (mm > 0) return `${mm} min ${String(ss).padStart(2, '0')} s`;
  return `${ss} s`;
}

/** Period in ledgers as words: 17280 (x 5 s) -> "day". */
export function fmtPeriod(ledgers, ledgerSeconds = 5) {
  if (!ledgers) return 'day';
  const s = ledgers * ledgerSeconds;
  if (Math.abs(s - 86400) < 3600) return 'day';
  if (s % 86400 === 0) return `${s / 86400} days`;
  if (s >= 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 60)} min`;
}

/** Relative time: "just now", "4 minutes ago", "2 hours ago", then a short date. */
export function fmtRelTime(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = (Date.now() - t) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) { const m = Math.max(1, Math.round(d / 60)); return `${m} ${plural(m, 'minute')} ago`; }
  if (d < 86400) { const x = Math.round(d / 3600); return `${x} ${plural(x, 'hour')} ago`; }
  return new Date(t).toLocaleString('en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** localStorage wrapper that never throws. */
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0;top:0;left:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

let toastTimer;
export function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/** A small "copy" icon button. */
export function copyBtn(text, label = 'Copy') {
  const b = h('button', { class: 'icon-btn icon-btn-sm', type: 'button', title: label, 'aria-label': label }, icon(ICONS.copy));
  b.addEventListener('click', async (e) => {
    e.preventDefault();
    const ok = await copyText(typeof text === 'function' ? text() : text);
    toast(ok ? 'Copied' : 'Could not copy', ok ? '' : 'bad');
    if (ok) { b.classList.add('done'); setTimeout(() => b.classList.remove('done'), 1200); }
  });
  return b;
}

/** External link with an arrow icon. */
export function extLink(href, label, cls = 'ext') {
  if (!href || !/^https?:\/\//i.test(href)) return h('span', { class: cls }, label);
  return h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer' }, label, icon(ICONS.ext));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseMaybeJSON(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s || !'{["'.includes(s[0])) return v;
  try { return JSON.parse(s); } catch { return v; }
}

const AMOUNT_RE = /^\d+([.,]\d{1,7})?$/;

/** Normalizes a user-typed USDC amount to a decimal string ("2,5" -> "2.5"), or null if invalid. */
export function normAmount(v) {
  const s = String(v ?? '').trim().replace(/\s+/g, '');
  if (!AMOUNT_RE.test(s)) return null;
  const out = s.replace(',', '.');
  return Number(out) > 0 ? out : null;
}

/** A CLI-safe server name from an agent name: "Shopping bot" -> "shopping-bot". */
export function slug(name, fallback = 'agentwallet') {
  const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || fallback;
}

/** Explains a slow Stellar testnet RPC; shown when a wait drags on. */
export const SLOW_RPC = 'The public Stellar testnet RPC is slow at times. Keep this tab open; it finishes on its own.';

/**
 * A loader: a spinner and a line of text, plus hints that appear only if the
 * wait drags on. hints: [[afterMs, text], ...]; `since` lets a re-rendered
 * loader keep its clock (pass the time the wait started).
 */
export function waitLine(text, hints = [], { since = Date.now(), testid = null } = {}) {
  const hint = h('div', { class: 'wait-hint', 'aria-live': 'polite', hidden: true });
  const el = h('div', { class: 'wait', 'data-testid': testid }, h('div', { class: 'wait-main' }, h('span', { class: 'spinner' }), h('span', {}, text)), hint);
  for (const [after, msg] of hints) {
    const show = () => { hint.textContent = msg; hint.hidden = false; };
    const left = after - (Date.now() - since);
    if (left <= 0) show();
    else setTimeout(() => { if (el.isConnected || !el.parentNode) show(); }, left);
  }
  return el;
}
