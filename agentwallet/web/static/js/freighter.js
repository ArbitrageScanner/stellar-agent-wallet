// Minimal client for the Freighter browser extension.
//
// It speaks the same window.postMessage protocol as @stellar/freighter-api
// 6.0.1 (build/index.min.js), so no npm package is vendored:
//
//   page -> content script:  window.postMessage({ source: "FREIGHTER_EXTERNAL_MSG_REQUEST",
//                                                 messageId, type, ...params }, location.origin)
//   content script -> page:  { source: "FREIGHTER_EXTERNAL_MSG_RESPONSE",
//                              messagedId /* sic, the extension's spelling */, ...result, apiError? }
//
// Only REQUEST_CONNECTION_STATUS and REQUEST_PUBLIC_KEY time out (2 s, as in
// the library), because they are the calls that probe for the extension.
// The others wait for the user to act in the Freighter popup.

const REQ = 'FREIGHTER_EXTERNAL_MSG_REQUEST';
const RES = 'FREIGHTER_EXTERNAL_MSG_RESPONSE';
const API_VERSION = '6.0.1';
const PROBE_TIMEOUT_MS = 2000;

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

export class FreighterError extends Error {
  constructor(message, { code = null, rejected = false, notInstalled = false } = {}) {
    super(message);
    this.name = 'FreighterError';
    this.code = code;
    this.rejected = rejected;
    this.notInstalled = notInstalled;
  }
}

let seq = 0;

function send(type, params = {}, { timeoutMs = 0, onTimeout = null } = {}) {
  const messageId = Date.now() + Math.random() + seq++ / 1e6;
  return new Promise((resolve) => {
    let timer = 0;
    const listener = (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.source !== RES || d.messagedId !== messageId) return;
      window.removeEventListener('message', listener);
      clearTimeout(timer);
      resolve(d);
    };
    window.addEventListener('message', listener, false);
    if (timeoutMs) {
      timer = setTimeout(() => {
        window.removeEventListener('message', listener);
        resolve(onTimeout);
      }, timeoutMs);
    }
    window.postMessage({ source: REQ, messageId, type, ...params }, window.location.origin);
  });
}

/** Freighter reports a declined popup as apiError {code: -4, message: "The user rejected this request."}. */
function isRejection(e) {
  if (!e) return false;
  if (e.code === -4) return true;
  return /reject|declin|denied|cancel/i.test(String(e.message || e));
}

function check(res, what) {
  const e = res && res.apiError;
  if (!e) return res;
  const message = typeof e === 'string' ? e : e.message || `Freighter could not ${what}`;
  throw new FreighterError(message, { code: typeof e === 'object' ? e.code ?? null : null, rejected: isRejection(e) });
}

/** {isConnected} — true when the extension is installed (it answers, or sets window.freighter). */
export async function isConnected() {
  if (window.freighter) return { isConnected: true };
  const r = await send('REQUEST_CONNECTION_STATUS', {}, { timeoutMs: PROBE_TIMEOUT_MS, onTimeout: { isConnected: false } });
  return { isConnected: !!(r && r.isConnected) };
}

/** Opens the Freighter "connect this site" popup. Returns {address}. */
export async function requestAccess() {
  const r = check(await send('REQUEST_ACCESS'), 'share your address');
  if (!r.publicKey) throw new FreighterError('Freighter did not return an address. Unlock Freighter and try again.');
  return { address: r.publicKey };
}

/** The current Freighter account if this site is allowed, else "" (probe, 2 s timeout). */
export async function getAddress() {
  const r = await send('REQUEST_PUBLIC_KEY', {}, { timeoutMs: PROBE_TIMEOUT_MS, onTimeout: { publicKey: '' } });
  check(r, 'read your address');
  return { address: (r && r.publicKey) || '' };
}

export async function isAllowed() {
  const r = check(await send('REQUEST_ALLOWED_STATUS'), 'check site access');
  return { isAllowed: !!r.isAllowed };
}

/** {network, networkUrl, networkPassphrase, sorobanRpcUrl} */
export async function getNetworkDetails() {
  const r = check(await send('REQUEST_NETWORK_DETAILS'), 'read the network');
  const n = r.networkDetails || {};
  return { network: n.network || '', networkUrl: n.networkUrl || '', networkPassphrase: n.networkPassphrase || '', sorobanRpcUrl: n.sorobanRpcUrl };
}

/** Signs a base64 TransactionEnvelope. Returns {signedTxXdr, signerAddress}. */
export async function signTransaction(xdr, { networkPassphrase, address } = {}) {
  const r = check(await send('SUBMIT_TRANSACTION', {
    transactionXdr: xdr, network: undefined, networkPassphrase, accountToSign: address,
  }), 'sign the transaction');
  if (!r.signedTransaction) throw new FreighterError('Freighter returned no signed transaction.');
  return { signedTxXdr: r.signedTransaction, signerAddress: r.signerAddress || '' };
}

/** Signs a base64 HashIdPreimage (Soroban auth entry). Returns {signedAuthEntry (base64), signerAddress}. */
export async function signAuthEntry(preimage, { networkPassphrase, address } = {}) {
  // Same as the library: ask for site access first if it has not been granted.
  const { isAllowed: allowed } = await isAllowed();
  if (!allowed) await requestAccess();
  const r = check(await send('SUBMIT_AUTH_ENTRY', {
    entryXdr: preimage, accountToSign: address, apiVersion: API_VERSION, networkPassphrase,
  }), 'sign the authorization');
  const sig = toBase64(r.signedAuthEntry);
  if (!sig) throw new FreighterError('Freighter returned no signature.');
  return { signedAuthEntry: sig, signerAddress: r.signerAddress || '' };
}

/** Freighter returns a base64 string; very old versions returned a serialized Buffer. */
function toBase64(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  const bytes = Array.isArray(v) ? v : Array.isArray(v.data) ? v.data : v instanceof Uint8Array ? [...v] : null;
  if (!bytes) return '';
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Human-readable network name for a passphrase. */
export function networkName(passphrase, fallback = '') {
  if (passphrase === TESTNET_PASSPHRASE) return 'Testnet';
  if (passphrase === 'Public Global Stellar Network ; September 2015') return 'Mainnet (Public)';
  if (passphrase === 'Test SDF Future Network ; October 2022') return 'Futurenet';
  return fallback || 'an unknown network';
}
