// Compact JWS with ES256 (P-256) and ES256K (secp256k1), r||s signatures.

import { b64url, fromB64url, fromUtf8, utf8 } from './bytes.ts';
import { type Curve, curveOf, type KeyPair, type PublicKey } from './keys.ts';

export const algOf = (c: Curve) => (c === 'p256' ? 'ES256' : 'ES256K');

export interface Jwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
}

export function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyPair): string {
  const h = { ...header, alg: algOf(key.curve) };
  const input = `${b64url(utf8(JSON.stringify(h)))}.${b64url(utf8(JSON.stringify(payload)))}`;
  const sig = curveOf(key.curve).sign(utf8(input), key.secret, { lowS: true });
  return `${input}.${b64url(sig)}`;
}

export function decodeJwt(token: string): Jwt {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('a JWT has three parts');
  const json = (s: string) => {
    const v = JSON.parse(fromUtf8(fromB64url(s)));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('JWT part is not an object');
    return v as Record<string, unknown>;
  };
  return { header: json(parts[0]), payload: json(parts[1]), signingInput: `${parts[0]}.${parts[1]}`, signature: fromB64url(parts[2]) };
}

/** Verify against `key`. `alg` must match the key's curve. High-S is accepted unless `lowS` is set. */
export function verifyJwt(jwt: Jwt, key: PublicKey, opts: { lowS?: boolean } = {}): boolean {
  if (jwt.header.alg !== algOf(key.curve)) return false;
  if (jwt.signature.length !== 64) return false;
  try {
    return curveOf(key.curve).verify(jwt.signature, utf8(jwt.signingInput), key.compressed, { lowS: opts.lowS ?? false });
  } catch {
    return false;
  }
}
