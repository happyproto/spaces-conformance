// Delegation tokens (#delegation-token) and the credential request they go
// with, shared by the credential and deletion suites. The harness mints each
// token itself, with the account's key when it made the account's identity.

import type { Account } from '../../harness/adapter.ts';
import type { RunContext } from '../../harness/context.ts';
import { hex } from '../../harness/crypto/bytes.ts';
import { didKey, generate, type KeyPair } from '../../harness/crypto/keys.ts';
import { signJwt } from '../../harness/crypto/jwt.ts';
import { http, json } from '../../harness/http.ts';
import { randomBytes } from 'node:crypto';
import { settled, xrpcUrl } from '../fixtures.ts';

const TYP = 'atproto-space-delegation+jwt';

/** A delegation token for `owner` on `space`; `header` replaces the default kid. */
export function delegationToken(owner: Account, space: string, key: KeyPair, header: Record<string, unknown> = { kid: '#atproto' }): string {
  const spaceDid = space.slice('at://'.length).split('/')[0];
  const iat = Math.floor(Date.now() / 1000);
  return signJwt(
    { typ: TYP, ...header },
    { iss: owner.did, sub: space, aud: `${spaceDid}#atproto_pds`, iat, exp: iat + 60, jti: hex(randomBytes(16)) },
    key,
  );
}

/** Ask the space host for a credential with `token`, in the run's revision's method. */
export function requestCredential(ctx: RunContext, owner: Account, space: string, token: string) {
  const credentialKey = didKey(generate('p256'));
  return settled(ctx)
    ? http(xrpcUrl(owner.repoHost, 'com.atproto.space.authorizeSpaceSync'), json({ space, credentialKey, delegationToken: token }))
    : http(xrpcUrl(owner.repoHost, 'com.atproto.space.getSpaceCredential'), json({ space, credentialKid: credentialKey, delegationToken: token }));
}
