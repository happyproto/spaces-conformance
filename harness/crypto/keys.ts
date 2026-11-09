// P-256 and secp256k1 keys as did:key / atproto multikey.

import { p256 } from '@noble/curves/nist.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { base58btc, concat, fromBase58 } from './bytes.ts';

export type Curve = 'p256' | 'secp256k1';

const PREFIX: Record<Curve, Uint8Array> = {
  p256: new Uint8Array([0x80, 0x24]), // multicodec p256-pub 0x1200
  secp256k1: new Uint8Array([0xe7, 0x01]), // multicodec secp256k1-pub 0xe7
};

export const curveOf = (c: Curve) => (c === 'p256' ? p256 : secp256k1);

export interface PublicKey {
  curve: Curve;
  /** Compressed SEC1 point, 33 bytes. */
  compressed: Uint8Array;
}

export interface KeyPair extends PublicKey {
  secret: Uint8Array;
}

export function generate(curve: Curve = 'p256'): KeyPair {
  const c = curveOf(curve);
  const secret = c.utils.randomSecretKey();
  return { curve, secret, compressed: c.getPublicKey(secret, true) };
}

export function fromSecret(curve: Curve, secret: Uint8Array): KeyPair {
  return { curve, secret, compressed: curveOf(curve).getPublicKey(secret, true) };
}

/** Multibase base58btc multikey, as in publicKeyMultibase. */
export const multikey = (k: PublicKey): string => `z${base58btc(concat(PREFIX[k.curve], k.compressed))}`;
export const didKey = (k: PublicKey): string => `did:key:${multikey(k)}`;

export function parseMultikey(mk: string): PublicKey {
  if (!mk.startsWith('z')) throw new Error('multikey must be base58btc (z...)');
  const b = fromBase58(mk.slice(1));
  for (const curve of ['p256', 'secp256k1'] as const) {
    const p = PREFIX[curve];
    if (b[0] === p[0] && b[1] === p[1]) {
      const compressed = b.slice(2);
      curveOf(curve).Point.fromBytes(compressed); // throws if not on the curve
      return { curve, compressed };
    }
  }
  throw new Error('multikey is neither P-256 nor secp256k1');
}

export function parseDidKey(did: string): PublicKey {
  if (!did.startsWith('did:key:')) throw new Error(`${did} isn't a did:key`);
  return parseMultikey(did.slice('did:key:'.length));
}

/** Uncompressed SEC1 (0x04 || x || y), 65 bytes. */
export const uncompressed = (k: PublicKey): Uint8Array => curveOf(k.curve).Point.fromBytes(k.compressed).toBytes(false);
