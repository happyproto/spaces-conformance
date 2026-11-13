// MAC reads use the owner's own session with a MAC request, as HappyView's
// interop tests do: Atproto-Space-Want-Mac at 2026-10-29, or from 2026-11-12
// an RFC 9421 Accept-Signature keyed by the HPKE export (harness/crypto/macsig.ts). 0016 requires the MAC only "when called with
// a space credential" (#authenticity-headers), and the harness's credential
// path comes in phase 7. So until then:
//   - no Atproto-Space-Mac on a session read is `skip` ("pending: …"), never
//     `fail` or `error`;
//   - no #atproto_kem key is `skip` too: mac.kem-key-published grades it once;
//   - a MAC that is present but wrong (type, ver, or doesn't verify) is `fail`.
// Evidence names the read auth used. Rows with no 2026-10-29 test say so as
// pending there; they're graded from 2026-11-12.

import { assertion, fail, pending, setup } from '../../harness/assert.ts';
import { CREDENTIAL_PENDING, requireAuthorKem, requireMac, requireMacHeader } from './precondition.ts';
import type { MacCheck } from '../../harness/actors/syncer.ts';
import { didKey, generate, parseMultikey } from '../../harness/crypto/keys.ts';
import { REPO_TYPE, parseMacHeader } from '../../harness/crypto/mac.ts';
import { COMMIT_PROFILE, MAC_ALG, macRequestList, recordFromFields } from '../../harness/crypto/macsig.ts';
import { isInnerList, parseDictionary, serializeDictionary, type SfDictionary, type SfInnerList } from '../../harness/crypto/sf.ts';
import { COLLECTION, ownerSpace, settled } from '../fixtures.ts';
import { commitOrFail, freshRepo, note, type Repo, setupWrites, syncerFor } from '../repo.ts';

async function repoWithRecord(ctx: Parameters<typeof freshRepo>[0]): Promise<Repo> {
  const repo = await freshRepo(ctx);
  await setupWrites(repo).put('m', note('mac'));
  return repo;
}

const readAuth = (repo: Repo) => ({ read_auth: repo.owner.auth.mode });

const G1_UNTESTED = 'no 2026-10-29 test; this row is graded from 2026-11-12';

/** The 2026-11-12 MAC headers as answered, for evidence. */
const sigEvidence = (mac: MacCheck) => ({ covered: mac.header ?? null, signature_input: mac.signatureInput ?? null, signature: mac.signature ?? null, vary: mac.vary });

function parsed(header: string, name: string, evidence: Record<string, unknown>): SfDictionary {
  try {
    return parseDictionary(header);
  } catch (e) {
    return fail(`${name} doesn't parse as a Structured Field Dictionary: ${(e as Error).message}`, evidence);
  }
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
  requireAuthorKem(target);
  const { response, mac } = await syncer.commit(target);
  if (settled(ctx)) {
    const evidence = { ...readAuth(repo), status: response.status, ...sigEvidence(mac) };
    if (response.status !== 200) fail(`getLatestCommit answered ${response.status}`, evidence);
    requireMac(mac);
    const missing = [!mac.header && 'Atproto-Space-Commit', !mac.signatureInput && 'Signature-Input', !mac.signature && 'Signature'].filter(Boolean);
    if (missing.length) fail(`the MAC answer has no ${missing.join(', ')}`, evidence);
    parsed(mac.header!, 'Atproto-Space-Commit', evidence);
    const inputs = parsed(mac.signatureInput!, 'Signature-Input', evidence);
    const tagged = [...inputs].filter(([, v]) => isInnerList(v) && v.params.some(([k, p]) => k === 'tag' && p === COMMIT_PROFILE));
    if (tagged.length !== 1) fail(`Signature-Input has ${tagged.length} signatures tagged ${COMMIT_PROFILE}, not exactly one`, evidence);
    const list = tagged[0][1] as SfInnerList;
    const item = list.itemParams?.[0] ?? [];
    if (list.inner.length !== 1 || list.inner[0] !== COMMIT_PROFILE || !item.some(([k, v]) => k === 'sf' && v === true))
      fail(`the ${COMMIT_PROFILE} signature doesn't cover exactly ("${COMMIT_PROFILE}";sf)`, evidence);
    return;
  }
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
  requireAuthorKem(target);
  const { response, mac } = await syncer.commit(target);
  if (response.status !== 200) fail(`getLatestCommit answered ${response.status}`, { status: response.status });
  if (settled(ctx)) requireMac(mac);
  else requireMacHeader(mac);
  commitOrFail(response.body?.commit);
  if (!mac.verified)
    fail(`the commit MAC doesn't verify: ${mac.reason}`, { ...readAuth(repo), ...sigEvidence(mac), commit: JSON.stringify(response.body?.commit).slice(0, 1000) });
});

