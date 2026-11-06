// In-browser test key, offered only when /api/config says dev_wallet: true.
//
// A raw ed25519 key made with WebCrypto. It lives in sessionStorage (this tab
// only) as PKCS#8 + the raw public key, both base64. It signs the `hash` of an
// op (32 bytes, hex) and the UI submits {signature: base64}. Testnet only.

import { encodePublicKey } from './strkey.js';

const K_KEY = 'aw.devKey';
const ALG = { name: 'Ed25519' };

const ss = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

export const b64 = {
  enc(buf) {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  },
  dec(str) {
    const s = atob(str);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  },
};

export function hexToBytes(hex) {
  const s = String(hex || '').trim().replace(/^0x/i, '');
  if (!/^(?:[0-9a-f]{2})+$/i.test(s)) throw new Error('op hash is not hex');
  const u = new Uint8Array(s.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return u;
}

let cached = null; // {address, privateKey: CryptoKey}

export function isSupported() {
  return !!(window.isSecureContext && window.crypto && crypto.subtle);
}

/** The stored test key's address, or null. Does not touch WebCrypto. */
export function storedAddress() {
  const raw = ss.get(K_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw).address || null; } catch { return null; }
}

export function isFunded() {
  try { return !!JSON.parse(ss.get(K_KEY) || '{}').funded; } catch { return false; }
}

export function markFunded() {
  try {
    const o = JSON.parse(ss.get(K_KEY) || 'null');
    if (o) { o.funded = true; ss.set(K_KEY, JSON.stringify(o)); }
  } catch { /* ignore */ }
}

/** Loads the key from sessionStorage, or creates and stores a new one. Returns {address, created}. */
export async function loadOrCreate() {
  if (!isSupported()) throw new Error('This browser has no WebCrypto here (it needs https or localhost).');
  const existing = await load();
  if (existing) return { address: existing.address, created: false };
  let kp;
  try {
    kp = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  } catch {
    throw new Error('This browser does not support Ed25519 in WebCrypto. Use a current Chrome, Edge, Firefox or Safari.');
  }
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const address = encodePublicKey(pub);
  if (!ss.set(K_KEY, JSON.stringify({ v: 1, address, pub: b64.enc(pub), pkcs8: b64.enc(pkcs8), funded: false }))) {
    throw new Error('sessionStorage is blocked, so the test key cannot be kept.');
  }
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, ALG, false, ['sign']);
  cached = { address, privateKey };
  return { address, created: true };
}

async function load() {
  const raw = ss.get(K_KEY);
  if (!raw) return null;
  if (cached && cached.address === storedAddress()) return cached;
  try {
    const o = JSON.parse(raw);
    const pub = b64.dec(o.pub);
    if (encodePublicKey(pub) !== o.address) throw new Error('address mismatch');
    const privateKey = await crypto.subtle.importKey('pkcs8', b64.dec(o.pkcs8), ALG, false, ['sign']);
    cached = { address: o.address, privateKey };
    return cached;
  } catch {
    ss.del(K_KEY);
    cached = null;
    return null;
  }
}

/** Signs the 32 bytes behind `hashHex` and returns the raw signature as base64. */
export async function signHash(hashHex, expectedAddress) {
  const k = await load();
  if (!k) throw new Error('The test key is no longer in this tab. Sign out and use a new test key.');
  if (expectedAddress && k.address !== expectedAddress) throw new Error('The test key in this tab belongs to another account. Sign out and sign in again.');
  const sig = await crypto.subtle.sign(ALG, k.privateKey, hexToBytes(hashHex));
  return b64.enc(sig);
}

export function forget() {
  ss.del(K_KEY);
  cached = null;
}
