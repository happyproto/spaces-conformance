// The writer set and write notifications (#write-notifications,
// #registering-for-notifications, #the-sync-boundary-writer-set). The harness
// plays three parts here:
//
//   - a foreign space authority, whose space host is the receiver, so a repo
//     host's write notification comes to the harness (notify-write-sent);
//   - a credentialed syncer registered with the host's space host, so the
//     host's notifications to syncers come to the receiver;
//   - a reader of the writer set with a space credential.
//
// Spaces here are memberspace with publicRead, so the credential needs no
// delegation token, and publicWrite where a second account writes. Setup
// steps pend on a refusal; the method a row is about fails on one
// (docs/catalogue.md, "Pending or fail").

import { assertion, fail, pending } from '../../harness/assert.ts';
import { SYNCER_SERVICE } from '../../harness/actors/identity.ts';
import type { Received } from '../../harness/actors/receiver.ts';
import { latestByRepo, type Writer, type WriterSet } from '../../harness/actors/space-sync.ts';
import type { RunContext } from '../../harness/context.ts';
import type { Account } from '../../harness/adapter.ts';
import { memberAccount, ownerSpace, settled, slow, SLOW_PENDING, SPACE_TYPE, xrpcUrl } from '../fixtures.ts';
import { note, type Repo, writes } from '../repo.ts';
import { commitOf, credentialed, foreignAuthority, publicSpace, received, setupOk, short, transient, unpad, until, useReceiver } from '../sync.ts';

const receiver = useReceiver();

/** A write into `space` as `account`, as setup. */
async function write(ctx: RunContext, account: Account, space: string, n: number | string) {
  setupOk(`createRecord as ${account.handle}`, await writes({ ctx, owner: account, space }).create(note(n)));
  return commitOf(account, space);
}

const UPDATE = 'com.atproto.space.notifySpaceUpdate';
const FORWARDED = 'com.atproto.space.notifyWrite';

/** A notification to the harness as a registered syncer, about a write to `repo` (both revisions). */
function writeNotice(ctx: RunContext, space: string, token: string | undefined, repo?: string) {
  return (e: Received) => {
    if (e.input.space !== space) return false;
    if (settled(ctx)) {
      const u = e.input.update as Record<string, unknown> | undefined;
      return e.method === UPDATE && e.input.token === token && String(u?.$type ?? '').endsWith('#repoWrite') && (!repo || u?.repo === repo);
    }
    // At 2026-10-29 the forwarded notifyWrite is the one addressed to the syncer.
    return e.method === FORWARDED && e.auth?.aud?.split('#')[0] === SYNCER_SERVICE.split('#')[0] && (!repo || e.input.repo === repo);
  };
}

/** The fields of a write notice that the rows compare, at either revision. */
const noticeFields = (ctx: RunContext, e: Received) => {
  const u = (settled(ctx) ? e.input.update : e.input) as Record<string, any>;
  return { repo: u.repo, repoRev: u.repoRev, spaceRev: u.spaceRev, prevSpaceRev: u.prevSpaceRev };
};

const listing = (ws: WriterSet) => JSON.stringify({ pages: ws.pages, writers: ws.writers }).slice(0, 1500);

/** The writer set, as a graded read: a refusal fails, 429/5xx pends, endless paging fails. */
function gradedWriters(ws: WriterSet, what: string): WriterSet {
  const method = 'the writer set listing';
  if (ws.error && transient(ws.error)) pending(`${method} answered ${short(ws.error)} for ${what}`);
  if (ws.error) fail(`${method} answered ${short(ws.error)} for ${what}`, { pages: JSON.stringify(ws.pages) });
  if (ws.runaway) fail(`paging the writer set for ${what} didn't end: ${ws.runaway}`, { listing: listing(ws) });
  return ws;
}

const present = (ws: WriterSet, did: string) => latestByRepo(ws.writers).get(did)?.present === true;

/** An entry matching a commit: present, with its repoRev and data. */
const matches = (w: Writer | undefined, c: { rev: string; data: string }) => !!w && w.present && w.repoRev === c.rev && unpad(w.data) === unpad(c.data);