assertion('mac.vary-header', async (ctx) => {
  const repo = await repoWithRecord(ctx);
  const { syncer, target } = await syncerFor(repo);
  requireAuthorKem(target);
  if (!settled(ctx)) {
    const { response, mac } = await syncer.commit(target);
    const evidence = { ...readAuth(repo), status: response.status, header: mac.header ?? null, vary: response.headers.get('vary') };
    if (response.status !== 200) fail(`getLatestCommit answered ${response.status}`, evidence);
    const header = requireMacHeader(mac);
    if (!mac.vary) fail('Vary does not list Atproto-Space-Want-Mac', evidence);
    let m;
    try {
      m = parseMacHeader(header);
    } catch (e) {
      return fail(`Atproto-Space-Mac doesn't parse: ${(e as Error).message}`, evidence);
    }
    if (m.mac.length !== 32) fail(`the MAC is ${m.mac.length} bytes, not 32`, evidence);
    return;
  }
  // A label and an alg the host must echo, rather than the defaults.
  const ks = syncer.keyShare(target, COMMIT_PROFILE, { label: 'sig1', alg: MAC_ALG });
  const { response, mac } = await syncer.commit(target, ks);
  const evidence = { ...readAuth(repo), status: response.status, request: ks.headers['accept-signature'], ...sigEvidence(mac), vary_header: response.headers.get('vary') };
  if (response.status !== 200) fail(`getLatestCommit answered ${response.status}`, evidence);
  requireMac(mac);
  if (!mac.vary) fail('Vary does not list Accept-Signature', evidence);
  if (!mac.signatureInput || !mac.signature) fail('the MAC answer has no Signature-Input or Signature', evidence);
  const input = parsed(mac.signatureInput!, 'Signature-Input', evidence).get('sig1');
  if (!isInnerList(input)) fail('Signature-Input has no signature under the requested label sig1', evidence);
  const param = (k: string) => (input as SfInnerList).params.find(([n]) => n === k)?.[1];
  const want: [string, unknown][] = [
    ['keyid', ks.keyid],
    ['tag', COMMIT_PROFILE],
    ['alg', MAC_ALG],
  ];
  const wrong = want.filter(([k, v]) => param(k) !== v).map(([k, v]) => `${k} is ${JSON.stringify(param(k))}, not ${JSON.stringify(v)}`);
  if (wrong.length) fail(`Signature-Input under sig1 doesn't carry the requested parameters: ${wrong.join('; ')}`, evidence);
  if (!parsed(mac.signature!, 'Signature', evidence).has('sig1')) fail('Signature has no value under the requested label sig1', evidence);
});

