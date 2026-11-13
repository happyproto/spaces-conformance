import { assertion, fail } from '../../harness/assert.ts';
import { Syncer } from '../../harness/actors/syncer.ts';
import { hex } from '../../harness/crypto/bytes.ts';
import { recordCid } from '../../harness/crypto/drisl.ts';
import { COLLECTION, xrpcUrl } from '../fixtures.ts';
import { commitOrFail, createOp, expectedDigest, freshRepo, gradedApply, note, type Repo, setupWrites, syncerFor } from '../repo.ts';

const cid = (v: unknown) => recordCid(v).toString();
type Op = { rev: string; collection: string; rkey: string; cid: string | null; prev: string | null; value?: unknown };
const brief = (ops: Op[]) => JSON.stringify(ops.map(({ rev, rkey, cid, prev, value }) => ({ rev, rkey, cid, prev, ...(value !== undefined ? { value: true } : {}) }))).slice(0, 3000);

async function readLog(repo: Repo, opts: { since?: string; limit?: number } = {}) {
  const { syncer, target } = await syncerFor(repo);
  const log = await syncer.oplog(target, opts);
  if (log.error) fail(`listRepoOps answered ${log.error.status}`, { body: JSON.stringify(log.error.body).slice(0, 1000) });
  return log;
}

/** create a, create b, update b, delete a, create c: the [C, C, U, D, C] sequence HappyView's tests use. */
async function fiveWrites(repo: Repo) {
  const w = setupWrites(repo);
  await w.put('a', note('a1'));
  await w.put('b', note('b1'));
  await w.put('b', note('b2'));
  await w.del('a');
  await w.put('c', note('c1'));
}

const KEYS = ['cid', 'collection', 'prev', 'rev', 'rkey'];

assertion('oplog.entry-shape', async (ctx) => {
  const repo = await freshRepo(ctx);
  await fiveWrites(repo);
  const { ops } = await readLog(repo);
  const evidence = { ops: brief(ops) };
  if (ops.length !== 5) fail(`listRepoOps returned ${ops.length} ops for 5 writes`, evidence);
  for (const op of ops) {
    const keys = Object.keys(op).filter((k) => k !== 'value').sort();
    if (keys.join() !== KEYS.join()) fail(`an entry has fields [${keys.join(', ')}], not [${KEYS.join(', ')}] (plus an optional value)`, evidence);
    if (!/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(op.rev)) fail(`rev ${op.rev} is not a TID`, evidence);
  }
  const want = [
    { rkey: 'a', cid: cid(note('a1')), prev: null },
    { rkey: 'b', cid: cid(note('b1')), prev: null },
    { rkey: 'b', cid: cid(note('b2')), prev: cid(note('b1')) },
    { rkey: 'a', cid: null, prev: cid(note('a1')) },
    { rkey: 'c', cid: cid(note('c1')), prev: null },
  ];
  want.forEach((w, i) => {
    const o = ops[i];
    if (o.rkey !== w.rkey || o.cid !== w.cid || o.prev !== w.prev) fail(`op ${i + 1} is ${JSON.stringify({ rkey: o.rkey, cid: o.cid, prev: o.prev })}, expected ${JSON.stringify(w)}`, evidence);
  });
});

assertion('oplog.since-exclusive', async (ctx) => {
  const repo = await freshRepo(ctx);
  const w = setupWrites(repo);
  await w.put('x', note('x'));
  const first = await readLog(repo);
  const since = first.ops.at(-1)?.rev;
  if (!since) fail('listRepoOps returned no ops after a write', { ops: brief(first.ops) });
  await w.put('y', note('y'));
  const later = await readLog(repo, { since });
  const evidence = { since, ops: brief(later.ops) };
  if (later.ops.some((o) => o.rev <= since!)) fail(`listRepoOps since=${since} returned ops at or before it`, evidence);
  if (!later.ops.some((o) => o.rkey === 'y')) fail(`listRepoOps since=${since} is missing the later write`, evidence);
});

assertion('oplog.pagination-complete', async (ctx) => {
  const repo = await freshRepo(ctx);
  const w = setupWrites(repo);
  for (let i = 0; i < 7; i++) await w.put(`p${i}`, note(i));
  const log = await readLog(repo, { limit: 2 });
  const evidence = { pages: JSON.stringify(log.pages.map((p) => p.ops)), ops: brief(log.ops) };
  const seen = log.ops.map((o) => o.rkey);
  for (let i = 0; i < 7; i++) {
    const n = seen.filter((k) => k === `p${i}`).length;
    if (n !== 1) fail(`following cursor with limit=2 returned p${i} ${n} times, not once`, evidence);
  }
  if (log.ops.length !== 7) fail(`following cursor returned ${log.ops.length} ops, not 7`, evidence);
});

