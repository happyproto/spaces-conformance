// Delegation tokens (#delegation-token). The harness made the account's
// identity, so it holds the signing key and mints each token itself; the
// space host is asked for a credential with it (getSpaceCredential on Oct 29,
// authorizeSpaceSync from Nov 12, both with a fresh P-256 credential key).

import { assertion, fail, pending, setup } from '../../harness/assert.ts';
import type { Account } from '../../harness/adapter.ts';
import type { RunContext } from '../../harness/context.ts';
import { hex } from '../../harness/crypto/bytes.ts';
import { didKey, generate, type KeyPair } from '../../harness/crypto/keys.ts';
import { signJwt } from '../../harness/crypto/jwt.ts';
import { http, json } from '../../harness/http.ts';
import { randomBytes } from 'node:crypto';
import { ownerSpace, settled, xrpcUrl } from '../fixtures.ts';

const TYP = 'atproto-space-delegation+jwt';

/** A delegation token for `owner` on `space`; `header` replaces the default kid. */
function delegationToken(owner: Account, space: string, key: KeyPair, header: Record<string, unknown> = { kid: '#atproto' }): string {
  const spaceDid = space.slice('at://'.length).split('/')[0];
  const iat = Math.floor(Date.now() / 1000);
  return signJwt(
    { typ: TYP, ...header },
    { iss: owner.did, sub: space, aud: `${spaceDid}#atproto_pds`, iat, exp: iat + 60, jti: hex(randomBytes(16)) },
    key,
  );
}

/** Ask the space host for a credential with `token`, in the run's revision's method. */
function requestCredential(ctx: RunContext, owner: Account, space: string, token: string) {
  const credentialKey = didKey(generate('p256'));
  return settled(ctx)
    ? http(xrpcUrl(owner.repoHost, 'com.atproto.space.authorizeSpaceSync'), json({ space, credentialKey, delegationToken: token }))
    : http(xrpcUrl(owner.repoHost, 'com.atproto.space.getSpaceCredential'), json({ space, credentialKid: credentialKey, delegationToken: token }));
}

assertion('cred.delegation-token-kid-enforced', async (ctx) => {
  const { owner, space } = await ownerSpace(ctx);
  if (!owner.keys) pending("the harness doesn't hold this account's signing key");
  const { signing, others } = owner.keys!;
  const other = others[0];
  if (!other) pending('the account lists no second key to sign with');
  // Control: the same request with a well-formed token. If the host refuses
  // that too, its refusals below say nothing about kid, so the row can't be
  // judged (a host that refuses every token would pass vacuously).
  const control = await setup('a credential for a well-formed delegation token', () => requestCredential(ctx, owner, space, delegationToken(owner, space, signing)));
  if (control.status !== 200 || typeof control.body?.credential !== 'string')
    pending(`the host refused a well-formed delegation token too (${control.status} ${JSON.stringify(control.body).slice(0, 200)}), so kid enforcement can't be told apart`);
  const negatives: [string, string][] = [
    ['no kid', delegationToken(owner, space, signing, {})],
    ['kid "atproto"', delegationToken(owner, space, signing, { kid: 'atproto' })],
    ['kid "#atproto_label"', delegationToken(owner, space, signing, { kid: '#atproto_label' })],
    [`kid "${owner.did}#atproto"`, delegationToken(owner, space, signing, { kid: `${owner.did}#atproto` })],
    [`kid "#atproto", signed by the ${other.id} key`, delegationToken(owner, space, other.key)],
  ];
  const granted: string[] = [];
  const answers: Record<string, string> = {};
  for (const [name, token] of negatives) {
    const r = await requestCredential(ctx, owner, space, token);
    answers[name] = `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
    if (r.status < 300) granted.push(name);
  }
  if (granted.length) fail(`a credential was granted for a delegation token with ${granted.join('; ')}`, { answers: JSON.stringify(answers) });
});
