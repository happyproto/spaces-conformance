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
  /**
   * Whether the token names its method. 0016 doesn't require lxm here, so a
   * missing one is accepted but visible. `ok` doesn't depend on this or on
   * aud_form: a row that grades either must assert on it itself.
   */
  lxm_present?: boolean;
  /** The audience the token named, when it was one the harness accepts. */
  aud?: string;
  /** Which form of `aud` the token used: the bare DID, or DID#service. */
  aud_form?: 'did' | 'did#service';
}

/**
 * Verify an inbound service-auth JWT (atproto inter-service auth): signed by
 * the issuer's #atproto key, addressed to `aud` (with or without the service
 * fragment; any of several when `aud` is a list), for method `lxm`, not expired.
 */
export async function verifyServiceAuth(authorization: string | undefined, want: { aud: string | string[]; lxm: string }, resolver: Resolver): Promise<ServiceAuthCheck> {
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
  const auds = Array.isArray(want.aud) ? want.aud : [want.aud];
  const audOk = auds.some((a) => c.aud === a || c.aud === a.split('#')[0]);
  const shape = {
    lxm_present: c.lxm !== undefined,
    ...(audOk ? { aud: String(c.aud), aud_form: (String(c.aud).includes('#') ? 'did#service' : 'did') as ServiceAuthCheck['aud_form'] } : {}),
  };
  if (!audOk) return { ok: false, reason: `aud ${String(c.aud)} is not ${auds.join(' or ') || 'one the harness serves'}`, iss, claims: c, ...shape };
  if (c.lxm !== undefined && c.lxm !== want.lxm) return { ok: false, reason: `lxm ${String(c.lxm)} is not ${want.lxm}`, iss, claims: c, ...shape };
  if (typeof c.exp !== 'number' || c.exp * 1000 < Date.now()) return { ok: false, reason: 'expired or no exp', iss, claims: c, ...shape };
  const issDid = iss.split('#')[0];
  let key;
  try {
    key = verificationKey(await resolver.resolve(issDid), 'atproto');
    if (!key || !verifyJwt(jwt, key)) key = verificationKey(await resolver.resolve(issDid, true), 'atproto'); // key rotation
  } catch (e) {
    return { ok: false, reason: `can't resolve ${issDid}: ${(e as Error).message}`, iss, claims: c, ...shape };
  }
  if (!key) return { ok: false, reason: `${issDid} has no #atproto key`, iss, claims: c, ...shape };
  return verifyJwt(jwt, key) ? { ok: true, iss, claims: c, ...shape } : { ok: false, reason: `signature doesn't verify against ${issDid}#atproto`, iss, claims: c, ...shape };
}
