// Byte helpers shared by the crypto modules.

import {
  fromBase32,
  fromBase58Btc,
  fromBase64,
  fromBase64Pad,
  fromBase64Url,
  toBase32,
  toBase58Btc,
  toBase64Pad,
  toBase64Url,
} from '@atcute/multibase';

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
/** Strict UTF-8. A leading BOM is kept as U+FEFF, not silently stripped. */
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u16be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError(`${n} doesn't fit a uint16`);
  return new Uint8Array([n >> 8, n & 0xff]);
}

/** A string prefixed with its UTF-8 byte length as a big-endian uint16. */
export const lenPrefixed = (s: string): Uint8Array => {
  const b = utf8(s);
  return concat(u16be(b.length), b);
};

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const fromHex = (s: string): Uint8Array => {
  if (!/^([0-9a-f]{2})*$/i.test(s)) throw new Error('invalid hex');
  return new Uint8Array(Buffer.from(s, 'hex'));
};

export const b64url = (b: Uint8Array): string => toBase64Url(b);
export const fromB64url = (s: string): Uint8Array => fromBase64Url(s);
/** Standard base64 with padding, as lexicon $bytes and structured-field byte sequences use. */
export const b64 = (b: Uint8Array): string => toBase64Pad(b);
/** Standard base64, padding optional. */
export const fromB64 = (s: string): Uint8Array => (s.endsWith('=') ? fromBase64Pad(s) : fromBase64(s));
export const base32 = (b: Uint8Array): string => toBase32(b);
export const fromBase32Lower = (s: string): Uint8Array => fromBase32(s);
export const base58btc = (b: Uint8Array): string => toBase58Btc(b);
export const fromBase58 = (s: string): Uint8Array => fromBase58Btc(s);

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Lexicographic order of raw bytes. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Unsigned LEB128 varint (multiformats unsigned-varint). */
export function varint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`bad varint ${n}`);
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return new Uint8Array(out);
}

/**
 * Read a canonical unsigned varint at `off`. Returns null at clean EOF
 * (off === length). Throws on truncation, a non-minimal encoding, or more
 * than `maxBytes` bytes.
 */
export function readVarint(b: Uint8Array, off: number, maxBytes = 9): { value: number; next: number } | null {
  if (off === b.length) return null;
  let value = 0;
  let mul = 1;
  for (let i = 0; i < maxBytes; i++) {
    if (off + i >= b.length) throw new Error('varint truncated');
    const byte = b[off + i];
    value += (byte & 0x7f) * mul;
    if ((byte & 0x80) === 0) {
      if (i > 0 && byte === 0) throw new Error('non-canonical varint');
      if (!Number.isSafeInteger(value)) throw new Error('varint too large');
      return { value, next: off + i + 1 };
    }
    mul *= 128;
  }
  throw new Error(`varint longer than ${maxBytes} bytes`);
}
