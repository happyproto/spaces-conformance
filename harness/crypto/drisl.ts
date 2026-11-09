// DRISL (DASL deterministic CBOR, https://dasl.ing/drisl.html), written
// fresh for the harness so it is an independent encoder:
//
// - definite lengths only, with every length and integer in its shortest form;
// - map keys are text strings, sorted by encoded length then bytes, unique;
// - the only tag is 42 (a CID, as bytes with a 0x00 prefix);
// - floats are 64-bit and finite. Records don't use them, and the encoder refuses them;
// - simple values are only false, true and null.
//
// Values: integers as number (safe) or bigint, string, boolean, null,
// Uint8Array (bytes), Cid, arrays and plain objects.

import { compareBytes, concat, fromB64, fromUtf8, utf8, b64 } from './bytes.ts';
import { Cid } from './cid.ts';

export type DrislValue = number | bigint | string | boolean | null | Uint8Array | Cid | DrislValue[] | { [k: string]: DrislValue };

function head(major: number, n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n) throw new RangeError('negative length');
  const m = major << 5;
  if (v < 24n) return new Uint8Array([m | Number(v)]);
  if (v < 0x100n) return new Uint8Array([m | 24, Number(v)]);
  if (v < 0x10000n) return new Uint8Array([m | 25, Number(v >> 8n), Number(v & 0xffn)]);
  if (v < 0x100000000n) {
    const b = new Uint8Array(5);
    b[0] = m | 26;
    new DataView(b.buffer).setUint32(1, Number(v));
    return b;
  }
  if (v < 1n << 64n) {
    const b = new Uint8Array(9);
    b[0] = m | 27;
    new DataView(b.buffer).setBigUint64(1, v);
    return b;
  }
  throw new RangeError('integer exceeds 64 bits');
}

export function encode(value: DrislValue): Uint8Array {
  const parts: Uint8Array[] = [];
  const walk = (v: DrislValue): void => {
    if (v === null) parts.push(new Uint8Array([0xf6]));
    else if (v === true) parts.push(new Uint8Array([0xf5]));
    else if (v === false) parts.push(new Uint8Array([0xf4]));
    else if (typeof v === 'number' || typeof v === 'bigint') {
      if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new TypeError(`DRISL records carry integers only, got ${v}`);
      const n = BigInt(v);
      parts.push(n >= 0n ? head(0, n) : head(1, -1n - n));
    } else if (typeof v === 'string') {
      const b = utf8(v);
      parts.push(head(3, b.length), b);
    } else if (v instanceof Uint8Array) parts.push(head(2, v.length), v);
    else if (v instanceof Cid) {
      const b = concat(new Uint8Array([0x00]), v.bytes);
      parts.push(new Uint8Array([0xd8, 42]), head(2, b.length), b);
    } else if (Array.isArray(v)) {
      parts.push(head(4, v.length));
      v.forEach(walk);
    } else if (typeof v === 'object') {
      const entries = Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => [utf8(k), k, x] as const)
        .sort((a, b) => a[0].length - b[0].length || compareBytes(a[0], b[0]));
      parts.push(head(5, entries.length));
      for (const [kb, , x] of entries) {
        parts.push(head(3, kb.length), kb);
        walk(x);
      }
    } else throw new TypeError(`can't encode ${typeof v}`);
  };
  walk(value);
  return concat(...parts);
}

/** Decode exactly one canonical DRISL item that fills `bytes`. Throws on anything non-canonical. */
export function decode(bytes: Uint8Array): DrislValue {
  const { value, next } = decodeAt(bytes, 0);
  if (next !== bytes.length) throw new Error(`${bytes.length - next} trailing bytes after DRISL item`);
  return value;
}