assertion('writers.notify-write-sent', async (ctx) => {
  const rx = receiver();
  const authority = await foreignAuthority(ctx, rx);
  const { owner } = await ownerSpace(ctx);
  const space = authority.space(SPACE_TYPE);
  const from = rx.mark();
  const commit = await write(ctx, owner, space, 'sent');
  const method = settled(ctx) ? 'com.atproto.space.notifyRepoUpdate' : 'com.atproto.space.notifyWrite';
  const about = (e: Received) => e.method === method && e.input.space === space && e.input.repo === owner.did;
  const [e] = await received(rx, from, (x) => about(x) && x.input.repoRev === commit.rev, 1);
  const seen = rx.since(from, (x) => x.input.space === space);
  const evidence = {
    authority: authority.did,
    commit: JSON.stringify(commit),
    received: JSON.stringify(seen.map((x) => ({ method: x.method, input: x.input, auth: x.auth && { ok: x.auth.ok, reason: x.auth.reason, aud: x.auth.aud, iss: x.auth.iss } }))).slice(0, 2000),
  };
  if (!e) fail(seen.some(about) ? `${method} came, but none with repoRev ${commit.rev}` : `no ${method} for the write reached the authority's space host within 20 s`, evidence);
  const data = (e!.input.data as { $bytes?: string } | undefined)?.$bytes;
  if (unpad(data) !== unpad(commit.data)) fail(`${method} carried data ${data}, not the repo's commit data ${commit.data}`, evidence);
});

assertion('writers.notify-write-forwarded', async (ctx) => {
  const rx = receiver();
  const { owner } = await ownerSpace(ctx);
  const repo = await publicSpace(ctx, owner);
  const from = rx.mark();
  const { sync, token, answers } = await credentialed(repo, { receiver: rx, register: true });
  await write(ctx, owner, repo.space, 1);
  await write(ctx, owner, repo.space, 2);
  const got = await received(rx, from, writeNotice(ctx, repo.space, token, owner.did), 2);
  const fields = got.map((e) => noticeFields(ctx, e)).sort((a, b) => String(a.spaceRev).localeCompare(String(b.spaceRev)));
  const evidence = { ...answers, authorize_spaceRev: sync.spaceRev ?? null, notices: JSON.stringify(fields).slice(0, 1500) };
  if (got.length < 2) fail(`the registered syncer got ${got.length} of 2 write notifications within 20 s`, evidence);
  const missing = fields.filter((f) => typeof f.spaceRev !== 'string');
  if (missing.length) fail(`${missing.length} notification(s) carry no spaceRev`, evidence);
  const [a, b] = fields;
  if (b.prevSpaceRev !== a.spaceRev) fail(`the second notification's prevSpaceRev is ${b.prevSpaceRev}, not the first's spaceRev ${a.spaceRev}: a gap`, evidence);
  if (sync.spaceRev && a.prevSpaceRev !== sync.spaceRev) fail(`the first notification's prevSpaceRev is ${a.prevSpaceRev}, not the spaceRev ${sync.spaceRev} authorization answered: a gap`, evidence);
});

/** 2026-10-29: registerNotify answers an expiry, and unregisterNotify stops delivery. */
async function registerExpiryG1(ctx: RunContext, repo: Repo) {
  const rx = receiver();
  const { owner, space } = repo;
  const from = rx.mark();
  const { sync, registration, answers } = await credentialed(repo, { receiver: rx, register: true, gradeRegistration: true });
  const r = registration!;
  if (transient(r)) pending(`registerNotify answered ${short(r)}`);
  if (r.status !== 200) fail(`registerNotify answered ${short(r)}`, answers);
  const expiresAt = Date.parse(String(r.body?.expiresAt));
  if (!(expiresAt > Date.now())) fail(`registerNotify's expiresAt ${String(r.body?.expiresAt)} is not in the future`, answers);
  // Control: a registered syncer is notified, or unregistering can't be told from never being notified.
  await write(ctx, owner, space, 'registered');
  if (!(await received(rx, from, writeNotice(ctx, space, undefined), 1)).length)
    pending('no forwarded notifyWrite reached the registered syncer, so unregistering has nothing to stop (notify-write-forwarded grades delivery)');
  const u = await sync.unregister();
  if (transient(u)) pending(`unregisterNotify answered ${short(u)}`);
  if (u.status >= 300) fail(`unregisterNotify answered ${short(u)}`, answers);
  const after = rx.mark();
  await write(ctx, owner, space, 'unregistered');
  const late = await received(rx, after, writeNotice(ctx, space, undefined), 1, 10_000);
  if (late.length) fail('a notifyWrite reached the syncer after unregisterNotify', { ...answers, notice: JSON.stringify(late[0].input).slice(0, 500) });
}

