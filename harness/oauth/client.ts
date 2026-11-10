// A scripted atproto OAuth client: AS discovery, PAR with PKCE and DPoP,
// consent through an implementation's headless consent script, and the
// token exchange. Proven against pds.js in the phase 0 spike.

import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { b64url, utf8 } from '../crypto/bytes.ts';
import type { KeyPair } from '../crypto/keys.ts';
import { http } from '../http.ts';
import { dpopRequest, NonceStore } from './dpop.ts';

export const LOOPBACK_REDIRECT = 'http://127.0.0.1/callback';

/**
 * A loopback client id: its metadata is generated from its own query, so
 * nothing has to host a metadata document inside a closed stack.
 */
export const loopbackClientId = (scope: string, redirectUri = LOOPBACK_REDIRECT): string =>
  `http://localhost?${new URLSearchParams({ redirect_uri: redirectUri, scope })}`;

export interface AuthServer {
  issuer: string;
  pushed_authorization_request_endpoint: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

export async function discover(issuer: string): Promise<AuthServer> {
  const r = await http(`${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`);
  if (r.status !== 200 || typeof r.body !== 'object') throw new Error(`no AS metadata at ${issuer} (${r.status})`);
  const m = r.body as AuthServer;
  // RFC 8414 §3.3: the metadata's issuer must be the issuer it was fetched for.
  if (m.issuer !== issuer.replace(/\/$/, '')) throw new Error(`AS metadata at ${issuer} names issuer ${m.issuer}`);
  if (!m.pushed_authorization_request_endpoint || !m.token_endpoint) throw new Error(`AS ${issuer} lacks PAR or token endpoints`);
  return m;
}

export function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(sha256(utf8(verifier))) };
}

/** Approves a pushed request without a browser and returns the redirect URL. */
export interface Consent {
  approve(as: AuthServer, args: { requestUri: string; clientId: string }): Promise<string>;
}

/** What the AS granted. `scope` is the AS's answer, which may differ from the request. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope: string;
  sub: string;
  issuer: string;
  tokenType: string;
}

export interface AuthorizeOptions {
  issuer: string;
  clientId: string;
  redirectUri?: string;
  scope: string;
  loginHint?: string;
  dpopKey: KeyPair;
  consent: Consent;
  pkce?: { verifier: string; challenge: string };
}

export class OAuthError extends Error {
  readonly step: 'par' | 'consent' | 'token';
  readonly status: number;
  readonly body: unknown;
  constructor(step: 'par' | 'consent' | 'token', status: number, body: unknown) {
    super(`OAuth ${step} failed (${status}): ${JSON.stringify(body)}`);
    this.step = step;
    this.status = status;
    this.body = body;
  }
}

const formBody = (fields: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

export async function authorize(o: AuthorizeOptions): Promise<TokenSet> {
  const as = await discover(o.issuer);
  const redirectUri = o.redirectUri ?? LOOPBACK_REDIRECT;
  const p = o.pkce ?? pkce();
  const state = b64url(randomBytes(12));
  const nonces = new NonceStore();

  const parBody: Record<string, string> = {
    client_id: o.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: o.scope,
    state,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  };
  if (o.loginHint) parBody.login_hint = o.loginHint;
  const par = await dpopRequest(o.dpopKey, 'POST', as.pushed_authorization_request_endpoint, { ...formBody(parBody), nonces });
  if (par.status >= 300 || !par.body?.request_uri) throw new OAuthError('par', par.status, par.body);

  const redirect = new URL(await o.consent.approve(as, { requestUri: par.body.request_uri, clientId: o.clientId }));
  if (redirect.searchParams.get('error')) throw new OAuthError('consent', 400, Object.fromEntries(redirect.searchParams));
  if (redirect.searchParams.get('state') !== state) throw new OAuthError('consent', 400, { error: 'state mismatch' });
  // RFC 9207: atproto requires iss on the authorization response.
  const iss = redirect.searchParams.get('iss');
  if (iss !== as.issuer) throw new OAuthError('consent', 400, { error: iss ? `iss ${iss} is not ${as.issuer}` : 'redirect has no iss' });
  const code = redirect.searchParams.get('code');
  if (!code) throw new OAuthError('consent', 400, { error: 'no code' });

  const tok = await dpopRequest(o.dpopKey, 'POST', as.token_endpoint, {
    ...formBody({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: o.clientId, code_verifier: p.verifier }),
    nonces,
  });
  if (tok.status >= 300 || !tok.body?.access_token) throw new OAuthError('token', tok.status, tok.body);
  const b = tok.body;
  if (o.loginHint?.startsWith('did:') && b.sub !== o.loginHint)
    throw new OAuthError('token', tok.status, { error: `token sub ${b.sub} is not the account that signed in (${o.loginHint})` });
  if (String(b.token_type).toLowerCase() !== 'dpop') throw new OAuthError('token', tok.status, { error: `token_type ${b.token_type} is not DPoP` });
  return {
    accessToken: b.access_token,
    refreshToken: b.refresh_token,
    expiresAt: typeof b.expires_in === 'number' ? new Date(Date.now() + b.expires_in * 1000).toISOString() : undefined,
    scope: typeof b.scope === 'string' ? b.scope : '',
    sub: b.sub,
    issuer: as.issuer,
    tokenType: b.token_type,
  };
}
