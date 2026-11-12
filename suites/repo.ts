// Helpers for suites that write a repo and then read it back as a syncer.
// Writing the fixture records is setup (ungraded) unless the assertion is
// about the write itself; reads are graded.

import type { Account } from '../harness/adapter.ts';
import { setup, fail } from '../harness/assert.ts';
import { type Commit, parseCommit, Syncer, type Target } from '../harness/actors/syncer.ts';
import { verificationKey } from '../harness/actors/plc.ts';
import type { RunContext } from '../harness/context.ts';
import { fromB64, hex } from '../harness/crypto/bytes.ts';
import { recordCid } from '../harness/crypto/drisl.ts';
import { LtHash } from '../harness/crypto/lthash.ts';
import type { HttpResponse } from '../harness/http.ts';
import { COLLECTION, ownerSpace, SPACE_TYPE, xrpcUrl } from './fixtures.ts';

export interface Repo {
  ctx: RunContext;
  owner: Account;
  space: string;
}

/** A new, empty space owned by the fixture owner, so each assertion controls its record set. */
export async function freshRepo(ctx: RunContext): Promise<Repo> {
  const { owner } = await ownerSpace(ctx);
  const space = await ctx.adapter.createSpace(ctx, owner, SPACE_TYPE, { $type: 'com.atproto.memberspace.policy' });
  return { ctx, owner, space };
}

export const note = (n: number | string, extra: Record<string, unknown> = {}) => ({ $type: COLLECTION, n, ...extra });

const short = (r: HttpResponse) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;

/** The space write methods, answering the raw response. */
export function writes(repo: Repo) {
  const { owner, space } = repo;
  const post = (nsid: string, body: Record<string, unknown>) =>
    owner.auth.request('POST', xrpcUrl(owner.repoHost, nsid), { space, repo: owner.did, ...body });
  return {
    create: (record: unknown, rkey?: string, collection = COLLECTION) =>
      post('com.atproto.space.createRecord', { collection, record, ...(rkey ? { rkey } : {}) }),
    put: (rkey: string, record: unknown, collection = COLLECTION) => post('com.atproto.space.putRecord', { collection, rkey, record }),
    del: (rkey: string, collection = COLLECTION) => post('com.atproto.space.deleteRecord', { collection, rkey }),
    apply: (ws: unknown[]) => post('com.atproto.space.applyWrites', { writes: ws }),
  };
}

/** Writes as setup: a refusal is `error`, because these assertions grade what comes after. */
export function setupWrites(repo: Repo) {
  const w = writes(repo);
  const ok = async (step: string, p: () => Promise<HttpResponse>) =>
    setup(step, async () => {
      const r = await p();
      if (r.status >= 300) throw new Error(short(r));
      return r;
    });
  return {
    put: (rkey: string, record: unknown, collection = COLLECTION) => ok(`putRecord ${rkey}`, () => w.put(rkey, record, collection)),
    del: (rkey: string, collection = COLLECTION) => ok(`deleteRecord ${rkey}`, () => w.del(rkey, collection)),
    apply: (ws: unknown[]) => ok(`applyWrites (${ws.length})`, () => w.apply(ws)),
  };
}

export const createOp = (rkey: string, value: unknown, collection = COLLECTION) => ({
  $type: 'com.atproto.space.applyWrites#create',
  collection,
  rkey,
  value,
});

/** The digest the harness expects for a record set given as path -> value. */
export function expectedDigest(records: Iterable<{ collection: string; rkey: string; value: unknown }>): Uint8Array {
  return LtHash.ofRecords([...records].map((r) => ({ collection: r.collection, rkey: r.rkey, cid: recordCid(r.value).toString() }))).digest();
}

/** Every record the host lists, following cursor, per collection. Graded: a failed read is a fail. */
export async function listAll(repo: Repo, collections: string[] = [COLLECTION]) {
  const { owner, space } = repo;
  const out: { collection: string; rkey: string; cid: string }[] = [];
  for (const collection of collections) {
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const r = await owner.auth.request(
        'GET',
        xrpcUrl(owner.repoHost, 'com.atproto.space.listRecords', { space, repo: owner.did, collection, limit: '100', ...(cursor ? { cursor } : {}) }),
      );
      if (r.status !== 200) fail(`listRecords answered ${r.status}`, { body: JSON.stringify(r.body).slice(0, 1000) });
      // The lexicon's listRecords#record is {collection, rkey, cid, value}.
      for (const rec of r.body.records ?? []) out.push({ collection, rkey: rec.rkey, cid: rec.cid });
      const next = r.body.cursor;
      if (!next || next === cursor || !(r.body.records ?? []).length) break;
      cursor = next;
    }
  }
  return out;
}

/** The syncer, reading as the owner's session (setup: 0016's read auth is OAuth or a credential). */
export async function syncerFor(repo: Repo): Promise<{ syncer: Syncer; target: Target }> {
  const { ctx, owner, space } = repo;
  const doc = await setup('resolve the author DID document', () => ctx.plc.resolve(owner.did));
  const syncer = new Syncer((url, headers) => owner.auth.request('GET', url, undefined, headers));
  return { syncer, target: { repoHost: owner.repoHost, space, repo: owner.did, authorKem: verificationKey(doc, 'atproto_kem') ?? undefined } };
}

/**
 * The 0016 commit in a response body, or a fail that says what came instead.
 * A pre-0016 signed commit (hash, ikm, mac, sig) is named, and its `hash` is
 * compared with the expected digest, so the parity table can show whether
 * the digest itself was right.
 */
export function commitOrFail(raw: unknown, expected?: Uint8Array): Commit {
  const commit = parseCommit(raw);
  if (commit) return commit;
  const c = (raw ?? {}) as Record<string, any>;
  const evidence: Record<string, unknown> = { commit: JSON.stringify(raw).slice(0, 1500) };
  if (c.hash?.$bytes && !c.data) {
    let note = '';
    if (expected) {
      const legacy = hex(fromB64(c.hash.$bytes));
      evidence.legacy_hash = legacy;
      evidence.expected = hex(expected);
      note = legacy === hex(expected) ? '; its pre-0016 hash equals the expected digest' : '; its pre-0016 hash differs from the expected digest too';
    }
    return fail(`the host served a pre-0016 signed commit (hash, ikm, mac, sig), not a 0016 commit${note}`, evidence);
  }
  return fail('the response has no 0016 commit', evidence);
}
