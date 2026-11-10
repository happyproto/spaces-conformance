import { assertion, fail, setup } from '../../harness/assert.ts';
import { fromB64 } from '../../harness/crypto/bytes.ts';
import { COLLECTION, ownerSpace, xrpcUrl } from '../fixtures.ts';
import type { RunContext } from '../../harness/context.ts';

const COMMIT_KEYS = ['data', 'repo', 'rev', 'space', 'ver'];

/** A repo with one record, and its latest commit as the owner reads it. */
async function latestCommit(ctx: RunContext) {
  const { owner, space } = await ownerSpace(ctx);
  await setup('createRecord', async () => {
    const r = await owner.auth.request('POST', xrpcUrl(owner.repoHost, 'com.atproto.space.createRecord'), {
      space,
      repo: owner.did,
      collection: COLLECTION,
      record: { $type: COLLECTION, text: 'commit fixture' },
    });
    if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  });
  const r = await owner.auth.request('GET', xrpcUrl(owner.repoHost, 'com.atproto.space.getLatestCommit', { space, repo: owner.did }));
  if (r.status !== 200) fail(`getLatestCommit answered ${r.status}`, { status: r.status, body: JSON.stringify(r.body).slice(0, 1000) });
  return { owner, space, commit: r.body.commit as Record<string, any>, body: r.body };
}

assertion('records.commit-fields', async (ctx) => {
  const { owner, space, commit, body } = await latestCommit(ctx);
  const evidence = { body: JSON.stringify(body).slice(0, 1500) };
  if (!commit || typeof commit !== 'object') fail('the response has no commit object', evidence);
  const keys = Object.keys(commit).sort();
  if (keys.join() !== COMMIT_KEYS.join()) fail(`commit fields are [${keys.join(', ')}], not exactly [${COMMIT_KEYS.join(', ')}]`, evidence);
  if (commit.ver !== 1) fail(`ver is ${commit.ver}, not 1`, evidence);
  if (commit.repo !== owner.did || commit.space !== space) fail('repo or space does not match the request', evidence);
  if (!/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(commit.rev)) fail(`rev ${commit.rev} is not a TID`, evidence);
});

assertion('records.commit-bytes-encoding', async (ctx) => {
  const { body } = await latestCommit(ctx);
  const data = body?.commit?.data;
  const evidence = { commit: JSON.stringify(body?.commit).slice(0, 1500) };
  if (!data || typeof data !== 'object' || typeof data.$bytes !== 'string') fail('commit.data is not {"$bytes": ...}', evidence);
  let bytes: Uint8Array;
  try {
    bytes = fromB64(data.$bytes);
  } catch {
    return fail('commit.data.$bytes is not standard base64', evidence);
  }
  if (bytes.length !== 32) fail(`commit.data decodes to ${bytes.length} bytes, not 32`, evidence);
});
