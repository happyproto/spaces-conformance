// Credentials from a foreign authority, and their revocation
// (#space-credential, #credential-expiration-and-revocation). The harness is
// the authority: an account on the host under test writes into a space under
// the harness's DID, and the harness mints credentials for that space and
// sends notifyCredentialsRevoked (2026-10-29: notifyCredentialRevoked) to the
// account's repo host with service auth as the authority.
//
// The spec doesn't say what `aud` that service auth carries (2026-10-29's
// lexicon says the repo DID; 2026-11-12 says nothing). The harness tries the
// repo DID, then the host's own did:web, and records which one was taken. A
// host that refuses both on auth grounds leaves the rows pending.

import { assertion, fail, pending } from '../../harness/assert.ts';
import type { ForeignAuthority } from '../../harness/actors/authority.ts';
import { SpaceSync } from '../../harness/actors/space-sync.ts';
import type { Account } from '../../harness/adapter.ts';
import type { RunContext } from '../../harness/context.ts';
import { generate } from '../../harness/crypto/keys.ts';
import { http, type HttpResponse, json } from '../../harness/http.ts';
import { ownerSpace, settled, SPACE_TYPE, xrpcUrl } from '../fixtures.ts';
import { note, writes } from '../repo.ts';
import { foreignAuthority, setupOk, short, transient, useReceiver } from '../sync.ts';

const receiver = useReceiver();

const revokeMethod = (ctx: RunContext) => (settled(ctx) ? 'com.atproto.space.notifyCredentialsRevoked' : 'com.atproto.space.notifyCredentialRevoked');

/** A credential from the harness authority for `space`, ready to present. */
function minted(authority: ForeignAuthority, space: string) {
  const key = generate('p256');
  const c = authority.credential(space, key);
  const sync = new SpaceSync('', space, true);
  sync.adopt(c.token, key);
  return { jti: c.jti, sync };
}

/** The owner's repo in a fresh space under the harness authority, and two credentials for it. */
async function foreignRepo(ctx: RunContext) {
  const authority = await foreignAuthority(ctx, receiver());
  const { owner } = await ownerSpace(ctx);
  const space = authority.space(SPACE_TYPE);
  setupOk('createRecord into a space under a foreign authority', await writes({ ctx, owner, space }).create(note('revocable')));
  return { authority, owner, space, c1: minted(authority, space), c2: minted(authority, space) };
}

const read = (owner: Account, c: { sync: SpaceSync }) => c.sync.latestCommit(owner.repoHost, owner.did);

/** The aud forms the harness tries for service auth to the repo host, in order. */
const audiences = (owner: Account) => [owner.did, `did:web:${new URL(owner.repoHost).host}`];

/** Send the revocation, trying each aud until one isn't refused on auth grounds. */
async function revoke(ctx: RunContext, authority: ForeignAuthority, owner: Account, space: string, jtis: string[], aud?: string) {
  const method = revokeMethod(ctx);
  const tried: Record<string, string> = {};
  for (const a of aud ? [aud] : audiences(owner)) {
    const r = await http(xrpcUrl(owner.repoHost, method), { ...json({ space, credentials: jtis }), headers: { 'content-type': 'application/json', authorization: `Bearer ${authority.serviceAuth(a, method)}` } });
    tried[a] = short(r);
    if (r.status !== 401 && r.status !== 403) return { r, aud: a, tried };
  }
  return { r: undefined as HttpResponse | undefined, aud: undefined, tried };
}

/** Controls: both credentials read the repo, or nothing below says anything. */
async function bothRead(owner: Account, c1: { sync: SpaceSync }, c2: { sync: SpaceSync }) {
  const [a, b] = [await read(owner, c1), await read(owner, c2)];
  if (a.status !== 200 || b.status !== 200)
    pending(`the host doesn't serve the repo to the harness authority's credentials before any revocation (${short(a)}; ${short(b)}); cred.foreign-authority-accepted grades that`);
}