/** 2026-11-12: confirmRegistration gates the registration, which lapses with its credential. */
async function registerExpiryG2(ctx: RunContext, repo: Repo) {
  const rx = receiver();
  const { owner, space } = repo;
  // Control: the space issues a credential at all, without registering.
  const { sync: sync0 } = await credentialed(repo);
  const from = rx.mark();
  const token = rx.issue(space);
  const r = await sync0.authorize({ notifyToken: token });
  if (transient(r)) pending(`authorizeSpaceSync with notify answered ${short(r)}`);
  if (r.status !== 200) fail(`authorizeSpaceSync with notify answered ${short(r)}, though it issues credentials without one`, { answer: short(r) });
  const confirms = rx.since(from, (e) => e.method === 'com.atproto.space.confirmRegistration' && e.input.token === token);
  const evidence = { authorize: short(r), confirms: JSON.stringify(confirms.map((e) => e.input)).slice(0, 600) };
  if (!confirms.length) fail('the space host registered the endpoint without calling confirmRegistration', evidence);
  const c = confirms[0];
  if (c.input.space !== space || typeof c.input.challenge !== 'string' || !c.input.challenge) fail('confirmRegistration did not carry the space and a challenge', evidence);
  // The registration is live: a write notifies.
  await write(ctx, owner, space, 'live');
  if (!(await received(rx, from, writeNotice(ctx, space, token), 1)).length) fail('the confirmed registration got no notifySpaceUpdate for a write', evidence);
  // Negative: an endpoint that echoes the wrong challenge must not be registered.
  const bad = rx.issue(space);
  rx.respond('com.atproto.space.confirmRegistration', (e) => (e.input.token === bad ? { status: 200, body: { challenge: `${String(e.input.challenge)}-not` } } : undefined));
  const refused = await sync0.authorize({ notifyToken: bad }).finally(() => rx.respond('com.atproto.space.confirmRegistration', undefined));
  if (transient(refused)) pending(`authorizeSpaceSync with an unconfirmed notify answered ${short(refused)}`);
  if (refused.status < 300) fail('authorizeSpaceSync registered an endpoint that echoed the wrong challenge', { ...evidence, refused: short(refused) });
  // Control after: the good registration still renews.
  const renew = await sync0.authorize({ notifyToken: token });
  if (renew.status !== 200) pending(`renewing the confirmed registration answered ${short(renew)}, so the refusal above can't be told from host state`);
  if (!slow()) pending(SLOW_PENDING);
  // Wait out the latest credential, then the next update must be the expiry notice and nothing more.
  const exp = Number(sync0.claims()?.exp) * 1000;
  const wait = exp - Date.now() + 15_000;
  if (!(wait > 0) || wait > 11 * 60_000) pending(`the credential's exp leaves ${Math.round(wait / 1000)} s to wait, outside the harness's 11-minute window`);
  await new Promise((res) => setTimeout(res, wait));
  const lapsed = rx.mark();
  await write(ctx, owner, space, 'lapsed-1');
  const forToken = (e: Received) => e.method === UPDATE && e.input.space === space && e.input.token === token;
  const first = await received(rx, lapsed, forToken, 1);
  const kind = (e: Received) => String((e.input.update as Record<string, unknown>)?.$type ?? '');
  const ev2 = { ...evidence, after_expiry: JSON.stringify(first.map((e) => e.input.update)).slice(0, 600) };
  if (!first.length) fail('after the credential expired, the next update brought the syncer no notice', ev2);
  if (!kind(first[0]).endsWith('#registrationExpired')) fail(`after the credential expired, the next update brought ${kind(first[0])}, not registrationExpired`, ev2);
  if (typeof (first[0].input.update as Record<string, unknown>).spaceRev !== 'string') fail('the registrationExpired notice has no spaceRev', ev2);
  const quiet = rx.mark();
  await write(ctx, owner, space, 'lapsed-2');
  const more = await received(rx, quiet, forToken, 1, 10_000);
  if (more.length) fail(`after the expiry notice the lapsed registration got ${kind(more[0])}`, ev2);
  // Reauthorizing with the same pair restores delivery.
  const again = await sync0.authorize({ notifyToken: token });
  if (again.status !== 200) pending(`reauthorizing answered ${short(again)}`);
  const back = rx.mark();
  await write(ctx, owner, space, 'renewed');
  if (!(await received(rx, back, writeNotice(ctx, space, token), 1)).length) fail('after reauthorizing, a write brought the syncer no notifySpaceUpdate', ev2);
}

