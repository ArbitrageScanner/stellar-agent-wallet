// The op flow (docs/API.md "Signing operations") in a modal:
//   prepare -> show the op summary -> sign (Freighter or test key) -> submit -> tx link or error card.

import { api, describeError } from './api.js';
import { openModal } from './modal.js';
import { signOp, isDev, FREIGHTER_URL } from './signer.js';
import { h, icon, ICONS, short, copyBtn, extLink, fmtAmount, waitLine, SLOW_RPC } from './util.js';

const STEPS = [
  { key: 'prepare', label: 'Prepare' },
  { key: 'sign', label: () => (isDev() ? 'Sign with the test key' : 'Sign in Freighter') },
  { key: 'submit', label: 'Submit to Stellar' },
];

/**
 * Runs one op in the modal.
 *   title     modal title
 *   prepare() -> op (calls a …/prepare endpoint)
 *   done(resp, view) optional: renders extra success content (view.extra) and may change the title
 *   after(resp) optional: called after a successful submit (refresh data)
 * Resolves to the submit response when it succeeds, else null.
 */
export function runOp(spec) {
  return new Promise((resolve) => {
    const view = new OpView(spec, resolve);
    view.modal = openModal({ title: spec.title, content: view.el, onClose: () => view.closed() });
    view.prepare();
  });
}