assertion('oplog.pagination-batch-boundary', async (ctx) => {
  const repo = await freshRepo(ctx);
  // The batch is what this row checks, so a refused applyWrites is a fail.
  await gradedApply(repo, [createOp('m1', note(1)), createOp('m2', note(2)), createOp('m3', note(3))]);
  const log = await readLog(repo, { limit: 2 });
  const got = log.ops.map((o) => o.rkey).sort();
  if (got.join() !== 'm1,m2,m3') fail(`a page boundary inside one applyWrites batch lost ops: got [${got.join(', ')}]`, { pages: JSON.stringify(log.pages.map((p) => p.ops)), ops: brief(log.ops) });
});

assertion('oplog.stale-values-omitted', async (ctx) => {
  const repo = await freshRepo(ctx);
  await fiveWrites(repo);
  const { ops } = await readLog(repo);
  const evidence = { ops: brief(ops) };
  const lastFor = new Map<string, number>();
  ops.forEach((o, i) => lastFor.set(`${o.collection}/${o.rkey}`, i));
  ops.forEach((o, i) => {
    const latest = lastFor.get(`${o.collection}/${o.rkey}`) === i;
    if (!latest && o.value !== undefined) fail(`op ${i + 1} (${o.rkey}) is superseded but still carries a value`, evidence);
    if (latest && o.cid !== null && o.value === undefined) fail(`op ${i + 1} (${o.rkey}) is the current value but carries none`, evidence);
  });
});

assertion('oplog.fold-matches-commit', async (ctx) => {
  const repo = await freshRepo(ctx);
  await fiveWrites(repo);
  const log = await readLog(repo, { limit: 2 });
  const folded = Syncer.fold(log.ops).digest;
  const expected = expectedDigest([
    { collection: COLLECTION, rkey: 'b', value: note('b2') },
    { collection: COLLECTION, rkey: 'c', value: note('c1') },
  ]);
  let commit = log.final?.commit ?? null;
  if (!commit) {
    // No page carried a 0016 commit: read it the way a syncer would next.
    const { owner, space } = repo;
    const r = await owner.auth.request('GET', xrpcUrl(owner.repoHost, 'com.atproto.space.getLatestCommit', { space, repo: owner.did }));
    if (r.status !== 200) fail(`getLatestCommit answered ${r.status}`, { body: JSON.stringify(r.body).slice(0, 1000) });
    commit = commitOrFail(r.body.commit, folded);
  }
  const evidence = { folded: hex(folded), expected: hex(expected), data: hex(commit.data), ops: brief(log.ops) };
  if (hex(folded) !== hex(commit.data)) fail('folding every op does not give the commit data', evidence);
});

// 2026-11-12 on: a commit on every page, not only the last (the Oct 29 text
// put it on the final page; mac.list-repo-ops-final-page grades that).
assertion('oplog.commit-every-page', async (ctx) => {
  const repo = await freshRepo(ctx);
  await fiveWrites(repo);
  const log = await readLog(repo, { limit: 2 });
  const { owner, space } = repo;
  const r = await owner.auth.request('GET', xrpcUrl(owner.repoHost, 'com.atproto.space.getLatestCommit', { space, repo: owner.did }));
  if (r.status !== 200) fail(`getLatestCommit answered ${r.status}`, { body: JSON.stringify(r.body).slice(0, 1000) });
  const current = commitOrFail(r.body.commit);
  const evidence = { pages: JSON.stringify(log.pages.map(({ ops, commit, commitRev }) => ({ ops, commit, commitRev }))), current: current.rev };
  if (log.pages.length < 2) fail(`limit=2 over five writes gave ${log.pages.length} page(s), so there is no earlier page to check`, evidence);
  log.pages.forEach((p, i) => {
    if (!p.commit) fail(`page ${i + 1} of ${log.pages.length} carries no commit`, evidence);
    if (!p.commitRev) fail(`page ${i + 1} of ${log.pages.length} carries a commit that isn't a 0016 commit`, evidence);
    if (p.commitRev !== current.rev) fail(`page ${i + 1} of ${log.pages.length} carries commit rev ${p.commitRev}, not the current ${current.rev}`, evidence);
  });
});