assertion(
  'writers.register-expiry',
  async (ctx) => {
    const { owner } = await ownerSpace(ctx);
    const repo = await publicSpace(ctx, owner);
    return settled(ctx) ? registerExpiryG2(ctx, repo) : registerExpiryG1(ctx, repo);
  },
  { timeoutMs: slow() ? 14 * 60_000 : undefined },
);

/** Put `did` on the space's member list with write access (setup), in the run revision's method. */
async function addWriter(repo: Repo, did: string) {
  const { ctx, owner, space } = repo;
  const [nsid, body] = settled(ctx)
    ? ['com.atproto.memberspace.putMembers', { space, members: [{ did, read: true, write: true }] }]
    : ['com.atproto.memberspace.putMember', { space, did, read: true, write: true }];
  setupOk(nsid.split('.').pop()!, await owner.auth.request('POST', xrpcUrl(owner.repoHost, nsid), body));
}

/**
 * Owner and member both write into a publicWrite space: the writer set the
 * list rows read. A host that refuses a non-member's write even under
 * publicWrite gets the member put on the member list (`member_list` in the
 * evidence), unless `publicWriteOnly`, for the row that is about publicWrite.
 */
async function twoWriters(ctx: RunContext, o: { publicWriteOnly?: boolean } = {}) {
  const { owner } = await ownerSpace(ctx);
  const member = await memberAccount(ctx);
  const repo = await publicSpace(ctx, owner, { publicWrite: true });
  const oc = await write(ctx, owner, repo.space, 'owner');
  const { mc, memberList } = await memberWrite(repo, member, 'member', !o.publicWriteOnly);
  const { sync, answers } = await credentialed(repo);
  return { owner, member, repo, sync, oc, mc, answers: { ...answers, ...memberList } };
}

/** The member writes into a publicWrite space; on a refusal, and if allowed, after being put on the member list. */
async function memberWrite(repo: Repo, member: Account, n: string, allowList: boolean) {
  const { ctx, space } = repo;
  let memberList = {};
  const first = await writes({ ctx, owner: member, space }).create(note(n));
  if (first.status >= 400 && first.status < 500 && allowList) {
    await addWriter(repo, member.did);
    memberList = { member_list: 'the member was put on the member list: the host refused its write under publicWrite' };
    await write(ctx, member, space, `${n}-listed`);
  } else setupOk(`createRecord as ${member.handle}`, first);
  return { mc: await commitOf(member, space), memberList };
}

assertion('writers.list-repos', async (ctx) => {
  const { owner, member, sync, oc, mc, answers } = await twoWriters(ctx);
  // The space host learns of the member's write by notification, so allow it a moment.
  const ws = gradedWriters(
    await until(() => sync.writers({ limit: 1 }), (w) => !!w.error || !!w.runaway || (matches(latestByRepo(w.writers).get(owner.did), oc) && matches(latestByRepo(w.writers).get(member.did), mc))),
    'two writers',
  );
  const latest = latestByRepo(ws.writers);
  const evidence = { ...answers, owner: JSON.stringify(oc), member: JSON.stringify(mc), listing: listing(ws) };
  for (const [who, did, c] of [['owner', owner.did, oc], ['member', member.did, mc]] as const) {
    const w = latest.get(did);
    if (!w || !w.present) fail(`the writer set doesn't list the ${who}, who wrote`, evidence);
    if (w!.repoRev !== c.rev) fail(`the ${who}'s entry has repoRev ${w!.repoRev}, not its commit's ${c.rev}`, evidence);
    if (unpad(w!.data) !== unpad(c.data)) fail(`the ${who}'s entry has data ${w!.data}, not its commit's ${c.data}`, evidence);
  }
});

