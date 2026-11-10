// The OAuth/DPoP client, session registration and PLC actor, against
// in-process mock servers (no containers).

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sha256 } from '@noble/hashes/sha2.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { b64url, fromB64url, utf8 } from '../harness/crypto/bytes.ts';
import { encode } from '../harness/crypto/drisl.ts';
import { decodeJwt, verifyJwt } from '../harness/crypto/jwt.ts';
import { curveOf, generate, multikey, parseDidKey } from '../harness/crypto/keys.ts';
import { genesisOp, signGenesis, verificationKey, serviceEndpoint, type DidDocument } from '../harness/actors/plc.ts';
import { authorize, loopbackClientId, OAuthError, type Consent, type TokenSet } from '../harness/oauth/client.ts';
import { ath, dpopProof, dpopRequest, htuOf, keyFromJwk, NonceStore, publicJwk } from '../harness/oauth/dpop.ts';
import { sessionRegistration } from '../harness/oauth/registration.ts';

const body = (req: IncomingMessage) =>
  new Promise<string>((res) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => res(s));
  });

/** A DPoP proof's claims, after checking its signature against its own jwk. */
function checkProof(proof: string) {
  const t = decodeJwt(proof);
  const jwk = t.header.jwk as { x: string; y: string };
  const pub = curveOf('p256').Point.fromBytes(new Uint8Array([0x04, ...fromB64url(jwk.x), ...fromB64url(jwk.y)])).toBytes(true);
  expect(t.header.typ).toBe('dpop+jwt');
  expect(verifyJwt(t, { curve: 'p256', compressed: pub })).toBe(true);
  return t.payload as { htm: string; htu: string; nonce?: string; ath?: string; jti: string };
}

describe('DPoP', () => {
  it('builds a signed proof with htm, htu, nonce and ath', () => {
    const k = generate('p256');
    const p = checkProof(dpopProof(k, 'POST', 'https://as.test/par', { nonce: 'n1', accessToken: 'tok' }));
    expect(p).toMatchObject({ htm: 'POST', htu: 'https://as.test/par', nonce: 'n1', ath: ath('tok') });
    expect(ath('tok')).toBe(b64url(sha256(utf8('tok'))));
    expect(htuOf('https://h.test/xrpc/x?a=1#f')).toBe('https://h.test/xrpc/x');
  });
  it('round trips a private JWK', () => {
    const k = generate('p256');
    const jwk = { ...publicJwk(k), d: b64url(k.secret) };
    expect(Buffer.from(keyFromJwk(jwk).compressed).toString('hex')).toBe(Buffer.from(k.compressed).toString('hex'));
    expect(() => keyFromJwk({ kty: 'EC', crv: 'P-384', d: 'x' })).toThrow();
  });
});

