import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_DID, MANAGING_APP_SERVICE, Resolver, SYNCER_SERVICE, verifyServiceAuth } from '../harness/actors/identity.ts';
import type { DidDocument, Plc } from '../harness/actors/plc.ts';
import { Receiver } from '../harness/actors/receiver.ts';
import { checkCommitMac, checkCommitMacSig, checkRecordMacSig, Syncer } from '../harness/actors/syncer.ts';
import { b64, hex } from '../harness/crypto/bytes.ts';
import { recordCid, encode, fromLexJson } from '../harness/crypto/drisl.ts';
import { signJwt } from '../harness/crypto/jwt.ts';
import { hostExportSecret, hostSharedSecret, syncerExportSecret } from '../harness/crypto/kem.ts';
import { COMMIT_PROFILE, commitHeader, macRequestList, macResponseHeaders, RECORD_PROFILE, recordHeader } from '../harness/crypto/macsig.ts';
import { didKey, generate, multikey, parseDidKey } from '../harness/crypto/keys.ts';
import { LtHash } from '../harness/crypto/lthash.ts';
import { commitMac, macHeader, parseWantMac } from '../harness/crypto/mac.ts';
import { pathKey, writeStar } from '../harness/crypto/star.ts';
import { http } from '../harness/http.ts';

const SPACE = 'at://did:plc:space/space/com.example.conformance.space/self';
const REPO = 'did:plc:alice';

/** A mock 0016 repo host for one repo with three records written over three revs. */
function mockRepoHost(authorKem: ReturnType<typeof generate>, opts: { wrongKem?: boolean; noVary?: boolean } = {}) {
  const recs = [1, 2, 3].map((i) => ({ collection: 'com.example.conformance.note', rkey: `r${i}`, value: { $type: 'com.example.conformance.note', n: i } }));
  const ops = recs.map((r, i) => ({ rev: `3mzu0000000${i}2`, collection: r.collection, rkey: r.rkey, cid: recordCid(r.value).toString(), prev: null }));
  const data = LtHash.ofRecords(ops).digest();
  const commit = { ver: 1, repo: REPO, space: SPACE, rev: ops[2].rev, data };
  const macFor = (want: string) => {
    const w = parseWantMac(want);
    const kem = opts.wrongKem ? generate('p256') : authorKem;
    return macHeader('atproto-space-repo', 1, commitMac(hostSharedSecret(kem, w.keyShare), commit));
  };
  const commitJson = { ...commit, data: { $bytes: b64(data).replace(/=+$/, '') } };
  const server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const want = req.headers['atproto-space-want-mac'] as string;
    if (!opts.noVary) res.setHeader('vary', 'Atproto-Space-Want-Mac');
    if (u.pathname.endsWith('getLatestCommit')) {
      res.setHeader('atproto-space-mac', macFor(want));
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ commit: commitJson }));
    }
    if (u.pathname.endsWith('listRepoOps')) {
      const start = Number(u.searchParams.get('cursor') ?? 0);
      const limit = Number(u.searchParams.get('limit') ?? 100);
      const page = ops.slice(start, start + limit);
      const last = start + limit >= ops.length;
      if (last) res.setHeader('atproto-space-mac', macFor(want));
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ops: page, ...(last ? { commit: commitJson } : { cursor: String(start + limit) }) }));
    }
    if (u.pathname.endsWith('getRepo')) {
      res.setHeader('atproto-space-mac', macFor(want));
      res.setHeader('content-type', 'application/vnd.atproto.star');
      return res.end(Buffer.from(writeStar({ $type: 'atproto-space-repo', ...commit }, recs.map((r) => ({ key: pathKey(r.collection, r.rkey), value: encode(fromLexJson(r.value)) })))));
    }
    res.statusCode = 404;
    res.end();
  });
  return { server, data };
}

