// Space deletion (#space-deletion). The owner deletes a fresh space with its
// own session, then asks for a credential for it. From 2026-11-12 the
// authority answers SpaceDeleted "regardless of the request's authorization",
// so the delegation token is signed with the owner's key when the harness
// holds it and with a throwaway key otherwise. At 2026-10-29 the text has no
// such clause, so the row needs the owner's key there. Controls before the
// deletion and on a second, undeleted space must not answer SpaceDeleted.
//
// The notification rows register the harness as a syncer with the space
// host (suites/sync.ts), delete the space, and watch the receiver: at
// 2026-11-12 for a notifySpaceUpdate whose update is #spaceDeleted, at
// 2026-10-29 for notifySpaceDeleted. Registration and deleteSpace are setup
// there: a refusal pends (docs/catalogue.md, "Pending or fail").

import { assertion, fail, pending } from '../../harness/assert.ts';
import type { Received } from '../../harness/actors/receiver.ts';
import type { Account } from '../../harness/adapter.ts';
import { generate } from '../../harness/crypto/keys.ts';
import type { RunContext } from '../../harness/context.ts';
import type { HttpResponse } from '../../harness/http.ts';
import { ownerSpace, settled, slow, SLOW_PENDING, xrpcUrl } from '../fixtures.ts';
import { freshRepo } from '../repo.ts';
import { delegationToken, requestCredential } from '../credentials/delegation-token.ts';
import { credentialed, publicSpace, received, setupOk, useReceiver } from '../sync.ts';

const receiver = useReceiver();

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
  // Control after: a second space that wasn't deleted must not answer
  // SpaceDeleted, or the answer above isn't about this deletion.
  const other = await freshRepo(ctx);
  const live = await requestCredential(ctx, owner, other.space, delegationToken(owner, other.space, key));
  if (live.body?.error === 'SpaceDeleted') fail('the credential request answered SpaceDeleted for a space that was not deleted', { live: short(live) });
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

/** A deletion notice for `space` (to `token`, at 2026-11-12). */
const deletionNotice = (ctx: RunContext, space: string, token?: string) => (e: Received) =>
  e.input.space === space &&
  (settled(ctx)
    ? e.method === 'com.atproto.space.notifySpaceUpdate' && e.input.token === token && String((e.input.update as Record<string, unknown>)?.$type ?? '').endsWith('#spaceDeleted')
    : e.method === 'com.atproto.space.notifySpaceDeleted');

const deleteSpace = (repo: { owner: Account; space: string }) =>
  repo.owner.auth.request('POST', xrpcUrl(repo.owner.repoHost, 'com.atproto.space.deleteSpace'), { space: repo.space });

/** How long a retry may take before deletion.notify-retry says it didn't come. */
const RETRY_WINDOW_MS = slow() ? 15 * 60_000 : 120_000;

/** Wait out the credential behind a registration, so it lapses (#registering-for-notifications). */
async function lapse(sync: { claims(): Record<string, unknown> | undefined }) {
  const wait = Number(sync.claims()?.exp) * 1000 - Date.now() + 15_000;
  if (!(wait > 0) || wait > 11 * 60_000) pending(`the credential's exp leaves ${Math.round(wait / 1000)} s to wait, outside the harness's 11-minute window`);
  await new Promise((r) => setTimeout(r, wait));
}

assertion(
  'deletion.notify-space-deleted',
  async (ctx) => {
    const rx = receiver();
    const { owner } = await ownerSpace(ctx);
    const repo = await publicSpace(ctx, owner);
    const from = rx.mark();
    // At 2026-11-12 a registration whose credential lapsed is notified too. It's made first, so it can lapse.
    const lapsing = settled(ctx) && slow() ? await credentialed(repo, { receiver: rx, register: true }) : undefined;
    if (lapsing) await lapse(lapsing.sync);
    const active = await credentialed(repo, { receiver: rx, register: true });
    setupOk('deleteSpace', await deleteSpace(repo));
    const [notice] = await received(rx, from, deletionNotice(ctx, repo.space, active.token), 1);
    const seen = rx.since(from, (e) => e.input.space === repo.space && e.method !== 'com.atproto.space.confirmRegistration');
    const evidence = { ...active.answers, received: JSON.stringify(seen.map((e) => ({ method: e.method, input: { ...e.input, token: e.input.token === active.token ? 'active' : e.input.token === lapsing?.token ? 'lapsed' : e.input.token } }))).slice(0, 1500) };
    const what = settled(ctx) ? 'a notifySpaceUpdate with #spaceDeleted' : 'notifySpaceDeleted';
    if (!notice) fail(`the registered syncer got no ${what} within 20 s of deleteSpace`, evidence);
    if (!settled(ctx)) return;
    if (!lapsing) pending(`${SLOW_PENDING} (the registered syncer was notified; the lapsed one wasn't checked)`);
    const [late] = await received(rx, from, deletionNotice(ctx, repo.space, lapsing!.token), 1);
    if (!late) fail('the syncer whose registration had lapsed got no deletion notice', evidence);
  },
  { timeoutMs: slow() ? 14 * 60_000 : undefined },
);

assertion(
  'deletion.notify-retry',
  async (ctx) => {
    const rx = receiver();
    const { owner } = await ownerSpace(ctx);
    const repo = await publicSpace(ctx, owner);
    const from = rx.mark();
    const active = await credentialed(repo, { receiver: rx, register: true });
    const isNotice = deletionNotice(ctx, repo.space, active.token);
    // The first deletion notice for this space gets a 503; later ones the default answer.
    let refused = 0;
    const method = settled(ctx) ? 'com.atproto.space.notifySpaceUpdate' : 'com.atproto.space.notifySpaceDeleted';
    rx.respond(method, (e) => (isNotice({ ...e, answered: 0 }) && refused++ === 0 ? { status: 503, body: { error: 'Unavailable', message: 'scripted' } } : undefined));
    try {
      setupOk('deleteSpace', await deleteSpace(repo));
      const first = await received(rx, from, isNotice, 1);
      if (!first.length) pending('no deletion notice came at all, so there is nothing to retry; notify-space-deleted grades that');
      const both = await received(rx, from, isNotice, 2, RETRY_WINDOW_MS);
      const evidence = { window_s: String(RETRY_WINDOW_MS / 1000), deliveries: JSON.stringify(both.map((e) => ({ at: new Date(e.at).toISOString(), answered: e.answered }))) };
      if (both.length < 2) fail(`after the syncer answered 503, the deletion notice was not delivered again within ${RETRY_WINDOW_MS / 1000} s`, evidence);
    } finally {
      rx.respond(method, undefined);
    }
  },
  { timeoutMs: RETRY_WINDOW_MS + 40_000 },
);
