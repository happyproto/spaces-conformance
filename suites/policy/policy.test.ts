// Policy methods are graded as 0016 writes them at the run's revision:
// space.getSpace returns the policy object (with the space as `uri` on Oct 29,
// as `space` from Nov 12), and memberspace.* manages the member list
// (putMember and removeMember on Oct 29; putMembers and removeMembers, which
// take lists, from Nov 12). The space itself comes from the adapter (setup),
// in whatever mode the run uses; a simplespace-created space still has to
// read back as the policy.

import { assertion, fail } from '../../harness/assert.ts';
import type { RunContext } from '../../harness/context.ts';
import { memberAccount, ownerSpace, SPACE_TYPE, settled, xrpcUrl } from '../fixtures.ts';

const POLICY = { $type: 'com.atproto.memberspace.policy', publicRead: true, allowedApps: ['https://app.example/oauth-client-metadata.json'] };

/** Fields a host may add when it echoes a policy: the memberspace lexicon's defaults. */
const DEFAULTS: Record<string, unknown> = { publicRead: false, publicWrite: false, publishPolicy: false, publishMembers: false };

assertion('policy.create-get-roundtrip', async (ctx) => {
  const { owner } = await ownerSpace(ctx);
  const space = await ctx.adapter.createSpace(ctx, owner, SPACE_TYPE, POLICY);
  const r = await owner.auth.request('GET', xrpcUrl(owner.repoHost, 'com.atproto.space.getSpace', { space }));
  const evidence = { status: r.status, body: JSON.stringify(r.body).slice(0, 1500) };
  if (r.status !== 200) fail(`space.getSpace answered ${r.status}`, evidence);
  const field = settled(ctx) ? 'space' : 'uri';
  if (r.body[field] !== space) fail(`getSpace's ${field} is ${r.body[field]}, not the created space`, evidence);
  const got = r.body.policy;
  if (!got || typeof got !== 'object') fail('getSpace returned no policy object', evidence);
  for (const [k, v] of Object.entries(POLICY)) if (JSON.stringify(got[k]) !== JSON.stringify(v)) fail(`policy.${k} is ${JSON.stringify(got[k])}, not ${JSON.stringify(v)}`, evidence);
  for (const [k, v] of Object.entries(got)) if (!(k in POLICY) && (!(k in DEFAULTS) || DEFAULTS[k] !== v)) fail(`policy has ${k}: ${JSON.stringify(v)}, which wasn't supplied`, evidence);
});

async function members(ctx: RunContext) {
  const { owner, space } = await ownerSpace(ctx);
  const member = await memberAccount(ctx);
  const post = (nsid: string, body: Record<string, unknown>) => owner.auth.request('POST', xrpcUrl(owner.repoHost, nsid), { space, ...body });
  // One member, in the run's revision's methods.
  const put = (read: boolean, write: boolean) =>
    settled(ctx)
      ? post('com.atproto.memberspace.putMembers', { members: [{ did: member.did, read, write }] })
      : post('com.atproto.memberspace.putMember', { did: member.did, read, write });
  const remove = () =>
    settled(ctx) ? post('com.atproto.memberspace.removeMembers', { dids: [member.did] }) : post('com.atproto.memberspace.removeMember', { did: member.did });
  const [putName, removeName] = settled(ctx) ? ['putMembers', 'removeMembers'] : ['putMember', 'removeMember'];
  const list = async () => {
    const r = await owner.auth.request('GET', xrpcUrl(owner.repoHost, 'com.atproto.memberspace.listMembers', { space }));
    if (r.status !== 200) fail(`memberspace.listMembers answered ${r.status}`, { body: JSON.stringify(r.body).slice(0, 1000) });
    return (r.body.members ?? []) as { did: string; read: boolean; write: boolean }[];
  };
  return { member, put, remove, putName, removeName, list };
}

assertion('policy.member-methods', async (ctx) => {
  const { member, put, remove, putName, removeName, list } = await members(ctx);
  const added = await put(true, false);
  if (added.status >= 300) fail(`memberspace.${putName} answered ${added.status}`, { body: JSON.stringify(added.body).slice(0, 1000) });
  const listed = await list();
  if (!listed.some((m) => m.did === member.did && m.read === true && m.write === false)) fail(`listMembers does not show the member ${putName} added`, { members: JSON.stringify(listed) });
  const rm = await remove();
  if (rm.status >= 300) fail(`memberspace.${removeName} answered ${rm.status}`, { body: JSON.stringify(rm.body).slice(0, 1000) });
  const after = await list();
  if (after.some((m) => m.did === member.did)) fail(`listMembers still shows the member after ${removeName}`, { members: JSON.stringify(after) });
});

assertion('policy.put-member-upsert', async (ctx) => {
  const { member, put, putName, list } = await members(ctx);
  for (const write of [false, true]) {
    const r = await put(true, write);
    if (r.status >= 300) fail(`memberspace.${putName} (write: ${write}) answered ${r.status}`, { body: JSON.stringify(r.body).slice(0, 1000) });
  }
  const entries = (await list()).filter((m) => m.did === member.did);
  if (entries.length !== 1) fail(`listMembers has ${entries.length} entries for the member after two ${putName} calls, not 1`, { members: JSON.stringify(entries) });
  if (entries[0].read !== true || entries[0].write !== true) fail(`the entry is read ${entries[0].read}, write ${entries[0].write}, not the second ${putName}'s true, true`, { members: JSON.stringify(entries) });
});
