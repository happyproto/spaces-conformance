// MAC reads use the owner's own session with Atproto-Space-Want-Mac, as
// HappyView's interop tests do. 0016 requires the MAC only "when called with
// a space credential" (#authenticity-headers), and the harness's credential
// path comes in phase 7. So until then:
//   - no Atproto-Space-Mac on a session read is `skip` ("pending: …"), never
//     `fail` or `error`;
//   - a MAC that is present but wrong (type, ver, or doesn't verify) is `fail`.
// Evidence names the read auth used.

import type { MacCheck } from '../../harness/actors/syncer.ts';
import { assertion, fail, pending, setup } from '../../harness/assert.ts';
import { parseMultikey } from '../../harness/crypto/keys.ts';
import { REPO_TYPE, parseMacHeader } from '../../harness/crypto/mac.ts';
import { ownerSpace } from '../fixtures.ts';
import { commitOrFail, freshRepo, note, type Repo, setupWrites, syncerFor } from '../repo.ts';

async function repoWithRecord(ctx: Parameters<typeof freshRepo>[0]): Promise<Repo> {
  const repo = await freshRepo(ctx);
  await setupWrites(repo).put('m', note('mac'));
  return repo;
}

const readAuth = (repo: Repo) => ({ read_auth: repo.owner.auth.mode });

const CREDENTIAL_PENDING = 'MAC only required on credential reads; credential path in phase 7';

/** No MAC on a session read isn't the host's fault under 0016: skip, pending the credential path. */
function requireMacHeader(mac: MacCheck): string {
  return mac.header ?? pending(CREDENTIAL_PENDING);
}

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
  const header = requireMacHeader(mac);
  let m;
  try {
    m = parseMacHeader(header);
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
  requireMacHeader(mac);
  commitOrFail(response.body?.commit);
  if (!mac.verified) fail(`the commit MAC doesn't verify: ${mac.reason}`, { ...readAuth(repo), header: mac.header ?? null, commit: JSON.stringify(response.body?.commit).slice(0, 1000) });
});

// A real check reads the author's repo as another account (caller != author)
// and verifies the MAC against the author's #atproto_kem, not the caller's.
// Reading as a non-author needs a space credential, so the catalogue row
// requires harness.credential_reads, which no manifest claims until phase 7:
// it records skip. (Asking, as the author, for a MAC keyed to some other key
// proves nothing: the host never sees that key, so it can never verify.)
assertion('mac.commit-bound-to-repo', async () => {
  pending('needs a reader who is not the author, which needs the space-credential path (phase 7)');
});