assertion('mac.malformed-request-rejected', async (ctx) => {
  if (!settled(ctx)) pending(G1_UNTESTED);
  const repo = await repoWithRecord(ctx);
  const { syncer, target } = await syncerFor(repo);
  requireAuthorKem(target);
  // Control: a host that doesn't MAC this read at all (no space credential)
  // can't show that it refuses a bad request rather than ignoring it.
  // getLatestCommit failing at all is graded elsewhere, so here it's pending.
  const control = await syncer.commit(target);
  if (control.response.status !== 200)
    pending(`getLatestCommit answered ${control.response.status} to a well-formed MAC request, so a refusal below couldn't be told apart`);
  requireMac(control.mac);
  const list = (o: { params?: [string, string][]; keyid?: string } = {}): SfInnerList => {
    const l = macRequestList(COMMIT_PROFILE, o.keyid ?? didKey(generate('p256')));
    return { ...l, params: [...l.params, ...(o.params ?? [])] };
  };
  const cases: [string, string][] = [
    ['a malformed Accept-Signature', `mac=("${COMMIT_PROFILE}";sf;keyid="${didKey(generate('p256'))}"`],
    [`two requests tagged ${COMMIT_PROFILE}`, serializeDictionary([['mac', list()], ['mac2', list()]])],
    ['a request with an extra parameter (nonce)', serializeDictionary([['mac', list({ params: [['nonce', 'conformance']] })]])],
    ['a secp256k1 keyid', serializeDictionary([['mac', list({ keyid: didKey(generate('secp256k1')) })]])],
    ['a keyid that is not a did:key', serializeDictionary([['mac', list({ keyid: 'did:key:znotakey' })]])],
  ];
  const answered: string[] = [];
  const unanswered: string[] = [];
  const answers: Record<string, string> = {};
  for (const [name, header] of cases) {
    const r = await syncer.request(target, 'com.atproto.space.getLatestCommit', { 'accept-signature': header });
    answers[name] = `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
    if (r.status < 300) answered.push(name);
    else if (r.status === 429 || r.status >= 500) unanswered.push(name);
  }
  if (answered.length) fail(`getLatestCommit answered ${answered.join('; ')} instead of refusing it`, { ...readAuth(repo), answers: JSON.stringify(answers) });
  if (unanswered.length) pending(`the host answered 429 or 5xx for ${unanswered.join('; ')}, so those requests weren't judged`);
  // Control again: if a well-formed request no longer gets a MAC, the
  // refusals above may be the host's state (a limit, a revoked session).
  const after = await syncer.commit(target);
  if (after.response.status !== 200 || !after.mac.present)
    pending(`after the malformed requests a well-formed one got ${after.response.status}${after.response.status === 200 ? ' with no MAC' : ''}, so the refusals can't be told apart from host state`);
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

assertion('mac.list-repo-ops-every-page', async (ctx) => {
  const repo = await freshRepo(ctx);
  const w = setupWrites(repo);
  for (const k of ['a', 'b', 'c']) await w.put(k, note(k));
  const { syncer, target } = await syncerFor(repo);
  requireAuthorKem(target);
  const r = await syncer.oplog(target, { limit: 1 });
  const evidence = { ...readAuth(repo), pages: JSON.stringify(r.pages.map((p) => ({ status: p.status, ops: p.ops, commit: p.commit, mac: p.mac.present, verified: p.mac.verified, reason: p.mac.reason }))).slice(0, 2000) };
  if (r.error) fail(`listRepoOps answered ${r.error.status}`, { ...evidence, body: JSON.stringify(r.error.body).slice(0, 500) });
  if (r.pages.length < 2) pending(`listRepoOps with limit=1 gave ${r.pages.length} page(s), so there's no earlier page to check`);
  if (!r.pages.some((p) => p.mac.present)) pending(CREDENTIAL_PENDING);
  const bad = r.pages
    .map((p, i) => (!p.commit ? `page ${i + 1} has no commit` : !p.mac.verified ? `page ${i + 1}'s MAC: ${p.mac.reason}` : null))
    .filter((x): x is string => !!x);
  if (bad.length) fail(bad.join('; '), evidence);
});

assertion('mac.record-valid', async (ctx) => {
  if (!settled(ctx)) pending(G1_UNTESTED);
  const repo = await repoWithRecord(ctx);
  const { syncer, target } = await syncerFor(repo);
  requireAuthorKem(target);
  const { response, uri, mac } = await syncer.record(target, COLLECTION, 'm');
  const evidence = { ...readAuth(repo), status: response.status, uri, ...sigEvidence(mac), body: JSON.stringify(response.body).slice(0, 1000) };
  if (response.status !== 200) fail(`getRecord answered ${response.status}`, evidence);
  requireMac(mac);
  if (!mac.verified) fail(`the record MAC doesn't verify: ${mac.reason}`, evidence);
  // The body's own uri and cid, when given, must name the record the MAC covers.
  const covered = recordFromFields(parseDictionary(mac.header!));
  if (typeof covered !== 'string') {
    if (response.body?.uri !== undefined && response.body.uri !== covered.uri) fail(`getRecord's uri ${response.body.uri} differs from the MAC's ${covered.uri}`, evidence);
    if (response.body?.cid !== undefined && response.body.cid !== covered.cid) fail(`getRecord's cid ${response.body.cid} differs from the MAC's ${covered.cid}`, evidence);
  }
});
