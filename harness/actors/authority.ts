// The foreign-authority actor: a space authority that isn't the host under
// test. It's a did:plc in the stack's own directory whose #atproto_pds is the
// harness (https://harness.test), so a repo host sends that space's write
// notifications to the harness's receiver (#write-notifications). It signs:
//
//   - space credentials for its spaces (#space-credential), bound to a
//     syncer key, to read members' repos on the host under test;
//   - service auth as the authority (#space-authority), e.g. for
//     notifyCredentialsRevoked (#credential-expiration-and-revocation).
//
// Its key is derived from CONFORMANCE_RUN_ID, as pds.js's account keys are:
// every suite file runs in its own worker, and hosts cache DID documents, so
// every worker must sign with the same key.

import { createHash, randomBytes } from 'node:crypto';
import { hex } from '../crypto/bytes.ts';
import { didKey, fromSecret, type KeyPair, type PublicKey } from '../crypto/keys.ts';
import { signJwt } from '../crypto/jwt.ts';
import { HARNESS_URL } from './identity.ts';
import { genesisOp, type Plc, signGenesis } from './plc.ts';

export const CREDENTIAL_TYP = 'atproto-space-credential+jwt';

/** The authority's signing key for a run: the same in every worker. */
export function authorityKey(seed = process.env.CONFORMANCE_RUN_ID ?? 'local'): KeyPair {
  return fromSecret('p256', new Uint8Array(createHash('sha256').update(`spaces-conformance ${seed} foreign-authority signing`).digest()));
}

export interface MintedCredential {
  token: string;
  jti: string;
  exp: number;
}

export class ForeignAuthority {
  readonly did: string;
  readonly key: KeyPair;
  constructor(did: string, key: KeyPair) {
    this.did = did;
    this.key = key;
  }

  /** Register the authority's DID in the stack's PLC, or find it there. Idempotent. */
  static async ensure(plc: Plc, key = authorityKey()): Promise<ForeignAuthority> {
    const g = { rotation: key, signing: key, pdsUrl: HARNESS_URL };
    const { did } = signGenesis(genesisOp(g), key);
    try {
      await plc.resolve(did);
    } catch {
      await plc.register(g);
    }
    return new ForeignAuthority(did, key);
  }

  /** A space under this authority. */
  space(spaceType: string, skey = hex(randomBytes(6))): string {
    return `at://${this.did}/space/${spaceType}/${skey}`;
  }

  /** A space credential for `space`, bound to `cnf` (#space-credential). */
  credential(space: string, cnf: PublicKey, o: { jti?: string; ttlSec?: number } = {}): MintedCredential {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + (o.ttlSec ?? 600);
    const jti = o.jti ?? hex(randomBytes(16));
    const token = signJwt({ typ: CREDENTIAL_TYP, kid: '#atproto' }, { iss: this.did, sub: space, cnf: { kid: didKey(cnf) }, iat, exp, jti }, this.key);
    return { token, jti, exp };
  }

  /** Inter-service auth from the authority, for `lxm`, addressed to `aud`. */
  serviceAuth(aud: string, lxm: string, ttlSec = 60): string {
    const iat = Math.floor(Date.now() / 1000);
    return signJwt({ typ: 'JWT' }, { iss: this.did, aud, lxm, iat, exp: iat + ttlSec, jti: hex(randomBytes(16)) }, this.key);
  }
}
