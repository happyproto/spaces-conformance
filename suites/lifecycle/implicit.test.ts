import { assertion, fail } from '../../harness/assert.ts';
import { recordCid } from '../../harness/crypto/drisl.ts';
import { COLLECTION, memberAccount, ownerSpace, xrpcUrl } from '../fixtures.ts';
import { note } from '../repo.ts';

// The fixture owner's space is another authority's space for the member, so
// the member's first write there must create their repo, with no prior call.
assertion('lifecycle.implicit-create', async (ctx) => {
  const { space } = await ownerSpace(ctx);
  const member = await memberAccount(ctx);
  const value = note('first write');
  const r = await member.auth.request('POST', xrpcUrl(member.repoHost, 'com.atproto.space.createRecord'), {
    space,
    repo: member.did,
    collection: COLLECTION,
    rkey: 'first',
    record: value,
  });
  if (r.status >= 300) fail(`the first write into another authority's space answered ${r.status}`, { body: JSON.stringify(r.body).slice(0, 1000) });
  const g = await member.auth.request('GET', xrpcUrl(member.repoHost, 'com.atproto.space.getRecord', { space, repo: member.did, collection: COLLECTION, rkey: 'first' }));
  if (g.status !== 200 || g.body?.cid !== recordCid(value).toString()) fail(`getRecord on the new repo answered ${g.status}`, { body: JSON.stringify(g.body).slice(0, 1000) });
});