class OpView {
  constructor(spec, resolve) {
    this.spec = spec;
    this.resolve = resolve;
    this.op = null;
    this.alive = true;
    this.finished = false;
    this.summary = h('div', { class: 'op-summary', 'data-testid': 'op-summary', hidden: true });
    this.kindTag = h('span', { class: 'tag' });
    this.stepEls = STEPS.map((s) => h('li', { class: 'op-step', dataset: { state: 'todo' } },
      h('span', { class: 'op-step-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'op-step-label' }, typeof s.label === 'function' ? s.label() : s.label)));
    this.status = h('div', { class: 'op-status', 'data-testid': 'op-status', 'aria-live': 'polite' });
    this.result = h('div', { class: 'op-result' });
    this.extra = h('div', { class: 'op-extra' });
    this.actions = h('div', { class: 'modal-actions' });
    this.el = h('div', { class: 'op', 'data-testid': 'op', dataset: { state: 'preparing' } },
      h('div', { class: 'op-head' }, this.summary),
      h('ol', { class: 'op-steps', 'aria-label': 'Progress' }, this.stepEls),
      this.status, this.result, this.extra, this.actions);
  }

  closed() {
    this.alive = false;
    if (!this.finished) { this.finished = true; this.resolve(null); }
  }

  setState(state) { this.el.dataset.state = state; }

  step(i, st) {
    this.stepEls.forEach((el, j) => {
      el.dataset.state = j < i ? 'done' : j === i ? st : 'todo';
    });
  }

  setStatus(...nodes) { nodes = nodes.filter((n) => n !== null && n !== undefined); this.status.replaceChildren(...nodes); this.status.hidden = !nodes.length; }

  buttons(...btns) { this.actions.replaceChildren(...btns.filter(Boolean)); }

  closeBtn(label = 'Close', primary = false) {
    return h('button', { class: `btn ${primary ? 'btn-primary' : 'btn-ghost'}`, type: 'button', 'data-testid': 'op-close', onClick: () => this.modal.close() }, label);
  }

  async prepare() {
    this.op = null;
    this.result.replaceChildren();
    this.setState('preparing');
    this.step(0, 'active');
    this.setStatus(waitLine('Preparing…', [
      [3_000, 'The server builds the operation and simulates it against Stellar testnet RPC to get its exact footprint and fee.'],
      [15_000, SLOW_RPC],
    ]));
    this.buttons(this.closeBtn('Cancel'));
    let op;
    try {
      op = await this.spec.prepare();
    } catch (err) {
      if (!this.alive) return;
      return this.fail(0, { code: err.code, message: describeError(err), details: err.details }, null);
    }
    if (!this.alive) return;
    if (!op || !op.op_id) return this.fail(0, { code: 'bad_response', message: 'The server did not return an op.' }, null);
    this.op = op;
    this.summary.hidden = false;
    this.kindTag.textContent = op.kind === 'auth' ? 'authorization entry' : 'transaction';
    this.summary.replaceChildren(
      h('div', { class: 'op-summary-text' }, op.summary || this.spec.title),
      h('div', { class: 'op-summary-meta' }, 'Signs a ', this.kindTag, ' on ', h('b', {}, netLabel(op.network_passphrase)),
        op.hash ? [', hash ', h('code', { title: `hash ${op.hash}` }, short(op.hash, 6, 6))] : null));
    return this.sign();
  }

  async sign() {
    const op = this.op;
    if (op.expires_at && Date.parse(op.expires_at) < Date.now()) {
      return this.fail(1, { code: 'op_expired', message: 'This request expired before it was signed. Prepare it again.' }, null, true);
    }
    this.result.replaceChildren();
    this.setState('signing');
    this.step(1, 'active');
    this.setStatus(h('span', { class: 'spinner' }), isDev() ? ' Signing with the test key…' : ' Confirm in Freighter…',
      isDev() ? null : h('div', { class: 'op-hint muted small' }, 'Freighter opens a popup. If you do not see it, click the Freighter icon in the toolbar.'));
    this.buttons(this.closeBtn('Cancel'));
    let body;
    try {
      body = await signOp(op);
    } catch (err) {
      if (!this.alive) return;
      if (err && err.rejected) return this.rejected();
      const e = { code: err.code || (err.notInstalled ? 'freighter_missing' : 'sign_failed'), message: err.message || String(err) };
      if (err.notInstalled) e.link = FREIGHTER_URL;
      return this.fail(1, e, null, true);
    }
    if (!this.alive) return;
    return this.submit(body);
  }

  async submit(body) {
    this.setState('submitting');
    this.step(2, 'active');
    this.setStatus(waitLine('Submitting to Stellar testnet…', [
      [3_000, 'Waiting for the transaction to land in a ledger. Testnet closes one every 5 seconds or so; with RPC confirmation this usually takes 5 to 15 seconds.'],
      [25_000, 'Still waiting for Stellar to confirm. The public testnet RPC is slow right now; the result shows here as soon as it is confirmed.'],
    ]));
    this.buttons();
    this.modal.setDismissible(false);
    let resp;
    try {
      resp = await api.submitOp(this.op.op_id, body);
    } catch (err) {
      this.modal.setDismissible(true);
      if (!this.alive) return;
      return this.fail(2, { code: err.code, message: describeError(err), details: err.details }, null);
    }
    this.modal.setDismissible(true);
    if (!this.alive) return;
    if (!resp || resp.ok === false) {
      if (this.spec.after) this.spec.after(resp);
      return this.fail(2, (resp && resp.error) || { code: 'failed', message: 'The operation failed.' }, resp && resp.tx);
    }
    return this.success(resp);
  }

  success(resp) {
    this.setState('done');
    this.step(3, 'done');
    this.setStatus();
    const tx = resp.tx;
    this.result.replaceChildren(h('div', { class: 'res res-ok', 'data-testid': 'op-result', 'data-ok': 'true' },
      icon(ICONS.check),
      h('span', {}, this.spec.okText ? this.spec.okText(resp) : 'Done. The change is on-chain.'),
      tx && tx.hash ? txLink(tx) : null));
    this.buttons(this.closeBtn('Done', true));
    if (this.spec.done) {
      try { this.spec.done(resp, this); } catch (e) { console.warn('[op] done()', e); }
    }
    if (this.spec.after) this.spec.after(resp);
    this.finished = true;
    this.resolve(resp);
  }

  rejected() {
    this.setState('rejected');
    this.step(1, 'error');
    this.setStatus();
    this.result.replaceChildren(h('div', { class: 'err-card err-muted', 'data-testid': 'op-result', 'data-ok': 'false', 'data-code': 'rejected_by_user' },
      h('div', { class: 'err-title' }, icon(ICONS.cross), h('span', { class: 'err-title-text' }, 'You rejected the signature in Freighter')),
      h('div', { class: 'err-text' }, 'Nothing was signed or sent. You can try again or close this window.')));
    this.buttons(this.closeBtn(), h('button', { class: 'btn btn-primary', type: 'button', onClick: () => this.sign() }, icon(ICONS.retry), 'Try again'));
  }

  /** Shows a readable error card. canResign: the op itself is still usable (failed while signing). */
  fail(stepIdx, err, tx, canResign = false) {
    this.setState('failed');
    this.step(stepIdx, 'error');
    this.setStatus();
    this.result.replaceChildren(errorCard(err, tx));
    const expired = err && err.code === 'op_expired';
    const retry = h('button', {
      class: 'btn btn-primary', type: 'button',
      onClick: () => (canResign && !expired && this.op ? this.sign() : this.prepare()),
    }, icon(ICONS.retry), 'Try again');
    this.buttons(this.closeBtn(), retry);
  }
}

function netLabel(p) {
  if (!p || /^Test SDF Network/.test(p)) return 'Stellar testnet';
  if (/^Public Global/.test(p)) return 'Stellar mainnet';
  return p;
}

export function txLink(tx) {
  return h('span', { class: 'op-tx', 'data-testid': 'op-tx' },
    h('code', { title: tx.hash }, short(tx.hash, 6, 4)), copyBtn(tx.hash, 'Copy hash'),
    extLink(tx.url, 'View on stellar.expert', 'tx-link'));
}

const OP_ERR_TITLES = {
  freighter_missing: 'Freighter is not installed',
  wrong_network: 'Freighter is on the wrong network',
  wrong_account: 'Wrong Freighter account',
  op_expired: 'The request expired',
  insufficient_balance: 'Not enough USDC',
  insufficient_xlm: 'Not enough XLM',
  wallet_unfunded: 'Your wallet is not funded',
  spending_limit_exceeded: 'Over the spending limit',
  tx_failed: 'The transaction failed',
  simulation_failed: 'Simulation failed',
  rpc_error: 'Stellar RPC error',
  invalid_argument: 'Invalid input',
  invalid_state: 'Not possible right now',
  not_found: 'Not found',
  forbidden: 'Not allowed',
  network: 'Cannot reach the server',
};

/** A readable error card for API/op errors: title, message, details, tx link. */
export function errorCard(err, tx = null) {
  err = err || {};
  const code = err.code || 'error';
  const title = OP_ERR_TITLES[code] || 'Something went wrong';
  const det = err.details && typeof err.details === 'object' ? err.details : null;
  const rows = det ? Object.entries(det).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object') : [];
  return h('div', { class: 'err-card err-generic', role: 'alert', 'data-testid': 'op-result', 'data-ok': 'false', 'data-code': code },
    h('div', { class: 'err-title' }, icon(ICONS.alert), h('span', { class: 'err-title-text' }, title), h('code', { class: 'err-code' }, code)),
    h('div', { class: 'err-text' }, err.message || 'No details.'),
    err.link ? h('div', { class: 'err-text' }, extLink(err.link, 'Install Freighter', 'tx-link')) : null,
    rows.length ? h('dl', { class: 'err-details' }, rows.map(([k, v]) => [h('dt', {}, k.replace(/_/g, ' ')), h('dd', {}, /amount|limit|spent|remaining|balance|requested/.test(k) ? fmtAmount(v) : String(v))])) : null,
    tx && tx.hash ? h('div', { class: 'err-text' }, 'Transaction: ', txLink(tx)) : null);
}