async function listen(s: Server) {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe('checkCommitMac', () => {
  it('requires the ver the request asked for, not the commit\'s own', () => {
    const secret = new Uint8Array(32).fill(7);
    const commit = { ver: 1, repo: REPO, space: SPACE, rev: '3mzu00000002', data: new Uint8Array(32) };
    const resp = (ver: number) => ({ status: 200, headers: new Headers({ 'atproto-space-mac': macHeader('atproto-space-repo', ver, commitMac(secret, commit)) }), body: {}, bytes: new Uint8Array() });
    expect(checkCommitMac(resp(1), commit, secret)).toMatchObject({ verified: true });
    expect(checkCommitMac(resp(2), commit, secret)).toMatchObject({ verified: false, reason: expect.stringMatching(/ver 2/) });
    expect(checkCommitMac(resp(2), { ...commit, ver: 2 }, secret)).toMatchObject({ verified: false });
  });
});

describe('2026-11-12 MAC checks', () => {
  const kem = generate('p256');
  const commit = { ver: 1, repo: REPO, space: SPACE, rev: '3mzu00000002', data: new Uint8Array(32).fill(3) };
  const answer = (profile: typeof COMMIT_PROFILE | typeof RECORD_PROFILE, covered: string, body: unknown = {}, o: { secretKey?: typeof kem } = {}) => {
    const eph = generate('p256');
    const ks = { headers: {}, secret: syncerExportSecret(eph, kem), keyid: didKey(eph) };
    const headers = macResponseHeaders(profile, covered, { label: 'mac', list: macRequestList(profile, eph) }, hostExportSecret(o.secretKey ?? kem, eph));
    return { ks, r: { status: 200, headers: new Headers(headers), body, bytes: new Uint8Array() } };
  };

  it('verifies a commit MAC that matches the body commit and the request', () => {
    const { ks, r } = answer(COMMIT_PROFILE, commitHeader(commit));
    expect(checkCommitMacSig(r, commit, ks, { repo: REPO, space: SPACE })).toMatchObject({ present: true, verified: true, vary: true });
  });

  it('refuses a commit MAC keyed by another KEM key, over another commit, or for another repo', () => {
    const other = answer(COMMIT_PROFILE, commitHeader(commit), {}, { secretKey: generate('p256') });
    expect(checkCommitMacSig(other.r, commit, other.ks, { repo: REPO, space: SPACE })).toMatchObject({ verified: false, reason: 'the MAC does not match' });
    const { ks, r } = answer(COMMIT_PROFILE, commitHeader(commit));
    expect(checkCommitMacSig(r, { ...commit, rev: '3mzu00000003' }, ks, { repo: REPO, space: SPACE }).reason).toMatch(/rev .* differs from the body commit/);
    expect(checkCommitMacSig(r, commit, ks, { repo: 'did:plc:someoneelse', space: SPACE }).reason).toMatch(/not the requested/);
    expect(checkCommitMacSig({ ...r, headers: new Headers() }, commit, ks, { repo: REPO, space: SPACE })).toMatchObject({ present: false, verified: false });
  });

  it('verifies a record MAC against the requested URI and the returned record\'s CID', () => {
    const value = { $type: 'com.example.conformance.note', n: 1 };
    const uri = `${SPACE}/${REPO}/com.example.conformance.note/a`;
    const cid = recordCid(value).toString();
    const ok = answer(RECORD_PROFILE, recordHeader(uri, cid), { value });
    expect(checkRecordMacSig(ok.r, uri, ok.ks)).toMatchObject({ present: true, verified: true });
    expect(checkRecordMacSig(ok.r, `${uri}x`, ok.ks).reason).toMatch(/is not the requested/);
    const wrongCid = answer(RECORD_PROFILE, recordHeader(uri, cid), { value: { ...value, n: 2 } });
    expect(checkRecordMacSig(wrongCid.r, uri, wrongCid.ks).reason).toMatch(/is not the returned record's CID/);
  });
});

describe('syncer', () => {
  const kem = generate('p256');
  const fetcher = (url: string, headers: Record<string, string>) => http(url, { headers });
  let good: Server, bad: Server, goodUrl: string, badUrl: string, data: Uint8Array;
  beforeAll(async () => {
    const g = mockRepoHost(kem);
    good = g.server;
    data = g.data;
    goodUrl = await listen(good);
    bad = mockRepoHost(kem, { wrongKem: true, noVary: true }).server;
    badUrl = await listen(bad);
  });
  afterAll(() => {
    good.close();
    bad.close();
  });
  const target = (repoHost: string) => ({ repoHost, space: SPACE, repo: REPO, authorKem: kem });

  it('verifies a commit MAC and sees Vary', async () => {
    const r = await new Syncer(fetcher).commit(target(goodUrl));
    expect(r.commit?.rev).toBe('3mzu000000022');
    expect(r.mac).toMatchObject({ present: true, verified: true, vary: true });
  });

  it('does not verify a MAC made with another KEM key, and notices a missing Vary', async () => {
    const r = await new Syncer(fetcher).commit(target(badUrl));
    expect(r.mac).toMatchObject({ present: true, verified: false, vary: false, reason: 'MAC does not verify' });
  });

  it('follows the oplog cursor to the end, and the fold matches the final commit', async () => {
    const r = await new Syncer(fetcher).oplog(target(goodUrl), { limit: 2 });
    expect(r.pages.map((p) => [p.ops, p.commit])).toEqual([[2, false], [1, true]]);
    expect(r.final?.mac.verified).toBe(true);
    expect(r.pages[0].mac.present).toBe(false);
    expect(hex(Syncer.fold(r.ops).digest)).toBe(hex(data));
  });

  it('folds deletes and overwrites', () => {
    const f = Syncer.fold([
      { collection: 'a.b.c', rkey: 'x', cid: 'c1' },
      { collection: 'a.b.c', rkey: 'y', cid: 'c2' },
      { collection: 'a.b.c', rkey: 'x', cid: 'c3' },
      { collection: 'a.b.c', rkey: 'y', cid: null },
    ]);
    expect([...f.set]).toEqual([['a.b.c/x', 'c3']]);
    expect(hex(f.digest)).toBe(hex(LtHash.ofRecords([{ collection: 'a.b.c', rkey: 'x', cid: 'c3' }]).digest()));
  });

  it('reads the STAR archive, matches its digest and verifies its MAC', async () => {
    const r = await new Syncer(fetcher).archive(target(goodUrl));
    expect(r.error).toBeUndefined();
    expect(r.digestMatches).toBe(true);
    expect(r.mac?.verified).toBe(true);
    expect(r.check?.records).toHaveLength(3);
  });
});

/** A Resolver over a fixed set of DID documents. */
function stubResolver(docs: Record<string, DidDocument>) {
  return new Resolver({ resolve: async (did: string) => docs[did] ?? Promise.reject(new Error('unknown')) } as unknown as Plc);
}

describe('service auth and the receiver', () => {
  const key = generate('p256');
  const authority = 'did:plc:authority';
  const resolver = stubResolver({
    [authority]: { id: authority, verificationMethod: [{ id: `${authority}#atproto`, type: 'Multikey', controller: authority, publicKeyMultibase: multikey(key) }] },
  });
  const token = (claims: Record<string, unknown>, k = key) =>
    signJwt({ typ: 'JWT' }, { iss: authority, aud: SYNCER_SERVICE, lxm: 'com.atproto.space.notifyWrite', exp: Math.floor(Date.now() / 1000) + 60, ...claims }, k);

  it('verifies service auth and names what is wrong', async () => {
    const want = { aud: SYNCER_SERVICE, lxm: 'com.atproto.space.notifyWrite' };
    expect((await verifyServiceAuth(`Bearer ${token({})}`, want, resolver)).ok).toBe(true);
    expect((await verifyServiceAuth(`Bearer ${token({ aud: HARNESS_DID })}`, want, resolver)).ok).toBe(true);
    expect((await verifyServiceAuth(`Bearer ${token({ aud: 'did:web:other' })}`, want, resolver)).reason).toMatch(/aud/);
    expect((await verifyServiceAuth(`Bearer ${token({ lxm: 'x.y.z' })}`, want, resolver)).reason).toMatch(/lxm/);
    expect((await verifyServiceAuth(`Bearer ${token({ exp: 1 })}`, want, resolver)).reason).toMatch(/expired/);
    expect((await verifyServiceAuth(`Bearer ${token({}, generate('p256'))}`, want, resolver)).reason).toMatch(/doesn't verify/);
    expect((await verifyServiceAuth(undefined, want, resolver)).reason).toMatch(/no Bearer/);
  });

  it('reports the token\'s lxm and aud forms', async () => {
    const want = { aud: SYNCER_SERVICE, lxm: 'com.atproto.space.notifyWrite' };
    expect(await verifyServiceAuth(`Bearer ${token({})}`, want, resolver)).toMatchObject({ ok: true, lxm_present: true, aud_form: 'did#service' });
    expect(await verifyServiceAuth(`Bearer ${token({ aud: HARNESS_DID, lxm: undefined })}`, want, resolver)).toMatchObject({ ok: true, lxm_present: false, aud_form: 'did' });
  });

  let rx: Receiver, url: string;
  beforeAll(async () => {
    rx = new Receiver(resolver);
    await rx.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${((rx as any).server.address() as AddressInfo).port}`;
  });
  afterAll(() => rx.close());

  const post = (method: string, body: unknown, t = token({ lxm: method })) =>
    http(`${url}/xrpc/${method}`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('serves its did:web document', async () => {
    const r = await http(`${url}/.well-known/did.json`);
    expect(r.body.id).toBe(HARNESS_DID);
    expect(r.body.service.map((s: { id: string }) => s.id)).toEqual(['#atproto_space_syncer', '#atproto_managing_app']);
  });

  it('records notifyWrite with its auth check, and refuses bad auth', async () => {
    const ok = await post('com.atproto.space.notifyWrite', { space: SPACE, repo: REPO, repoRev: '3mzu00000002' });
    expect(ok.status).toBe(200);
    const e = await rx.waitFor((x) => x.method === 'com.atproto.space.notifyWrite' && x.auth.ok);
    expect(e.input.repoRev).toBe('3mzu00000002');
    const badAuth = await post('com.atproto.space.notifyWrite', { space: SPACE }, token({ aud: 'did:web:other' }));
    expect(badAuth.status).toBe(401);
  });

  it('answers a scripted 503 first, then 200, so retries can be observed', async () => {
    rx.respond('com.atproto.space.notifySpaceDeleted', (_e, n) => (n === 1 ? { status: 503 } : undefined));
    expect((await post('com.atproto.space.notifySpaceDeleted', { space: SPACE })).status).toBe(503);
    expect((await post('com.atproto.space.notifySpaceDeleted', { space: SPACE })).status).toBe(200);
    expect(rx.count('com.atproto.space.notifySpaceDeleted')).toBe(2);
  });

  it('answers checkUserAccess from its decision function', async () => {
    rx.decide = (q) => q.user === 'did:plc:member' && q.access === 'read';
    const ask = (user: string, access: string) =>
      http(`${url}/xrpc/com.atproto.managedspace.checkUserAccess?${new URLSearchParams({ space: SPACE, user, access })}`, {
        headers: { authorization: `Bearer ${signJwt({}, { iss: authority, aud: MANAGING_APP_SERVICE, lxm: 'com.atproto.managedspace.checkUserAccess', exp: Math.floor(Date.now() / 1000) + 60 }, key)}` },
      });
    expect((await ask('did:plc:member', 'read')).body).toEqual({ authorized: true });
    expect((await ask('did:plc:member', 'write')).body).toEqual({ authorized: false });
    const e = await rx.waitFor((x) => x.method === 'com.atproto.managedspace.checkUserAccess' && x.input.access === 'write');
    expect(e.auth.ok).toBe(true);
  });

  it('waitFor from a mark ignores earlier events', async () => {
    const from = rx.mark();
    await expect(rx.waitFor((x) => x.method === 'com.atproto.space.notifyWrite', 50, from)).rejects.toThrow(/within 50 ms/);
    await post('com.atproto.space.notifyWrite', { space: SPACE, repo: REPO, repoRev: '3mzu00000003' });
    expect((await rx.waitFor((x) => x.method === 'com.atproto.space.notifyWrite', 1000, from)).input.repoRev).toBe('3mzu00000003');
  });

  it('times out waiting for an event that never comes', async () => {
    await expect(rx.waitFor(() => false, 50)).rejects.toThrow(/within 50 ms/);
  });

  it('round trips a did:key through multikey', () => {
    expect(parseDidKey(`did:key:${multikey(key)}`).curve).toBe('p256');
  });
});
