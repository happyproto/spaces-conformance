// Spike helpers: keys, did:plc genesis, pds.js bootstrap, DPoP and OAuth.
// Throwaway code for HAP-408 phase 0. The real versions belong in harness/.

import { encode as cborEncode } from '@atcute/cbor';
import { toBase32, toBase58Btc, toBase64Url, fromBase64Url } from '@atcute/multibase';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

export const UA = 'spaces-conformance-spike/0 (+https://github.com/happyproto/spaces-conformance)';
export const PLC = process.env.PLC_URL ?? 'http://plc:2582';

const te = new TextEncoder();
export const b64u = (b: Uint8Array) => toBase64Url(b);
export const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export function log(step: string, data?: unknown) {
  const tail = data === undefined ? '' : ` ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${step}${tail}`);
}

/** fetch with the project user-agent, returning status, headers and parsed body. */
export async function http(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('user-agent', UA);
  const res = await fetch(url, { ...init, headers, redirect: 'manual' });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, body };
}

// --- keys -------------------------------------------------------------------

export type P256Key = { secret: Uint8Array; pub: Uint8Array };

export function newP256(): P256Key {
  const secret = p256.utils.randomSecretKey();
  return { secret, pub: p256.getPublicKey(secret, true) };
}

/** did:key for a compressed P-256 key (multicodec p256-pub 0x1200). */
export function didKey(pub: Uint8Array): string {
  return `did:key:z${toBase58Btc(new Uint8Array([0x80, 0x24, ...pub]))}`;
}

export function jwkPublic(key: P256Key) {
  const full = p256.Point.fromBytes(key.pub).toBytes(false);
  return { kty: 'EC', crv: 'P-256', x: b64u(full.slice(1, 33)), y: b64u(full.slice(33, 65)) };
}

export function keyFromJwk(jwk: { d: string }): P256Key {
  const secret = fromBase64Url(jwk.d);
  return { secret, pub: p256.getPublicKey(secret, true) };
}

export function jws(header: object, payload: object, key: P256Key): string {
  const input = `${b64u(te.encode(JSON.stringify(header)))}.${b64u(te.encode(JSON.stringify(payload)))}`;
  const sig = p256.sign(te.encode(input), key.secret, { lowS: true }); // compact r||s, sha256 prehash
  return `${input}.${b64u(sig)}`;
}

// --- did:plc ----------------------------------------------------------------

/** Register a did:plc genesis op for an account on `pdsUrl`. */
export async function plcGenesis(opts: {
  signing: P256Key;
  kem: P256Key;
  handle: string;
  pdsUrl: string;
}): Promise<string> {
  const unsigned = {
    type: 'plc_operation',
    rotationKeys: [didKey(opts.signing.pub)],
    verificationMethods: { atproto: didKey(opts.signing.pub), atproto_kem: didKey(opts.kem.pub) },
    alsoKnownAs: [`at://${opts.handle}`],
    services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: opts.pdsUrl } },
    prev: null,
  };
  const sig = p256.sign(cborEncode(unsigned), opts.signing.secret, { lowS: true });
  const signed = { ...unsigned, sig: b64u(sig) };
  const did = `did:plc:${toBase32(sha256(cborEncode(signed))).slice(0, 24)}`;
  const r = await http(`${PLC}/${did}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signed),
  });
  if (r.status >= 300) throw new Error(`PLC refused genesis: ${r.status} ${JSON.stringify(r.body)}`);
  return did;
}

/** pds.js has one account and no createAccount: register via PLC, then /init. */
export async function pdsjsAccount(pdsUrl: string, handle: string, password: string) {
  const existing = await http(`${pdsUrl}/.well-known/atproto-did`);
  if (existing.status === 200) return { did: String(existing.body).trim(), created: false };
  const signing = newP256();
  const kem = newP256();
  const did = await plcGenesis({ signing, kem, handle, pdsUrl });
  const r = await http(`${pdsUrl}/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ did, privateKey: hex(signing.secret), kemKey: hex(kem.secret), handle, curve: 'p256', password }),
  });
  if (r.status >= 300) throw new Error(`pds.js /init: ${r.status} ${JSON.stringify(r.body)}`);
  return { did, created: true };
}

// --- DPoP + OAuth -----------------------------------------------------------

