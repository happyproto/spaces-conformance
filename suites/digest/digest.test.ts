import { assertion, fail } from '../../harness/assert.ts';
import { hex } from '../../harness/crypto/bytes.ts';
import { recordCid } from '../../harness/crypto/drisl.ts';
import { LtHash } from '../../harness/crypto/lthash.ts';
import { COLLECTION, xrpcUrl } from '../fixtures.ts';
import { commitOrFail, createOp, expectedDigest, freshRepo, listAll, note, type Repo, setupWrites } from '../repo.ts';

const OTHER = 'com.example.conformance.reaction';

async function latestCommit(repo: Repo) {
  const { owner, space } = repo;
  const r = await owner.auth.request('GET', xrpcUrl(owner.repoHost, 'com.atproto.space.getLatestCommit', { space, repo: owner.did }));
  if (r.status !== 200) fail(`getLatestCommit answered ${r.status}`, { body: JSON.stringify(r.body).slice(0, 1000) });
  return r.body.commit;
}

function compare(data: Uint8Array, expected: Uint8Array, what: string, extra: Record<string, unknown> = {}) {
  if (hex(data) !== hex(expected)) fail(`commit data ${hex(data).slice(0, 16)}… is not the digest of ${what}`, { data: hex(data), expected: hex(expected), ...extra });
}

assertion('digest.matches-record-set', async (ctx) => {
  const repo = await freshRepo(ctx);
  const w = setupWrites(repo);
  await w.put('a', note(1));
  await w.put('b', note(2, { tags: ['x', 'y'] }));
  await w.put('c', { $type: OTHER, n: 3 }, OTHER);
  const listed = await listAll(repo, [COLLECTION, OTHER]);
  const expected = LtHash.ofRecords(listed).digest();
  const commit = commitOrFail(await latestCommit(repo), expected);
  compare(commit.data, expected, 'the records the host lists', { listed: JSON.stringify(listed) });
});

assertion('digest.covers-overwrite-and-delete', async (ctx) => {
  const repo = await freshRepo(ctx);
  const w = setupWrites(repo);
  await w.put('a', note('a1'));
  await w.put('b', note('b1'));
  await w.put('b', note('b2'));
  await w.del('a');
  const expected = expectedDigest([{ collection: COLLECTION, rkey: 'b', value: note('b2') }]);
  const commit = commitOrFail(await latestCommit(repo), expected);
  compare(commit.data, expected, 'the one surviving record, b at its second value');
});

/** 57 plain-JSON records in two collections: more than one 50-record batch, as a migration replay writes them. */
export function multiBatchRecords() {
  const out: { collection: string; rkey: string; value: Record<string, unknown> }[] = [];
  for (let i = 0; i < 57; i++) {
    const collection = i % 3 === 0 ? OTHER : COLLECTION;
    const rkey = `r${String(i).padStart(3, '0')}`;
    const value: Record<string, unknown> = { $type: collection, z: i, a: -i, text: `record ${i} ✓ é 日本`, nested: { deep: { list: [i, null, true, 'x'] } }, none: null };
    out.push({ collection, rkey, value });
  }
  return out;
}

assertion('digest.multi-batch', async (ctx) => {
  const repo = await freshRepo(ctx);
  const recs = multiBatchRecords();
  const w = setupWrites(repo);
  for (const batch of [recs.slice(0, 20), recs.slice(20, 40), recs.slice(40)]) await w.apply(batch.map((r) => createOp(r.rkey, r.value, r.collection)));
  const expected = expectedDigest(recs);
  const commit = commitOrFail(await latestCommit(repo), expected);
  const listed = await listAll(repo, [COLLECTION, OTHER]);
  const wrong = recs.filter((r) => listed.find((l) => l.collection === r.collection && l.rkey === r.rkey)?.cid !== recordCid(r.value).toString());
  compare(commit.data, expected, 'the 57 records written', { listed: listed.length, cid_mismatches: wrong.map((r) => r.rkey).join(',') });
});
