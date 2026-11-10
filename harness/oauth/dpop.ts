// DPoP (RFC 9449) proofs and requests, with the nonce dance atproto
// authorization and resource servers use.

import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { b64url, fromB64url, utf8 } from '../crypto/bytes.ts';
import { signJwt } from '../crypto/jwt.ts';
import { curveOf, fromSecret, type KeyPair } from '../crypto/keys.ts';
import { http, type HttpResponse } from '../http.ts';

/** The public JWK for a P-256 key. */
export function publicJwk(key: KeyPair) {
  if (key.curve !== 'p256') throw new Error('DPoP keys are P-256');
  const full = curveOf('p256').Point.fromBytes(key.compressed).toBytes(false);
  return { kty: 'EC', crv: 'P-256', x: b64url(full.slice(1, 33)), y: b64url(full.slice(33, 65)) };
}

/** A key from a private JWK, e.g. the one HappyView provisions. */
export function keyFromJwk(jwk: { kty?: string; crv?: string; d?: string }): KeyPair {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) throw new Error('expected a private P-256 JWK');
  return fromSecret('p256', fromB64url(jwk.d));
}

/** The access-token hash for `ath`. */
export const ath = (token: string): string => b64url(sha256(utf8(token)));

/** The htu of a URL: scheme, host and path, no query or fragment. */
export const htuOf = (url: string): string => {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
};

export function dpopProof(key: KeyPair, htm: string, htu: string, opts: { nonce?: string; accessToken?: string; now?: number } = {}): string {
  const payload: Record<string, unknown> = {
    jti: b64url(randomBytes(16)),
    htm,
    htu,
    iat: Math.floor((opts.now ?? Date.now()) / 1000),
  };
  if (opts.nonce) payload.nonce = opts.nonce;
  if (opts.accessToken) payload.ath = ath(opts.accessToken);
  return signJwt({ typ: 'dpop+jwt', jwk: publicJwk(key) }, payload, key);
}

function isNonceChallenge(r: HttpResponse): boolean {
  if (r.status !== 400 && r.status !== 401) return false;
  if (r.body && typeof r.body === 'object' && r.body.error === 'use_dpop_nonce') return true;
  return /use_dpop_nonce/.test(r.headers.get('www-authenticate') ?? '');
}

/** Remembers the latest DPoP-Nonce per origin, as a client should. */
export class NonceStore {
  private byOrigin = new Map<string, string>();
  get(url: string) {
    return this.byOrigin.get(new URL(url).origin);
  }
  set(url: string, nonce: string | null) {
    if (nonce) this.byOrigin.set(new URL(url).origin, nonce);
  }
}

/**
 * A DPoP-bound request. On a use_dpop_nonce challenge it retries once with
 * the server's nonce; a second challenge is returned to the caller as is.
 */
export async function dpopRequest(
  key: KeyPair,
  method: string,
  url: string,
  opts: { body?: BodyInit; headers?: Record<string, string>; accessToken?: string; nonces?: NonceStore } = {},
): Promise<HttpResponse> {
  const nonces = opts.nonces ?? new NonceStore();
  let r: HttpResponse | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    headers.dpop = dpopProof(key, method, htuOf(url), { nonce: nonces.get(url), accessToken: opts.accessToken });
    if (opts.accessToken) headers.authorization = `DPoP ${opts.accessToken}`;
    r = await http(url, { method, headers, body: opts.body });
    const before = nonces.get(url);
    nonces.set(url, r.headers.get('dpop-nonce'));
    if (!isNonceChallenge(r) || nonces.get(url) === before) return r;
  }
  return r!;
}