export function dpopProof(key: P256Key, htm: string, htu: string, opts: { nonce?: string; ath?: string } = {}) {
  const payload: Record<string, unknown> = {
    jti: b64u(randomBytes(16)),
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
  };
  if (opts.nonce) payload.nonce = opts.nonce;
  if (opts.ath) payload.ath = opts.ath;
  return jws({ typ: 'dpop+jwt', alg: 'ES256', jwk: jwkPublic(key) }, payload, key);
}

export const ath = (token: string) => b64u(sha256(te.encode(token)));

/** A DPoP-bound request that retries once on a `use_dpop_nonce` challenge. */
export async function dpopFetch(
  key: P256Key,
  method: string,
  url: string,
  opts: { body?: string; headers?: Record<string, string>; token?: string; nonce?: string } = {},
) {
  const htu = url.split('?')[0].split('#')[0];
  let nonce = opts.nonce;
  for (let i = 0; i < 2; i++) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    headers.dpop = dpopProof(key, method, htu, { nonce, ath: opts.token ? ath(opts.token) : undefined });
    if (opts.token) headers.authorization = `DPoP ${opts.token}`;
    const r = await http(url, { method, headers, body: opts.body });
    const next = r.headers.get('dpop-nonce') ?? undefined;
    const challenged =
      (r.status === 400 || r.status === 401) &&
      next &&
      next !== nonce &&
      (JSON.stringify(r.body).includes('use_dpop_nonce') || (r.headers.get('www-authenticate') ?? '').includes('use_dpop_nonce'));
    if (!challenged) return { ...r, nonce: next ?? nonce };
    nonce = next;
  }
  throw new Error(`DPoP nonce loop at ${url}`);
}

export function pkce() {
  const verifier = b64u(randomBytes(32));
  return { verifier, challenge: b64u(sha256(te.encode(verifier))) };
}

/**
 * OAuth against pds.js: PAR, password consent (JSON), token exchange. The
 * DPoP key is the caller's; for HappyView it's the key HappyView provisioned.
 */
export async function pdsjsOAuth(opts: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  loginHint: string;
  password: string;
  dpopKey: P256Key;
  pkce: { verifier: string; challenge: string };
}) {
  const meta = (await http(`${opts.issuer}/.well-known/oauth-authorization-server`)).body;
  log('oauth: AS metadata', { issuer: meta.issuer, par: meta.pushed_authorization_request_endpoint });
  const state = b64u(randomBytes(12));
  const form = new URLSearchParams({
    client_id: opts.clientId,
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    scope: opts.scope,
    state,
    code_challenge: opts.pkce.challenge,
    code_challenge_method: 'S256',
    login_hint: opts.loginHint,
  });
  const par = await dpopFetch(opts.dpopKey, 'POST', meta.pushed_authorization_request_endpoint, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (par.status >= 300) throw new Error(`PAR ${par.status}: ${JSON.stringify(par.body)}`);
  log('oauth: PAR ok', { request_uri: par.body.request_uri });

  const consent = await http(meta.authorization_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      request_uri: par.body.request_uri,
      client_id: opts.clientId,
      password: opts.password,
      action: 'approve',
    }).toString(),
  });
  if (consent.status >= 300 || !consent.body.redirect)
    throw new Error(`consent ${consent.status}: ${JSON.stringify(consent.body)}`);
  const redirect = new URL(consent.body.redirect);
  const code = redirect.searchParams.get('code');
  if (!code || redirect.searchParams.get('state') !== state) throw new Error(`bad redirect ${redirect}`);
  log('oauth: consent approved headlessly', { iss: redirect.searchParams.get('iss') });

  const tok = await dpopFetch(opts.dpopKey, 'POST', meta.token_endpoint, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      code_verifier: opts.pkce.verifier,
    }).toString(),
    nonce: par.nonce,
  });
  if (tok.status >= 300) throw new Error(`token ${tok.status}: ${JSON.stringify(tok.body)}`);
  log('oauth: token', { sub: tok.body.sub, scope: tok.body.scope, token_type: tok.body.token_type, expires_in: tok.body.expires_in });
  return { ...tok.body, issuer: meta.issuer, dpopNonce: tok.nonce } as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope: string;
    sub: string;
    issuer: string;
  };
}
