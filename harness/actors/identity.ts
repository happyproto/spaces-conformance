// DID resolution for the actors (did:plc through the stack's directory,
// did:web over https), and verification of inbound service auth.

import { decodeJwt, verifyJwt } from '../crypto/jwt.ts';
import { http } from '../http.ts';
import { type DidDocument, type Plc, verificationKey } from './plc.ts';

/** The harness's own identity, served at https://harness.test/.well-known/did.json. */
export const HARNESS_DID = 'did:web:harness.test';
export const HARNESS_URL = 'https://harness.test';
export const SYNCER_SERVICE = `${HARNESS_DID}#atproto_space_syncer`;
export const MANAGING_APP_SERVICE = `${HARNESS_DID}#atproto_managing_app`;

export function harnessDidDocument(): DidDocument {
  return {
    id: HARNESS_DID,
    service: [
      { id: '#atproto_space_syncer', type: 'AtprotoSpaceSyncer', serviceEndpoint: HARNESS_URL },
      { id: '#atproto_managing_app', type: 'AtprotoManagingApp', serviceEndpoint: HARNESS_URL },
    ],
  };
}

export class Resolver {
  private readonly plc: Plc;
  private readonly cache = new Map<string, DidDocument>();
  constructor(plc: Plc) {
    this.plc = plc;
  }

  async resolve(did: string, fresh = false): Promise<DidDocument> {
    if (!fresh && this.cache.has(did)) return this.cache.get(did)!;
    let doc: DidDocument;
    if (did.startsWith('did:plc:')) doc = await this.plc.resolve(did);
    else if (did.startsWith('did:web:')) {
      const host = decodeURIComponent(did.slice('did:web:'.length));
      const r = await http(`https://${host}/.well-known/did.json`);
      if (r.status !== 200) throw new Error(`did:web ${did}: ${r.status}`);
      doc = r.body;
    } else throw new Error(`unsupported DID method: ${did}`);
    this.cache.set(did, doc);
    return doc;
  }
}

export interface ServiceAuthCheck {
  ok: boolean;
  reason?: string;
  iss?: string;
  claims?: Record<string, unknown>;
}

/**
 * Verify an inbound service-auth JWT (atproto inter-service auth): signed by
 * the issuer's #atproto key, addressed to `aud` (with or without the service
 * fragment), for method `lxm`, not expired.
 */
export async function verifyServiceAuth(authorization: string | undefined, want: { aud: string; lxm: string }, resolver: Resolver): Promise<ServiceAuthCheck> {
  const token = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1];
  if (!token) return { ok: false, reason: 'no Bearer service auth' };
  let jwt;
  try {
    jwt = decodeJwt(token);
  } catch (e) {
    return { ok: false, reason: `malformed JWT: ${(e as Error).message}` };
  }
  const c = jwt.payload;
  const iss = String(c.iss ?? '');
  const audOk = c.aud === want.aud || c.aud === want.aud.split('#')[0];
  if (!audOk) return { ok: false, reason: `aud ${String(c.aud)} is not ${want.aud}`, iss, claims: c };
  if (c.lxm !== undefined && c.lxm !== want.lxm) return { ok: false, reason: `lxm ${String(c.lxm)} is not ${want.lxm}`, iss, claims: c };
  if (typeof c.exp !== 'number' || c.exp * 1000 < Date.now()) return { ok: false, reason: 'expired or no exp', iss, claims: c };
  const issDid = iss.split('#')[0];
  let key;
  try {
    key = verificationKey(await resolver.resolve(issDid), 'atproto');
    if (!key || !verifyJwt(jwt, key)) key = verificationKey(await resolver.resolve(issDid, true), 'atproto'); // key rotation
  } catch (e) {
    return { ok: false, reason: `can't resolve ${issDid}: ${(e as Error).message}`, iss, claims: c };
  }
  if (!key) return { ok: false, reason: `${issDid} has no #atproto key`, iss, claims: c };
  return verifyJwt(jwt, key) ? { ok: true, iss, claims: c } : { ok: false, reason: `signature doesn't verify against ${issDid}#atproto`, iss, claims: c };
}