function decodeAt(b: Uint8Array, off: number): { value: DrislValue; next: number } {
  const need = (n: number) => {
    if (off + n > b.length) throw new Error('DRISL truncated');
  };
  need(1);
  const ib = b[off++];
  const major = ib >> 5;
  const info = ib & 0x1f;

  if (major === 7) {
    if (info === 20) return { value: false, next: off };
    if (info === 21) return { value: true, next: off };
    if (info === 22) return { value: null, next: off };
    if (info === 27) {
      need(8);
      const f = new DataView(b.buffer, b.byteOffset + off, 8).getFloat64(0);
      if (!Number.isFinite(f)) throw new Error('non-finite float');
      return { value: f, next: off + 8 };
    }
    throw new Error(`disallowed simple or float 0x${ib.toString(16)}`);
  }

  let arg: bigint;
  if (info < 24) arg = BigInt(info);
  else if (info === 24) {
    need(1);
    arg = BigInt(b[off]);
    off += 1;
    if (arg < 24n) throw new Error('non-minimal integer');
  } else if (info === 25) {
    need(2);
    arg = BigInt((b[off] << 8) | b[off + 1]);
    off += 2;
    if (arg < 0x100n) throw new Error('non-minimal integer');
  } else if (info === 26) {
    need(4);
    arg = BigInt(new DataView(b.buffer, b.byteOffset + off, 4).getUint32(0));
    off += 4;
    if (arg < 0x10000n) throw new Error('non-minimal integer');
  } else if (info === 27) {
    need(8);
    arg = new DataView(b.buffer, b.byteOffset + off, 8).getBigUint64(0);
    off += 8;
    if (arg < 0x100000000n) throw new Error('non-minimal integer');
  } else throw new Error('indefinite lengths and reserved info values are not DRISL');

  const int = (n: bigint): number | bigint => (n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n);
  const len = (): number => {
    if (arg > BigInt(b.length)) throw new Error('length exceeds input');
    return Number(arg);
  };

  switch (major) {
    case 0:
      return { value: int(arg), next: off };
    case 1: {
      const n = -1n - arg;
      return { value: n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : n, next: off };
    }
    case 2: {
      const n = len();
      need(n);
      return { value: b.slice(off, off + n), next: off + n };
    }
    case 3: {
      const n = len();
      need(n);
      return { value: fromUtf8(b.subarray(off, off + n)), next: off + n };
    }
    case 4: {
      const n = len();
      const arr: DrislValue[] = [];
      for (let i = 0; i < n; i++) {
        const r = decodeAt(b, off);
        arr.push(r.value);
        off = r.next;
      }
      return { value: arr, next: off };
    }
    case 5: {
      const n = len();
      const obj: Record<string, DrislValue> = Object.create(null);
      let prev: Uint8Array | null = null;
      for (let i = 0; i < n; i++) {
        if (off >= b.length || b[off] >> 5 !== 3) throw new Error('map keys must be text strings');
        const kStart = off;
        const k = decodeAt(b, off);
        const kb = b.subarray(kStart, k.next);
        if (prev && (kb.length < prev.length || (kb.length === prev.length && compareBytes(kb, prev) <= 0)))
          throw new Error('map keys out of order or duplicated');
        prev = kb;
        const v = decodeAt(b, k.next);
        obj[k.value as string] = v.value;
        off = v.next;
      }
      return { value: { ...obj }, next: off };
    }
    case 6: {
      if (arg !== 42n) throw new Error(`tag ${arg} is not allowed`);
      const inner = decodeAt(b, off);
      if (!(inner.value instanceof Uint8Array) || inner.value[0] !== 0x00) throw new Error('tag 42 must wrap 0x00-prefixed bytes');
      return { value: Cid.fromBytes(inner.value.subarray(1)), next: inner.next };
    }
  }
  throw new Error('unreachable');
}

/** Lexicon JSON to DRISL values: {"$link"} becomes a Cid and {"$bytes"} bytes. */
export function fromLexJson(v: unknown): DrislValue {
  if (v instanceof Uint8Array || v instanceof Cid) return v;
  if (Array.isArray(v)) return v.map(fromLexJson);
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    const o = v as Record<string, unknown>;
    if (keys.length === 1 && keys[0] === '$link' && typeof o.$link === 'string') return Cid.parse(o.$link);
    if (keys.length === 1 && keys[0] === '$bytes' && typeof o.$bytes === 'string') return fromB64(o.$bytes);
    return Object.fromEntries(keys.map((k) => [k, fromLexJson(o[k])]));
  }
  return v as DrislValue;
}

/** DRISL values back to lexicon JSON. */
export function toLexJson(v: DrislValue): unknown {
  if (v instanceof Cid) return { $link: v.toString() };
  if (v instanceof Uint8Array) return { $bytes: b64(v).replace(/=+$/, '') };
  if (Array.isArray(v)) return v.map(toLexJson);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toLexJson(x)]));
  return typeof v === 'bigint' ? v.toString() : v;
}

/** A record's DASL CID: SHA-256 over its DRISL encoding, from lexicon JSON. */
export function recordCid(lexJson: unknown): Cid {
  return Cid.of(0x71, encode(fromLexJson(lexJson)));
}