assertion('cred.foreign-authority-accepted', async (ctx) => {
  const { owner, c1 } = await foreignRepo(ctx);
  const r = await read(owner, c1);
  if (transient(r)) pending(`getLatestCommit with the credential answered ${short(r)}`);
  if (r.status !== 200) fail(`getLatestCommit with a credential from the space's (foreign) authority answered ${short(r)}`, { answer: short(r) });
  // Control: the same read without a credential is refused, or the 200 says nothing about the credential.
  const bare = await http(xrpcUrl(owner.repoHost, 'com.atproto.space.getLatestCommit', { space: c1.sync.space, repo: owner.did }));
  if (bare.status === 200) pending('the host serves the repo with no credential at all, so accepting this one says nothing');
});

assertion('cred.revoked-jti-rejected', async (ctx) => {
  if (!(ctx.manifest.capabilities as { repo_host?: { foreign_authorities?: boolean } }).repo_host?.foreign_authorities) pending("needs the adapter's revokeCredential hook: the implementation claims no foreign authorities, so the harness can't be the authority");
  const { authority, owner, space, c1, c2 } = await foreignRepo(ctx);
  await bothRead(owner, c1, c2);
  const { r, aud, tried } = await revoke(ctx, authority, owner, space, [c1.jti]);
  if (!r) pending(`the host refused ${revokeMethod(ctx)} on auth grounds for every aud the harness tried (${JSON.stringify(tried)}); the spec doesn't name the aud`);
  setupOk(revokeMethod(ctx), r!);
  const [a, b] = [await read(owner, c1), await read(owner, c2)];
  const evidence = { revoke: short(r!), aud: aud!, revoked: short(a), other: short(b) };
  if (transient(a)) pending(`the read with the revoked credential answered ${short(a)}`);
  if (a.status === 200) fail('after the authority revoked its jti, the credential still reads the repo', evidence);
  // Control after: the other credential still reads, or the refusal is about something else.
  if (b.status !== 200) pending(`after the revocation the other credential is refused too (${short(b)}), so the refusal above isn't about the jti`);
});

assertion('cred.revocation-idempotent', async (ctx) => {
  const { authority, owner, space, c1, c2 } = await foreignRepo(ctx);
  await bothRead(owner, c1, c2);
  const method = revokeMethod(ctx);
  const first = await revoke(ctx, authority, owner, space, [c1.jti]);
  if (!first.r) pending(`the host refused ${method} on auth grounds for every aud the harness tried (${JSON.stringify(first.tried)}); the spec doesn't name the aud`);
  if (transient(first.r!)) pending(`the first ${method} answered ${short(first.r!)}`);
  if (first.r!.status >= 300) fail(`the first ${method} answered ${short(first.r!)}`, { aud: first.aud!, tried: JSON.stringify(first.tried) });
  const afterFirst = [await read(owner, c1), await read(owner, c2)];
  if (afterFirst[0].status === 200 || afterFirst[1].status !== 200)
    pending(`after the first revocation, the revoked credential answers ${afterFirst[0].status} and the other ${afterFirst[1].status}; cred.revoked-jti-rejected grades that`);
  const second = await revoke(ctx, authority, owner, space, [c1.jti], first.aud);
  const afterSecond = [await read(owner, c1), await read(owner, c2)];
  const evidence = { aud: first.aud!, first: short(first.r!), second: second.r ? short(second.r) : JSON.stringify(second.tried), revoked: short(afterSecond[0]), other: short(afterSecond[1]) };
  if (!second.r) fail(`the same ${method}, sent again, was refused on auth grounds`, evidence);
  if (transient(second.r!)) pending(`the second ${method} answered ${short(second.r!)}`);
  if (second.r!.status >= 300) fail(`the same ${method}, sent again, answered ${short(second.r!)}`, evidence);
  if (afterSecond[0].status === 200) fail('after the repeated revocation, the revoked credential reads the repo again', evidence);
  if (afterSecond[1].status !== 200) fail('after the repeated revocation, the other credential is refused, though it was served after the first', evidence);
});