describe('OAuth client against a mock authorization server', () => {
  let server: Server;
  let issuer = '';
  let grant = (requested: string) => requested;
  let tokenType = 'DPoP';
  const seen: { path: string; proof?: string; form: URLSearchParams }[] = [];
  const pushed = new Map<string, URLSearchParams>();

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const form = new URLSearchParams(await body(req));
      const path = new URL(req.url!, issuer).pathname;
      seen.push({ path, proof: req.headers.dpop as string | undefined, form });
      res.setHeader('content-type', 'application/json');
      if (path === '/.well-known/oauth-authorization-server') {
        return res.end(JSON.stringify({ issuer, pushed_authorization_request_endpoint: `${issuer}/par`, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` }));
      }
      const proof = req.headers.dpop ? checkProof(req.headers.dpop as string) : undefined;
      if ((path === '/par' || path === '/token') && proof?.nonce !== 'server-nonce') {
        res.statusCode = 400;
        res.setHeader('dpop-nonce', 'server-nonce');
        return res.end(JSON.stringify({ error: 'use_dpop_nonce' }));
      }
      if (path === '/par') {
        const uri = `urn:req:${pushed.size}`;
        pushed.set(uri, form);
        res.statusCode = 201;
        return res.end(JSON.stringify({ request_uri: uri }));
      }
      if (path === '/authorize') {
        const p = pushed.get(form.get('request_uri')!)!;
        const u = new URL(p.get('redirect_uri')!);
        u.searchParams.set('code', `code-${form.get('request_uri')}`);
        u.searchParams.set('state', p.get('state')!);
        u.searchParams.set('iss', issuer);
        return res.end(JSON.stringify({ redirect: u.toString() }));
      }
      if (path === '/token') {
        const uri = form.get('code')!.replace(/^code-/, '');
        const p = pushed.get(uri)!;
        const ok = b64url(sha256(utf8(form.get('code_verifier')!))) === p.get('code_challenge');
        if (!ok) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
        return res.end(JSON.stringify({ access_token: 'at', refresh_token: 'rt', token_type: tokenType, expires_in: 3600, scope: grant(p.get('scope')!), sub: 'did:plc:alice' }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const consent: Consent = {
    async approve(as, { requestUri, clientId }) {
      const r = await fetch(as.authorization_endpoint, { method: 'POST', body: new URLSearchParams({ request_uri: requestUri, client_id: clientId }) });
      return (await r.json()).redirect;
    },
  };
  const scope = 'atproto space:com.example.conformance.space?authority=*&manage=create';
  const run = () => authorize({ issuer, clientId: loopbackClientId(scope), scope, loginHint: 'did:plc:alice', dpopKey: generate('p256'), consent });

  it('does PAR with PKCE S256 and DPoP, answers the nonce challenge, and exchanges the code', async () => {
    seen.length = 0;
    const t = await run();
    expect(t).toMatchObject({ accessToken: 'at', refreshToken: 'rt', scope, sub: 'did:plc:alice', issuer, tokenType: 'DPoP' });
    const par = seen.filter((s) => s.path === '/par');
    expect(par).toHaveLength(2); // challenged once, then accepted
    expect(par[1].form.get('code_challenge_method')).toBe('S256');
    expect(par[1].form.get('client_id')).toBe(loopbackClientId(scope));
    // The token request reuses the nonce learned at PAR, so it isn't challenged again.
    expect(seen.filter((s) => s.path === '/token')).toHaveLength(1);
  });

  it('reports the scope the AS granted, not the one requested', async () => {
    grant = () => 'atproto';
    try {
      expect((await run()).scope).toBe('atproto');
    } finally {
      grant = (r) => r;
    }
  });

  it('refuses a token that is not DPoP-bound', async () => {
    tokenType = 'Bearer';
    try {
      await expect(run()).rejects.toBeInstanceOf(OAuthError);
    } finally {
      tokenType = 'DPoP';
    }
  });

  it('refuses a redirect whose state does not match', async () => {
    const bad: Consent = { approve: async (as, a) => (await consent.approve(as, a)).replace(/state=[^&]+/, 'state=forged') };
    await expect(authorize({ issuer, clientId: 'x', scope, dpopKey: generate('p256'), consent: bad })).rejects.toThrow(/state/);
  });

  it('keeps nonces per origin across requests', async () => {
    const nonces = new NonceStore();
    const k = generate('p256');
    await dpopRequest(k, 'POST', `${issuer}/par`, { nonces, body: 'scope=atproto' });
    expect(nonces.get(`${issuer}/token`)).toBe('server-nonce');
  });
});

describe('session registration', () => {
  const tokens: TokenSet = { accessToken: 'at', refreshToken: 'rt', scope: 'atproto', sub: 'did:plc:carol', issuer: 'http://pds.test', tokenType: 'DPoP' };

  it('registers exactly the scope the AS granted, for the token subject', () => {
    const r = sessionRegistration('hvp_1', tokens);
    expect(r).toEqual({ provision_id: 'hvp_1', did: 'did:plc:carol', access_token: 'at', refresh_token: 'rt', expires_at: undefined, scopes: 'atproto', issuer: 'http://pds.test' });
  });

  it('has no way to register a different scope', () => {
    expect(sessionRegistration.length).toBe(2);
    const wider = 'atproto space:*?authority=*&manage=create&manage=update&manage=delete&collection=*';
    // Extra arguments are ignored, whatever a caller passes.
    const r = (sessionRegistration as (...a: unknown[]) => ReturnType<typeof sessionRegistration>)('hvp_1', tokens, wider, { scopes: wider });
    expect(r.scopes).toBe('atproto');
  });

  it('refuses a token set without atproto or a subject', () => {
    expect(() => sessionRegistration('p', { ...tokens, scope: 'transition:generic' })).toThrow(/atproto/);
    expect(() => sessionRegistration('p', { ...tokens, sub: '' })).toThrow(/subject/);
  });
});

describe('PLC actor', () => {
  it('signs a genesis op the rotation key verifies, and derives a stable did:plc', () => {
    const rotation = generate('p256');
    const kem = generate('p256');
    const op = genesisOp({ rotation, signing: rotation, kem, handle: 'alice.test', pdsUrl: 'http://pdsjs-alice.test' });
    const { did, signed } = signGenesis(op, rotation);
    expect(did).toMatch(/^did:plc:[a-z2-7]{24}$/);
    const { sig, ...unsigned } = signed;
    expect(curveOf('p256').verify(fromB64url(sig), encode(unsigned as never), rotation.compressed)).toBe(true);
    // The DID hashes the signed op, so it follows the signature bytes.
    expect(signGenesis(op, rotation).did).toMatch(/^did:plc:/);
    expect(Buffer.from(parseDidKey(op.verificationMethods.atproto_kem).compressed).equals(Buffer.from(kem.compressed))).toBe(true);
    expect(op.services.atproto_pds.endpoint).toBe('http://pdsjs-alice.test');
  });

  it('reads #atproto_kem and #atproto_pds from a DID document', () => {
    const kem = generate('p256');
    const doc: DidDocument = {
      id: 'did:plc:x',
      verificationMethod: [{ id: 'did:plc:x#atproto_kem', type: 'Multikey', controller: 'did:plc:x', publicKeyMultibase: multikey(kem) }],
      service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://h.test' }],
    };
    expect(verificationKey(doc, 'atproto_kem')?.curve).toBe('p256');
    expect(serviceEndpoint(doc, 'atproto_pds')).toBe('https://h.test');
    expect(verificationKey({ ...doc, verificationMethod: [{ ...doc.verificationMethod![0], controller: 'did:plc:y' }] }, 'atproto_kem')).toBeNull();
  });
});
