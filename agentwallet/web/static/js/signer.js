// Wallet abstraction: sign-in (SEP-10) and op signing with Freighter or the
// dev test key. See docs/API.md "Signing operations".

import { api } from './api.js';
import { state } from './state.js';
import * as F from './freighter.js';
import * as Dev from './devwallet.js';
import { short } from './util.js';

export const FREIGHTER_URL = 'https://www.freighter.app/';

export const NOT_INSTALLED = 'Freighter is not installed or is disabled in this browser.';

const passphrase = () => (state.config && state.config.network_passphrase) || F.TESTNET_PASSPHRASE;

export const isDev = () => !!(state.session && state.session.signer === 'dev');
export const signerName = () => (isDev() ? 'the test key' : 'Freighter');

async function requireFreighter() {
  const { isConnected } = await F.isConnected();
  if (!isConnected) throw new F.FreighterError(NOT_INSTALLED, { notInstalled: true });
}

/** Throws a readable FreighterError when Freighter is not on the server's network (TESTNET). */
async function requireNetwork() {
  const net = await F.getNetworkDetails();
  const want = passphrase();
  if (net.networkPassphrase && net.networkPassphrase !== want) {
    const e = new F.FreighterError(
      `Freighter is on ${F.networkName(net.networkPassphrase, net.network)}. Switch Freighter to Testnet (Settings → Network) and try again.`,
      { code: 'wrong_network' });
    e.wrongNetwork = true;
    throw e;
  }
}

/** Freighter sign-in: connect, check the network, sign the SEP-10 challenge, log in. */
export async function loginWithFreighter(status) {
  status('Looking for Freighter…');
  await requireFreighter();
  status('Approve the connection in Freighter…');
  const { address } = await F.requestAccess();
  await requireNetwork();
  status('Preparing the sign-in challenge…');
  const op = await api.challenge(address);
  status('Confirm the sign-in in Freighter…');
  const { signedTxXdr } = await F.signTransaction(op.xdr, { networkPassphrase: op.network_passphrase || passphrase(), address });
  status('Signing in…');
  const r = await api.login({ op_id: op.op_id, signed_xdr: signedTxXdr });
  return { address: r.address || address, signer: 'freighter' };
}

/** Dev sign-in: a WebCrypto ed25519 key funded by friendbot through /api/dev/fund. */
export async function loginWithTestKey(status) {
  status('Creating a test key…');
  const { address } = await Dev.loadOrCreate();
  let warning = null;
  if (!Dev.isFunded()) {
    status('Funding the test key with friendbot…');
    try {
      await api.devFund(address);
      Dev.markFunded();
    } catch (e) {
      warning = `Friendbot funding failed: ${e.message || e}`;
    }
  }
  status('Signing the sign-in challenge…');
  const op = await api.challenge(address);
  const signature = await Dev.signHash(op.hash, address);
  status('Signing in…');
  const r = await api.login({ op_id: op.op_id, signature });
  return { address: r.address || address, signer: 'dev', warning };
}

/**
 * Signs an op (from a …/prepare endpoint) with the session's wallet and
 * returns the body for POST /api/ops/{op_id}/submit.
 */
export async function signOp(op) {
  const s = state.session;
  if (!s) throw new Error('You are signed out.');
  if (s.signer === 'dev') return { signature: await Dev.signHash(op.hash, s.address) };

  await requireFreighter();
  await requireNetwork();
  const opts = { networkPassphrase: op.network_passphrase || passphrase(), address: s.address };
  let signer;
  let body;
  if (op.kind === 'auth') {
    if (!op.preimage) throw new Error('The server sent an auth op without a preimage.');
    const r = await F.signAuthEntry(op.preimage, opts);
    signer = r.signerAddress;
    body = { signed_auth_entry: r.signedAuthEntry };
  } else {
    if (!op.xdr) throw new Error('The server sent a transaction op without XDR.');
    const r = await F.signTransaction(op.xdr, opts);
    signer = r.signerAddress;
    body = { signed_xdr: r.signedTxXdr };
  }
  if (signer && signer !== s.address) {
    throw new F.FreighterError(`Freighter signed with ${short(signer, 5, 5)}, but you are signed in as ${short(s.address, 5, 5)}. Switch the account in Freighter and try again.`, { code: 'wrong_account' });
  }
  return body;
}

export { FreighterError } from './freighter.js';
