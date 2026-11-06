// Signed-out screen: pitch, "Connect Freighter" and (dev_wallet) "Use test key".

import { state } from './state.js';
import { describeError } from './api.js';
import { loginWithFreighter, loginWithTestKey, FREIGHTER_URL } from './signer.js';
import * as Dev from './devwallet.js';
import { h, icon, ICONS, short, extLink, waitLine, SLOW_RPC } from './util.js';

let statusEl, freighterBtn, testBtn, busy = false;

// Extra lines for the sign-in steps that can take a while on testnet.
const LOGIN_HINTS = {
  'Funding the test key with friendbot…': [
    [3_000, 'Friendbot creates and funds a fresh testnet account with 10,000 XLM. This usually takes 5 to 20 seconds.'],
    [25_000, 'Friendbot is slow right now. Keep this tab open; sign-in continues on its own.'],
  ],
  'Signed in. Reading your wallet from Stellar testnet…': [
    [3_000, 'Reading your wallet and smart account from the public testnet RPC. This can take up to 15 seconds.'],
    [20_000, SLOW_RPC],
  ],
  'Approve the connection in Freighter…': [[6_000, 'Freighter opens a popup. If you do not see it, click the Freighter icon in the browser toolbar.']],
  'Confirm the sign-in in Freighter…': [[6_000, 'Freighter opens a popup. If you do not see it, click the Freighter icon in the browser toolbar.']],
};
let signedIn = () => {};

export function initLanding({ onSignedIn }) {
  signedIn = onSignedIn;
  statusEl = document.getElementById('login-status');
  freighterBtn = document.getElementById('connect-freighter');
  testBtn = document.getElementById('use-test-key');
  freighterBtn.addEventListener('click', () => run('freighter'));
  testBtn.addEventListener('click', () => run('dev'));
}

/** Re-renders the parts that depend on config and on the stored test key. */
export function renderLanding() {
  const dev = !!(state.config && state.config.dev_wallet);
  testBtn.hidden = !dev;
  document.getElementById('test-key-note').hidden = !dev;
  const existing = dev ? Dev.storedAddress() : null;
  const ex = document.getElementById('test-key-existing');
  ex.replaceChildren();
  if (existing) {
    ex.append(' This tab already has test key ', h('code', { title: existing }, short(existing, 5, 5)), ', which will be reused. ',
      h('button', { class: 'linkish', type: 'button', onClick: () => { Dev.forget(); renderLanding(); } }, 'Use a new one'));
  }
}

export function showSignedOutReason(text) {
  setStatus('info', [icon(ICONS.alert), h('span', {}, text)]);
}

function setStatus(kind, nodes) {
  if (!kind) { statusEl.hidden = true; statusEl.replaceChildren(); return; }
  statusEl.hidden = false;
  statusEl.className = `login-status login-${kind}`;
  statusEl.dataset.kind = kind;
  statusEl.setAttribute('data-testid', kind === 'progress' ? 'login-progress' : 'login-message');
  statusEl.replaceChildren(...[].concat(nodes));
}

function setBusy(b) {
  busy = b;
  freighterBtn.disabled = b;
  testBtn.disabled = b;
}

async function run(kind) {
  if (busy) return;
  setBusy(true);
  const progress = (text) => setStatus('progress', [waitLine(text, LOGIN_HINTS[text] || [[10_000, SLOW_RPC]])]);
  try {
    const session = kind === 'dev' ? await loginWithTestKey(progress) : await loginWithFreighter(progress);
    // Keep the loader up while the account loads: /api/me reads Stellar RPC and can take seconds.
    progress('Signed in. Reading your wallet from Stellar testnet…');
    await signedIn(session);
    setStatus(null);
  } catch (err) {
    showError(err, kind);
  } finally {
    setBusy(false);
  }
}

function showError(err, kind) {
  if (err && err.notInstalled) {
    setStatus('error', [icon(ICONS.alert), h('div', {},
      h('b', {}, 'Freighter is not installed.'),
      ' Install the Freighter browser extension, set it to Testnet, then reload this page. ',
      extLink(FREIGHTER_URL, 'Get Freighter', 'tx-link'),
      state.config && state.config.dev_wallet ? h('div', { class: 'muted small' }, 'Or use a test key to try the demo without a wallet.') : null)]);
    statusEl.dataset.reason = 'not_installed';
    return;
  }
  if (err && err.wrongNetwork) {
    setStatus('error', [icon(ICONS.alert), h('div', {}, h('b', {}, 'Wrong network. '), err.message)]);
    statusEl.dataset.reason = 'wrong_network';
    return;
  }
  if (err && err.rejected) {
    setStatus('info', [icon(ICONS.cross), h('div', {}, h('b', {}, 'Sign-in cancelled. '), 'You declined the request in Freighter. Nothing was signed.')]);
    statusEl.dataset.reason = 'rejected';
    return;
  }
  const msg = err && err.status !== undefined ? describeError(err) : (err && err.message) || String(err);
  setStatus('error', [icon(ICONS.alert), h('div', {}, h('b', {}, kind === 'dev' ? 'Test key sign-in failed. ' : 'Sign-in failed. '), msg)]);
  statusEl.dataset.reason = (err && err.code) || 'error';
}
