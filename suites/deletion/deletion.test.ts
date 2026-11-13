// Space deletion (#space-deletion). The owner deletes a fresh space with its
// own session, then asks for a credential for it. From 2026-11-12 the
// authority answers SpaceDeleted "regardless of the request's authorization",
// so the delegation token is signed with the owner's key when the harness
// holds it and with a throwaway key otherwise. At 2026-10-29 the text has no
// such clause, so the row needs the owner's key there.
//
// The notification rows need a syncer registered with the space host, which
// is the phase 7 credential path; they pend until then.

import { assertion, fail, pending } from '../../harness/assert.ts';
import { generate } from '../../harness/crypto/keys.ts';
import type { RunContext } from '../../harness/context.ts';
import type { HttpResponse } from '../../harness/http.ts';
import { PHASE7_PENDING, settled, xrpcUrl } from '../fixtures.ts';
import { freshRepo } from '../repo.ts';
import { delegationToken, requestCredential } from '../credentials/delegation-token.ts';

const short = (r: HttpResponse) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;

/** Delete a fresh space, then ask for a credential for it. Pending when the harness can't set that up. */
async function credentialForDeletedSpace(ctx: RunContext) {
  const repo = await freshRepo(ctx);
  const { owner, space } = repo;
  if (!settled(ctx) && !owner.keys) pending("the harness doesn't hold this account's signing key, and at 2026-10-29 the answer may depend on authorization");
  const key = owner.keys?.signing ?? generate('p256');
  // Control: the same request before deletion must not already say SpaceDeleted,
  // or the answer after it says nothing about the deletion.
  const before = await requestCredential(ctx, owner, space, delegationToken(owner, space, key));
  if (before.body?.error === 'SpaceDeleted') fail('the credential request answered SpaceDeleted before the space was deleted', { before: short(before) });
  const del = await owner.auth.request('POST', xrpcUrl(owner.repoHost, 'com.atproto.space.deleteSpace'), { space });
  if (del.status >= 300) pending(`deleteSpace answered ${short(del)}, so there's no deleted space to ask about`);
  const r = await requestCredential(ctx, owner, space, delegationToken(owner, space, key));
  if (r.status === 429 || r.status >= 500) pending(`the credential request answered ${short(r)}, which says nothing about the space`);
  return { r, evidence: { status: r.status, body: JSON.stringify(r.body).slice(0, 500), token_key: owner.keys ? 'owner' : 'harness', before: short(before) } };
}

assertion('deletion.credential-error', async (ctx) => {
  const { r, evidence } = await credentialForDeletedSpace(ctx);
  const method = settled(ctx) ? 'authorizeSpaceSync' : 'getSpaceCredential';
  if (r.status < 300) fail(`${method} granted a credential for a deleted space`, evidence);
  if (r.body?.error !== 'SpaceDeleted') fail(`${method} for a deleted space answered ${r.body?.error ?? r.status}, not SpaceDeleted`, evidence);
});

assertion('xrpc.error.SpaceDeleted', async (ctx) => {
  const { r, evidence } = await credentialForDeletedSpace(ctx);
  if (r.body?.error !== 'SpaceDeleted') pending('the host did not answer SpaceDeleted (deletion.credential-error grades whether it does)');
  if (r.status < 400 || r.status >= 500) fail(`SpaceDeleted came with status ${r.status}, not a 4xx`, evidence);
  if (r.body.message !== undefined && typeof r.body.message !== 'string') fail('the SpaceDeleted body has a message that is not a string', evidence);
});

assertion('deletion.notify-space-deleted', async () => pending(PHASE7_PENDING));
assertion('deletion.notify-retry', async () => pending(PHASE7_PENDING));
