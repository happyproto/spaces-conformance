// Policy methods are graded as 0016 writes them (Oct 29): space.getSpace
// returns the policy object, and memberspace.* manages the member list.
// The space itself comes from the adapter (setup), in whatever mode the run
// uses; a simplespace-created space still has to read back as the policy.

import { assertion, fail } from '../../harness/assert.ts';
import type { RunContext } from '../../harness/context.ts';
import { memberAccount, ownerSpace, SPACE_TYPE, xrpcUrl } from '../fixtures.ts';

const POLICY = { $type: 'com.atproto.memberspace.policy', publicRead: true, allowedApps: ['https://app.example/oauth-client-metadata.json'] };

/** Fields a host may add when it echoes a policy: the memberspace lexicon's defaults. */
const DEFAULTS: Record<string, unknown> = { publicRead: false, publicWrite: false, publishPolicy: false, publishMembers: false };

assertion('policy.create-get-roundtrip', async (ctx) => {
  const { owner } = await ownerSpace(ctx);
  const space = await ctx.adapter.createSpace(ctx, owner, SPACE_TYPE, POLICY);
  const r = await owner.auth.request('GET', xrpcUrl(owner.repoHost, 'com.atproto.space.getSpace', { space }));
  const evidence = { status: r.status, body: JSON.stringify(r.body).slice(0, 1500) };
  if (r.status !== 200) fail(`space.getSpace answered ${r.status}`, evidence);
  if (r.body.uri !== space) fail(`getSpace's uri is ${r.body.uri}, not the created space`, evidence);
  const got = r.body.policy;
  if (!got || typeof got !== 'object') fail('getSpace returned no policy object', evidence);
  for (const [k, v] of Object.entries(POLICY)) if (JSON.stringify(got[k]) !== JSON.stringify(v)) fail(`policy.${k} is ${JSON.stringify(got[k])}, not ${JSON.stringify(v)}`, evidence);
  for (const [k, v] of Object.entries(got)) if (!(k in POLICY) && (!(k in DEFAULTS) || DEFAULTS[k] !== v)) fail(`policy has ${k}: ${JSON.stringify(v)}, which wasn't supplied`, evidence);
});

async function members(ctx: RunContext) {
  const { owner, space } = await ownerSpace(ctx);
  const member = await memberAccount(ctx);
  const post = (nsid: string, body: Record<string, unknown>) => owner.auth.request('POST', xrpcUrl(owner.repoHost, nsid), { space, ...body });
  const list = async () => {
    const r = await owner.auth.request('GET', xrpcUrl(owner.repoHost, 'com.atproto.memberspace.listMembers', { space }));
    if (r.status !== 200) fail(`memberspace.listMembers answered ${r.status}`, { body: JSON.stringify(r.body).slice(0, 1000) });
    return (r.body.members ?? []) as { did: string; read: boolean; write: boolean }[];
  };
  return { member, post, list };
}

assertion('policy.member-methods', async (ctx) => {
  const { member, post, list } = await members(ctx);
  const put = await post('com.atproto.memberspace.putMember', { did: member.did, read: true, write: false });
  if (put.status >= 300) fail(`memberspace.putMember answered ${put.status}`, { body: JSON.stringify(put.body).slice(0, 1000) });
  const listed = await list();
  if (!listed.some((m) => m.did === member.did && m.read === true && m.write === false)) fail('listMembers does not show the member putMember added', { members: JSON.stringify(listed) });
  const rm = await post('com.atproto.memberspace.removeMember', { did: member.did });
  if (rm.status >= 300) fail(`memberspace.removeMember answered ${rm.status}`, { body: JSON.stringify(rm.body).slice(0, 1000) });
  const after = await list();
  if (after.some((m) => m.did === member.did)) fail('listMembers still shows the member after removeMember', { members: JSON.stringify(after) });
});

assertion('policy.put-member-upsert', async (ctx) => {
  const { member, post, list } = await members(ctx);
  for (const write of [false, true]) {
    const r = await post('com.atproto.memberspace.putMember', { did: member.did, read: true, write });
    if (r.status >= 300) fail(`memberspace.putMember (write: ${write}) answered ${r.status}`, { body: JSON.stringify(r.body).slice(0, 1000) });
  }
  const entries = (await list()).filter((m) => m.did === member.did);
  if (entries.length !== 1) fail(`listMembers has ${entries.length} entries for the member after two putMember calls, not 1`, { members: JSON.stringify(entries) });
  if (entries[0].read !== true || entries[0].write !== true) fail(`the entry is read ${entries[0].read}, write ${entries[0].write}, not the second putMember's true, true`, { members: JSON.stringify(entries) });
});
