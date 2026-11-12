// MAC reads use the owner's own session with Atproto-Space-Want-Mac, as
// HappyView's interop tests do. 0016 requires the MAC with a space
// credential; the read auth is setup here, and the credential path comes in
// phase 7. Evidence names the read auth used.

import { assertion, fail } from '../../harness/assert.ts';
import { parseMultikey } from '../../harness/crypto/keys.ts';
import { setup } from '../../harness/assert.ts';
import { generate } from '../../harness/crypto/keys.ts';
import { REPO_TYPE, parseMacHeader } from '../../harness/crypto/mac.ts';
import { ownerSpace } from '../fixtures.ts';
import { commitOrFail, freshRepo, note, type Repo, setupWrites, syncerFor } from '../repo.ts';

async function repoWithRecord(ctx: Parameters<typeof freshRepo>[0]): Promise<Repo> {
  const repo = await freshRepo(ctx);
  await setupWrites(repo).put('m', note('mac'));
  return repo;
}

const readAuth = (repo: Repo) => ({ read_auth: repo.owner.auth.mode });

assertion('mac.kem-key-published', async (ctx) => {
  const { owner } = await ownerSpace(ctx);
  const doc = await setup('resolve the author DID document', () => ctx.plc.resolve(owner.did));
  const evidence = { verificationMethod: JSON.stringify(doc.verificationMethod ?? []).slice(0, 2000) };
  const vm = doc.verificationMethod?.find((m) => m.id === `${doc.id}#atproto_kem` || m.id === '#atproto_kem');
  if (!vm) fail(`${owner.did}'s DID document has no #atproto_kem verification method`, evidence);
  if (vm!.type !== 'Multikey') fail(`#atproto_kem has type ${vm!.type}, not Multikey`, evidence);
  if (vm!.controller !== doc.id) fail(`#atproto_kem's controller is ${vm!.controller}, not the author`, evidence);
  let curve: string;
  try {
    curve = parseMultikey(vm!.publicKeyMultibase).curve;
  } catch (e) {
    return fail(`#atproto_kem's publicKeyMultibase doesn't parse: ${(e as Error).message}`, evidence);
  }
  if (curve !== 'p256') fail(`#atproto_kem is a ${curve} key, not P-256`, evidence);
});

assertion('mac.commit-header-present', async (ctx) => {
  const repo = await repoWithRecord(ctx);
  const { syncer, target } = await syncerFor(repo);
  if (!target.authorKem) fail('the author publishes no #atproto_kem key, so the harness cannot ask for a MAC', readAuth(repo));
  const { response, mac } = await syncer.commit(target);
  const evidence = { ...readAuth(repo), status: response.status, header: mac.header ?? null, vary: mac.vary };
  if (response.status !== 200) fail(`getLatestCommit answered ${response.status}`, evidence);
  if (!mac.header) fail('getLatestCommit with Atproto-Space-Want-Mac returned no Atproto-Space-Mac', evidence);
  let m;
  try {
    m = parseMacHeader(mac.header!);
  } catch (e) {
    return fail(`Atproto-Space-Mac doesn't parse: ${(e as Error).message}`, evidence);
  }
  if (m.type !== REPO_TYPE || m.ver !== 1) fail(`Atproto-Space-Mac has type ${m.type} ver ${m.ver}, not the requested ${REPO_TYPE} ver 1`, evidence);
});

assertion('mac.commit-valid', async (ctx) => {
  const repo = await repoWithRecord(ctx);
  const { syncer, target } = await syncerFor(repo);
  if (!target.authorKem) fail('the author publishes no #atproto_kem key, so no MAC can be checked', readAuth(repo));
  const { response, mac } = await syncer.commit(target);
  if (response.status !== 200) fail(`getLatestCommit answered ${response.status}`, { status: response.status });
  commitOrFail(response.body?.commit);
  if (!mac.verified) fail(`the commit MAC doesn't verify: ${mac.reason}`, { ...readAuth(repo), header: mac.header ?? null, commit: JSON.stringify(response.body?.commit).slice(0, 1000) });
});

assertion('mac.commit-bound-to-repo', async (ctx) => {
  const repo = await repoWithRecord(ctx);
  const { syncer, target } = await syncerFor(repo);
  if (!target.authorKem) fail('the author publishes no #atproto_kem key, so no MAC can be checked', readAuth(repo));
  // Control: with the author's key the MAC verifies. Without that, a non-verifying MAC below proves nothing.
  const control = await syncer.commit(target);
  if (control.response.status !== 200) fail(`getLatestCommit answered ${control.response.status}`, { status: control.response.status });
  commitOrFail(control.response.body?.commit);
  if (!control.mac.verified) fail(`the MAC doesn't verify even against the author's own key (${control.mac.reason}), so binding can't be shown`, readAuth(repo));
  // Another account's KEM key: the host must still use the author's, so this MAC must not verify.
  const other = generate('p256');
  const wrong = await syncer.commit({ ...target, authorKem: other });
  if (!wrong.mac.header) fail('no Atproto-Space-Mac for the second request', readAuth(repo));
  if (wrong.mac.verified) fail('a MAC keyed to another account\'s KEM key verified: the host did not use the author\'s key', { ...readAuth(repo), header: wrong.mac.header ?? null });
});
