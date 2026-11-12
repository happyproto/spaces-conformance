// The syncer actor: reads a repo the way a 0016 syncer does, and reports
// what it saw rather than throwing, so assertions can grade each step.
//
//   commit()  getLatestCommit with Atproto-Space-Want-Mac, MAC checked
//   oplog()   listRepoOps from `since`, following cursor to the end, folded into a set hash
//   archive() getRepo, read as STAR, streamed into a set hash, MAC checked

import { fromB64, hex } from '../crypto/bytes.ts';
import { syncerSharedSecret } from '../crypto/kem.ts';
import { generate, type PublicKey } from '../crypto/keys.ts';
import { LtHash } from '../crypto/lthash.ts';
import { commitMac, macEquals, parseMacHeader, REPO_TYPE, wantMacHeader } from '../crypto/mac.ts';
import { checkSpaceRepo } from '../crypto/star.ts';
import type { HttpResponse } from '../http.ts';

/** Sends an authenticated read: a space credential presentation or an OAuth session. */
export type ReadFetch = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

export interface Target {
  repoHost: string;
  space: string;
  repo: string;
  /** The author's #atproto_kem key, from their DID document. */
  authorKem: PublicKey;
}

export interface Commit {
  ver: number;
  repo: string;
  space: string;
  rev: string;
  data: Uint8Array;
}

export interface MacCheck {
  present: boolean;
  verified: boolean;
  reason?: string;
  vary: boolean;
  header?: string;
}

const xrpc = (t: Target, nsid: string, extra: Record<string, string> = {}) =>
  `${t.repoHost}/xrpc/${nsid}?${new URLSearchParams({ space: t.space, repo: t.repo, ...extra })}`;

/** Parse a 0016 commit from JSON. Returns null if it isn't one. */
export function parseCommit(c: unknown): Commit | null {
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, any>;
  if (o.ver !== 1 || typeof o.repo !== 'string' || typeof o.space !== 'string' || typeof o.rev !== 'string') return null;
  if (!o.data || typeof o.data.$bytes !== 'string') return null;
  try {
    const data = fromB64(o.data.$bytes);
    return data.length === 32 ? { ver: o.ver, repo: o.repo, space: o.space, rev: o.rev, data } : null;
  } catch {
    return null;
  }
}

/**
 * Check a response's MAC header against `commit`, with the shared secret for
 * this request. The header's type and ver must be the ones the request asked
 * for (#authenticity-headers); the syncer always asks for ver=1.
 */
export function checkCommitMac(r: HttpResponse, commit: Commit | null, sharedSecret: Uint8Array, requestedVer = 1): MacCheck {
  const header = r.headers.get('atproto-space-mac') ?? undefined;
  const vary = (r.headers.get('vary') ?? '').toLowerCase().split(',').map((s) => s.trim()).includes('atproto-space-want-mac');
  if (!header) return { present: false, verified: false, reason: 'no Atproto-Space-Mac header', vary };
  if (!commit) return { present: true, verified: false, reason: 'no 0016 commit to check the MAC against', vary, header };
  try {
    const m = parseMacHeader(header);
    if (m.type !== REPO_TYPE || m.ver !== requestedVer) return { present: true, verified: false, reason: `MAC type ${m.type} ver ${m.ver} doesn't match the request`, vary, header };
    const ok = macEquals(commitMac(sharedSecret, commit), m.mac);
    return { present: true, verified: ok, reason: ok ? undefined : 'MAC does not verify', vary, header };
  } catch (e) {
    return { present: true, verified: false, reason: (e as Error).message, vary, header };
  }
}

export class Syncer {
  private readonly fetch: ReadFetch;
  constructor(fetch: ReadFetch) {
    this.fetch = fetch;
  }

  /** A fresh key share for every request, as #shared-secret requires. */
  private keyShare(t: Target) {
    const eph = generate('p256');
    return { header: wantMacHeader(REPO_TYPE, 1, eph), secret: syncerSharedSecret(eph, t.authorKem) };
  }

  async commit(t: Target) {
    const ks = this.keyShare(t);
    const r = await this.fetch(xrpc(t, 'com.atproto.space.getLatestCommit'), { 'atproto-space-want-mac': ks.header });
    const commit = r.status === 200 ? parseCommit(r.body?.commit) : null;
    return { response: r, commit, mac: checkCommitMac(r, commit, ks.secret) };
  }

  /** Every op after `since`, following cursor. Each page gets its own key share. */
  async oplog(t: Target, opts: { since?: string; limit?: number; maxPages?: number } = {}) {
    const ops: { rev: string; collection: string; rkey: string; cid: string | null; prev: string | null; value?: unknown }[] = [];
    const pages: { status: number; ops: number; commit: boolean; mac: MacCheck }[] = [];
    let cursor: string | undefined;
    let final: { commit: Commit | null; mac: MacCheck } | undefined;
    for (let i = 0; i < (opts.maxPages ?? 1000); i++) {
      const params: Record<string, string> = {};
      if (opts.since) params.since = opts.since;
      if (opts.limit) params.limit = String(opts.limit);
      if (cursor) params.cursor = cursor;
      const ks = this.keyShare(t);
      const r = await this.fetch(xrpc(t, 'com.atproto.space.listRepoOps', params), { 'atproto-space-want-mac': ks.header });
      if (r.status !== 200) {
        pages.push({ status: r.status, ops: 0, commit: false, mac: { present: false, verified: false, vary: false } });
        return { ops, pages, final, error: { status: r.status, body: r.body } };
      }
      const pageOps = Array.isArray(r.body?.ops) ? r.body.ops : [];
      ops.push(...pageOps);
      const commit = r.body?.commit ? parseCommit(r.body.commit) : null;
      const mac = checkCommitMac(r, commit, ks.secret);
      pages.push({ status: 200, ops: pageOps.length, commit: !!r.body?.commit, mac });
      if (r.body?.commit) final = { commit, mac };
      const next = typeof r.body?.cursor === 'string' ? r.body.cursor : undefined;
      if (!next || next === cursor || pageOps.length === 0) break;
      cursor = next;
    }
    return { ops, pages, final, error: undefined };
  }

  /** Fold ops into the record set, latest op per path winning, then hash it. */
  static fold(ops: { collection: string; rkey: string; cid: string | null }[], start = new Map<string, string>()) {
    const set = new Map(start);
    for (const op of ops) {
      const path = `${op.collection}/${op.rkey}`;
      if (op.cid === null) set.delete(path);
      else set.set(path, op.cid);
    }
    const h = new LtHash();
    for (const [path, cid] of set) {
      const i = path.indexOf('/');
      h.add(LtHash.element(path.slice(0, i), path.slice(i + 1), cid));
    }
    return { set, digest: h.digest() };
  }

  async archive(t: Target) {
    const ks = this.keyShare(t);
    const r = await this.fetch(xrpc(t, 'com.atproto.space.getRepo'), { 'atproto-space-want-mac': ks.header, accept: 'application/vnd.atproto.star' });
    if (r.status !== 200) return { response: r, error: `getRepo answered ${r.status}` };
    let check;
    try {
      check = checkSpaceRepo(r.bytes);
    } catch (e) {
      return { response: r, error: (e as Error).message };
    }
    const mac = checkCommitMac(r, { ...check.meta }, ks.secret);
    return { response: r, check, mac, digestMatches: hex(check.computed) === hex(check.meta.data) };
  }
}
