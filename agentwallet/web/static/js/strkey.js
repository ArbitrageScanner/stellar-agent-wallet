// Stellar StrKey (SEP-23) for ed25519 public keys (G…) and contracts (C…).
//
//   strkey = base32( versionByte ‖ payload(32 bytes) ‖ crc16xmodem(versionByte ‖ payload) as little-endian )
//
// versionByte: G = 6 << 3 (48), C = 2 << 3 (16). 35 bytes = 280 bits = 56 base32
// characters exactly, so there is never any padding. Pure functions, no DOM:
// the e2e test imports this file in Node as well as in the browser.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const VERSION = { G: 6 << 3, C: 2 << 3 };

/** CRC16-XModem: poly 0x1021, init 0x0000, no reflection, no final xor. */
export function crc16xmodem(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** RFC 4648 base32 without padding. */
export function base32Encode(bytes) {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1; // keep only the bits not yet emitted
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const out = [];
  let value = 0;
  let bits = 0;
  for (const ch of str) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`invalid base32 character ${JSON.stringify(ch)}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}

function encodeCheck(version, payload) {
  if (!(payload instanceof Uint8Array) || payload.length !== 32) throw new Error('payload must be 32 bytes');
  const data = new Uint8Array(35);
  data[0] = version;
  data.set(payload, 1);
  const crc = crc16xmodem(data.subarray(0, 33));
  data[33] = crc & 0xff;        // little-endian
  data[34] = (crc >>> 8) & 0xff;
  return base32Encode(data);
}

function decodeCheck(version, str) {
  if (typeof str !== 'string' || str.length !== 56) throw new Error('a StrKey is 56 characters');
  const data = base32Decode(str);
  if (data.length !== 35) throw new Error('invalid StrKey length');
  if (data[0] !== version) throw new Error('unexpected StrKey version byte');
  const crc = crc16xmodem(data.subarray(0, 33));
  if (data[33] !== (crc & 0xff) || data[34] !== ((crc >>> 8) & 0xff)) throw new Error('invalid StrKey checksum');
  // Reject non-canonical encodings (the last character must not carry stray bits).
  if (base32Encode(data) !== str) throw new Error('non-canonical StrKey');
  return data.slice(1, 33);
}

/** 32-byte ed25519 public key -> "G…". */
export const encodePublicKey = (pub) => encodeCheck(VERSION.G, pub);
/** "G…" -> 32-byte ed25519 public key. Throws on a bad checksum. */
export const decodePublicKey = (g) => decodeCheck(VERSION.G, g);
export const encodeContract = (id) => encodeCheck(VERSION.C, id);
export const decodeContract = (c) => decodeCheck(VERSION.C, c);

export function isPublicKey(s) {
  try { decodePublicKey(s); return true; } catch { return false; }
}
