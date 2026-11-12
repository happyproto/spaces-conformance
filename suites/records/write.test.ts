import { assertion, fail } from '../../harness/assert.ts';
import { recordCid } from '../../harness/crypto/drisl.ts';
import { COLLECTION, xrpcUrl } from '../fixtures.ts';
import { createOp, freshRepo, note, setupWrites, syncerFor, writes } from '../repo.ts';

const sameValue = (got: unknown, want: unknown) => {
  try {
    return recordCid(got).toString() === recordCid(want).toString();
  } catch {
    return false;
  }
};

assertion('records.crud-roundtrip', async (ctx) => {
  const repo = await freshRepo(ctx);
  const { owner, space } = repo;
  const w = writes(repo);
  const get = (rkey: string) =>
    owner.auth.request('GET', xrpcUrl(owner.repoHost, 'com.atproto.space.getRecord', { space, repo: owner.did, collection: COLLECTION, rkey }));
  const ev = (step: string, r: { status: number; body: unknown }) => ({ step, status: r.status, body: JSON.stringify(r.body).slice(0, 1000) });

  // createRecord with a client-chosen rkey keeps it.
  const v1 = note('created');
  const c = await w.create(v1, 'chosen');
  if (c.status >= 300) fail(`createRecord answered ${c.status}`, ev('createRecord', c));
  if (!String(c.body?.uri).endsWith(`/${COLLECTION}/chosen`)) fail(`createRecord's uri ${c.body?.uri} doesn't end in the chosen rkey`, ev('createRecord', c));
  const g1 = await get('chosen');
  if (g1.status !== 200) fail(`getRecord after createRecord answered ${g1.status}`, ev('getRecord', g1));
  if (g1.body.cid !== c.body.cid || g1.body.cid !== recordCid(v1).toString()) fail('getRecord and createRecord disagree on the CID', { create: c.body.cid, get: g1.body.cid, expected: recordCid(v1).toString() });
  // Compared as DRISL (its CID), so key order doesn't matter.
  if (sameValue(g1.body.value, v1) === false) fail('getRecord returns a different value', ev('getRecord', g1));

  // putRecord overwrites it.
  const v2 = note('updated');
  const p = await w.put('chosen', v2);
  if (p.status >= 300) fail(`putRecord answered ${p.status}`, ev('putRecord', p));
  const g2 = await get('chosen');
  if (g2.status !== 200 || g2.body.cid !== recordCid(v2).toString() || !sameValue(g2.body.value, v2))
    fail('getRecord after putRecord does not return the new value', ev('getRecord', g2));

  // deleteRecord removes it.
  const d = await w.del('chosen');
  if (d.status >= 300) fail(`deleteRecord answered ${d.status}`, ev('deleteRecord', d));
  const g3 = await get('chosen');
  if (g3.status < 400 || g3.status >= 500) fail(`getRecord after deleteRecord answered ${g3.status}, not a not-found refusal`, ev('getRecord', g3));
});

assertion('records.apply-writes-atomic', async (ctx) => {
  const repo = await freshRepo(ctx);
  await setupWrites(repo).put('before', note(0));
  const w = writes(repo);
  const r = await w.apply([createOp('x1', note(1)), createOp('x2', note(2)), createOp('x3', note(3))]);
  if (r.status >= 300) fail(`applyWrites answered ${r.status}`, { body: JSON.stringify(r.body).slice(0, 1000) });
  const { syncer, target } = await syncerFor(repo);
  const log = await syncer.oplog(target);
  if (log.error) fail(`listRepoOps answered ${log.error.status}`, { body: JSON.stringify(log.error.body).slice(0, 1000) });
  const batch = log.ops.filter((o) => ['x1', 'x2', 'x3'].includes(o.rkey));
  const evidence = { ops: JSON.stringify(log.ops.map(({ rev, rkey, cid }) => ({ rev, rkey, cid }))).slice(0, 2000) };
  if (batch.length !== 3) fail(`listRepoOps shows ${batch.length} of the batch's 3 ops`, evidence);
  const revs = new Set(batch.map((o) => o.rev));
  if (revs.size !== 1) fail(`the batch's ops carry ${revs.size} different revs, not one`, evidence);
  const before = log.ops.find((o) => o.rkey === 'before');
  if (before && before.rev === batch[0].rev) fail('the batch shares its rev with an earlier write', evidence);
});