assertion('writers.list-repos-since-space-rev', async (ctx) => {
  const { owner } = await ownerSpace(ctx);
  const member = await memberAccount(ctx);
  const repo = await publicSpace(ctx, owner, { publicWrite: true });
  const oc = await write(ctx, owner, repo.space, 'before');
  const { sync, answers } = await credentialed(repo);
  const first = await until(() => sync.writers(), (w) => !!w.error || matches(latestByRepo(w.writers).get(owner.did), oc));
  const r1 = latestByRepo(first.writers).get(owner.did)?.spaceRev;
  if (!r1) pending(`the writer set gave the owner's write no spaceRev (${first.error ? short(first.error) : listing(first)}), so there's no earlier space revision to ask from`);
  const { mc, memberList } = await memberWrite(repo, member, 'after', true);
  // Control: the full listing has both, or "since" has nothing to leave out.
  const full = await until(() => sync.writers(), (w) => !!w.error || matches(latestByRepo(w.writers).get(member.did), mc));
  if (!matches(latestByRepo(full.writers).get(member.did), mc)) pending(`the full writer set doesn't show the member's write yet (${listing(full)}); list-repos grades that`);
  const since = gradedWriters(await sync.writers({ cursor: r1 }), `cursor ${r1}`);
  const evidence = { ...answers, ...memberList, r1: r1!, since: listing(since), full: listing(full) };
  if (since.writers.some((w) => w.repo === owner.did)) fail(`listing from spaceRev ${r1} returned the owner, whose last update was at ${r1} (exclusive)`, evidence);
  if (!matches(latestByRepo(since.writers).get(member.did), mc)) fail(`listing from spaceRev ${r1} doesn't return the member's later write`, evidence);
});

/** removeWriter for `did`, as the space's owner, in the run revision's shape. */
function removeWriter(repo: Repo, did: string) {
  const { ctx, owner, space } = repo;
  return owner.auth.request('POST', xrpcUrl(owner.repoHost, 'com.atproto.space.removeWriter'), settled(ctx) ? { space, repo: did } : { space, did });
}

/** A member that wrote and is listed, as setup; then removeWriter's answer and the listing after it. */
async function removal(ctx: RunContext, o: { publicWriteOnly?: boolean } = {}) {
  const { owner, member, repo, sync, mc, answers } = await twoWriters(ctx, o);
  const before = await until(() => sync.writers(), (w) => !!w.error || present(w, member.did));
  if (!present(before, member.did)) pending(`the member never appeared in the writer set (${before.error ? short(before.error) : listing(before)}), so there's nothing to remove; list-repos grades that`);
  const r = await removeWriter(repo, member.did);
  const after = r.status < 300 ? await until(() => sync.writers(), (w) => !!w.error || !present(w, member.did), 10_000) : undefined;
  return { owner, member, repo, sync, mc, r, before, after, answers };
}

assertion('writers.remove-writer', async (ctx) => {
  const { owner, member, r, before, after, answers } = await removal(ctx);
  if (transient(r)) pending(`removeWriter answered ${short(r)}`);
  const evidence = { ...answers, removeWriter: short(r), before: listing(before), ...(after ? { after: listing(after) } : {}) };
  if (r.status >= 300) fail(`removeWriter answered ${short(r)}`, evidence);
  const ws = gradedWriters(after!, 'after removeWriter');
  if (present(ws, member.did)) fail('after removeWriter the member is still in the writer set', evidence);
  if (!present(ws, owner.did)) fail('after removeWriter for the member, the owner is gone from the writer set too', evidence);
});

assertion('writers.removed-writer-retracked', async (ctx) => {
  // The row is about writers tracked under publicWrite, so the member is never put on the list here.
  const { member, repo, sync, r, after, answers } = await removal(ctx, { publicWriteOnly: true });
  setupOk('removeWriter', r);
  if (!after || after.error || present(after, member.did)) pending('the removal did not show in the writer set; remove-writer grades that');
  const again = await write(ctx, member, repo.space, 'again');
  const ws = gradedWriters(await until(() => sync.writers(), (w) => !!w.error || matches(latestByRepo(w.writers).get(member.did), again)), 'after the removed writer wrote again');
  if (!matches(latestByRepo(ws.writers).get(member.did), again))
    fail('after writing again under publicWrite, the removed member is not back in the writer set with its new repoRev', { ...answers, commit: JSON.stringify(again), listing: listing(ws) });
});

