import { assertion, fail } from '../../harness/assert.ts';
import type { RunContext } from '../../harness/context.ts';
import { recordCid } from '../../harness/crypto/drisl.ts';
import { COLLECTION, ownerSpace, records, xrpcUrl } from '../fixtures.ts';

/** Write each record and compare the host's CID, from createRecord and getRecord, with the harness's DRISL CID. */
async function checkCids(ctx: RunContext, set: 'plain' | 'typed') {
  const { owner, space } = await ownerSpace(ctx);
  const mismatches: Record<string, unknown>[] = [];
  for (const { name, record } of records(set)) {
    const expected = recordCid(record).toString();
    const created = await owner.auth.request('POST', xrpcUrl(owner.repoHost, 'com.atproto.space.createRecord'), {
      space,
      repo: owner.did,
      collection: COLLECTION,
      record,
    });
    // Accepting these records is part of the behaviour under test, so a refusal is a fail, not setup.
    if (created.status >= 300) fail(`createRecord refused the ${set} record ${name} (${created.status})`, { record: name, status: created.status, body: JSON.stringify(created.body).slice(0, 1000) });
    const rkey = String(created.body.uri).split('/').pop()!;
    const got = await owner.auth.request('GET', xrpcUrl(owner.repoHost, 'com.atproto.space.getRecord', { space, repo: owner.did, collection: COLLECTION, rkey }));
    if (created.body.cid !== expected || got.body?.cid !== expected)
      mismatches.push({ record: name, expected, createRecord: created.body.cid, getRecord: got.body?.cid ?? got.status });
  }
  if (mismatches.length) fail(`${mismatches.length} record CID(s) differ from DRISL`, { mismatches: JSON.stringify(mismatches) });
}

assertion('digest.cid-drisl-plain', (ctx) => checkCids(ctx, 'plain'));
assertion('digest.cid-drisl-typed', (ctx) => checkCids(ctx, 'typed'));
