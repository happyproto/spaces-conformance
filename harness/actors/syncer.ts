// The syncer actor: reads a repo the way a 0016 syncer does, and reports
// what it saw rather than throwing, so assertions can grade each step.
//
//   commit()  getLatestCommit with a MAC request, MAC checked
//   oplog()   listRepoOps from `since`, following cursor to the end, folded into a set hash
//   archive() getRepo, read as STAR, streamed into a set hash, MAC checked
//   record()  getRecord with a record MAC request (2026-11-12), MAC checked
//
// The MAC request follows the revision graded: 2026-10-29's
// Atproto-Space-Want-Mac / Atproto-Space-Mac, or from 2026-11-12 RFC 9421
// Accept-Signature with the HPKE export secret (macsig.ts).

import { fromB64, hex } from '../crypto/bytes.ts';
import { recordCid } from '../crypto/drisl.ts';
import { syncerExportSecret, syncerSharedSecret } from '../crypto/kem.ts';
import { didKey, generate, type PublicKey } from '../crypto/keys.ts';
import { LtHash } from '../crypto/lthash.ts';
import { commitMac, macEquals, parseMacHeader, REPO_TYPE, wantMacHeader } from '../crypto/mac.ts';
import { acceptSignature, COMMIT_PROFILE, commitFromFields, coveredHeader, type MacProfile, RECORD_PROFILE, recordFromFields, verifyMacResponse } from '../crypto/macsig.ts';
import { checkSpaceRepo } from '../crypto/star.ts';
import type { HttpResponse } from '../http.ts';

/** Sends an authenticated read: a space credential presentation or an OAuth session. */
export type ReadFetch = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

export interface Target {
  repoHost: string;
  space: string;
  repo: string;
  /**
   * The author's #atproto_kem key, from their DID document. Without one the
   * syncer sends no Atproto-Space-Want-Mac, and every MAC check says why.
   */
  authorKem?: PublicKey;
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
  /** Vary lists the request header: Atproto-Space-Want-Mac, or Accept-Signature from 2026-11-12. */
  vary: boolean;
  /** Atproto-Space-Mac, or from 2026-11-12 the profile's covered header. */
  header?: string;
  /** From 2026-11-12: the Signature-Input and Signature headers as answered. */
  signatureInput?: string;
  signature?: string;
}

/** What one MAC request sent: its headers, the secret to check with, and (2026-11-12) the requested keyid. */
export interface KeyShare {
  headers: Record<string, string>;
  secret?: Uint8Array;
  keyid?: string;
}

/** The 2026-11-12 MAC headers of a response, keyed as verifyMacResponse reads them. */
function macsigHeaders(r: HttpResponse, profile: MacProfile) {
  const get = (h: string) => r.headers.get(h) ?? undefined;
  return { [coveredHeader(profile)]: get(coveredHeader(profile)), 'signature-input': get('signature-input'), signature: get('signature') };
}

const varies = (r: HttpResponse, header: string) =>
  (r.headers.get('vary') ?? '').toLowerCase().split(',').map((s) => s.trim()).includes(header);

/**
 * Check a 2026-11-12 MAC (#requesting-a-mac) over a response that should
 * carry `commit`. The covered Atproto-Space-Commit must verify, match the body
 * commit, and name the requested repo and space (#commit-mac).
 */
export function checkCommitMacSig(r: HttpResponse, commit: Commit | null, ks: KeyShare, t: Pick<Target, 'repo' | 'space'>): MacCheck {
  const h = macsigHeaders(r, COMMIT_PROFILE);
  const base = { vary: varies(r, 'accept-signature'), header: h[COMMIT_PROFILE], signatureInput: h['signature-input'], signature: h.signature };
  const present = !!(h[COMMIT_PROFILE] || h['signature-input'] || h.signature);
  if (!ks.secret || !ks.keyid) return { ...base, present, verified: false, reason: 'the author publishes no #atproto_kem key, so no MAC was requested' };
  if (!present) return { ...base, present, verified: false, reason: 'no Atproto-Space-Commit, Signature-Input or Signature header' };
  if (!commit) return { ...base, present, verified: false, reason: 'no 0016 commit to check the MAC against' };
  const v = verifyMacResponse(COMMIT_PROFILE, h, ks.secret, ks.keyid);
  if (typeof v === 'string') return { ...base, present, verified: false, reason: v };
  const f = commitFromFields(v.fields);
  if (typeof f === 'string') return { ...base, present, verified: false, reason: f };
  for (const k of ['ver', 'repo', 'space', 'rev'] as const)
    if (f[k] !== commit[k]) return { ...base, present, verified: false, reason: `Atproto-Space-Commit's ${k} ${JSON.stringify(f[k])} differs from the body commit's ${JSON.stringify(commit[k])}` };
  if (hex(f.data) !== hex(commit.data)) return { ...base, present, verified: false, reason: "Atproto-Space-Commit's data differs from the body commit's" };
  if (f.repo !== t.repo || f.space !== t.space) return { ...base, present, verified: false, reason: `Atproto-Space-Commit names ${f.repo} in ${f.space}, not the requested ${t.repo} in ${t.space}` };
  return { ...base, present, verified: true };
}

/**
 * Check a 2026-11-12 record MAC (#record-mac): it verifies, its URI is the
 * requested one, and its CID is the CID of the record value returned.
 */
export function checkRecordMacSig(r: HttpResponse, uri: string, ks: KeyShare): MacCheck {
  const h = macsigHeaders(r, RECORD_PROFILE);
  const base = { vary: varies(r, 'accept-signature'), header: h[RECORD_PROFILE], signatureInput: h['signature-input'], signature: h.signature };
  const present = !!(h[RECORD_PROFILE] || h['signature-input'] || h.signature);
  if (!ks.secret || !ks.keyid) return { ...base, present, verified: false, reason: 'the author publishes no #atproto_kem key, so no MAC was requested' };
  if (!present) return { ...base, present, verified: false, reason: 'no Atproto-Space-Record, Signature-Input or Signature header' };
  const v = verifyMacResponse(RECORD_PROFILE, h, ks.secret, ks.keyid);
  if (typeof v === 'string') return { ...base, present, verified: false, reason: v };
  const f = recordFromFields(v.fields);
  if (typeof f === 'string') return { ...base, present, verified: false, reason: f };
  if (f.uri !== uri) return { ...base, present, verified: false, reason: `Atproto-Space-Record's uri ${f.uri} is not the requested ${uri}` };
  let cid: string;
  try {
    cid = recordCid(r.body?.value).toString();
  } catch (e) {
    return { ...base, present, verified: false, reason: `the returned record has no CID the harness can compute: ${(e as Error).message}` };
  }
  if (f.cid !== cid) return { ...base, present, verified: false, reason: `Atproto-Space-Record's cid ${f.cid} is not the returned record's CID ${cid}` };
  return { ...base, present, verified: true };
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
export function checkCommitMac(r: HttpResponse, commit: Commit | null, sharedSecret: Uint8Array | undefined, requestedVer = 1): MacCheck {
  const header = r.headers.get('atproto-space-mac') ?? undefined;
  const vary = (r.headers.get('vary') ?? '').toLowerCase().split(',').map((s) => s.trim()).includes('atproto-space-want-mac');
  if (!sharedSecret) return { present: !!header, verified: false, reason: 'the author publishes no #atproto_kem key, so no MAC was requested', vary, header };
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

export interface SyncerOptions {
  /** Request MACs the 2026-11-12 way (RFC 9421 Accept-Signature, HPKE export). */
  macsig?: boolean;
}

export class Syncer {
  private readonly fetch: ReadFetch;
  readonly macsig: boolean;
  constructor(fetch: ReadFetch, opts: SyncerOptions = {}) {
    this.fetch = fetch;
    this.macsig = !!opts.macsig;
  }

  /**
   * A fresh key share for every request, as #shared-secret requires. From
   * 2026-11-12, `profile` picks the MAC profile and `o` the request's label
   * and alg.
   */
  keyShare(t: Target, profile: MacProfile = COMMIT_PROFILE, o: { label?: string; alg?: string } = {}): KeyShare {
    if (!t.authorKem) return { headers: {} };
    const eph = generate('p256');
    if (this.macsig)
      return { headers: { 'accept-signature': acceptSignature(profile, eph, o) }, secret: syncerExportSecret(eph, t.authorKem), keyid: didKey(eph) };
    return { headers: { 'atproto-space-want-mac': wantMacHeader(REPO_TYPE, 1, eph) }, secret: syncerSharedSecret(eph, t.authorKem) };
  }

  private checkCommit(r: HttpResponse, commit: Commit | null, ks: KeyShare, t: Target): MacCheck {
    return this.macsig ? checkCommitMacSig(r, commit, ks, t) : checkCommitMac(r, commit, ks.secret);
  }

  /** A raw read with the caller's own headers, for requests the syncer wouldn't send (malformed MAC requests). */
  request(t: Target, nsid: string, headers: Record<string, string>, extra: Record<string, string> = {}) {
    return this.fetch(xrpc(t, nsid, extra), headers);
  }

  /** getLatestCommit; `ks` overrides the key share (a request with another label or alg). */
  async commit(t: Target, ks: KeyShare = this.keyShare(t)) {
    const r = await this.fetch(xrpc(t, 'com.atproto.space.getLatestCommit'), ks.headers);
    const commit = r.status === 200 ? parseCommit(r.body?.commit) : null;
    return { response: r, commit, mac: this.checkCommit(r, commit, ks, t) };
  }

  /** getRecord with a 2026-11-12 record MAC request. The URI is the record's full space URI (#addressing). */
  async record(t: Target, collection: string, rkey: string) {
    const ks = this.keyShare(t, RECORD_PROFILE);
    const uri = `${t.space}/${t.repo}/${collection}/${rkey}`;
    const r = await this.fetch(xrpc(t, 'com.atproto.space.getRecord', { collection, rkey }), ks.headers);
    return { response: r, uri, mac: checkRecordMacSig(r, uri, ks) };
  }

  /** Every op after `since`, following cursor. Each page gets its own key share. */
  async oplog(t: Target, opts: { since?: string; limit?: number; maxPages?: number } = {}) {
    const ops: { rev: string; collection: string; rkey: string; cid: string | null; prev: string | null; value?: unknown }[] = [];
    // commitRev: the rev of the page's 0016 commit, when it carries one.
    const pages: { status: number; ops: number; commit: boolean; commitRev?: string; mac: MacCheck }[] = [];
    let cursor: string | undefined;
    let final: { commit: Commit | null; mac: MacCheck } | undefined;
    for (let i = 0; i < (opts.maxPages ?? 1000); i++) {
      const params: Record<string, string> = {};
      if (opts.since) params.since = opts.since;
      if (opts.limit) params.limit = String(opts.limit);
      if (cursor) params.cursor = cursor;
      const ks = this.keyShare(t);
      const r = await this.fetch(xrpc(t, 'com.atproto.space.listRepoOps', params), ks.headers);
      if (r.status !== 200) {
        pages.push({ status: r.status, ops: 0, commit: false, mac: { present: false, verified: false, vary: false } });
        return { ops, pages, final, error: { status: r.status, body: r.body } };
      }
      const pageOps = Array.isArray(r.body?.ops) ? r.body.ops : [];
      ops.push(...pageOps);
      const commit = r.body?.commit ? parseCommit(r.body.commit) : null;
      const mac = this.checkCommit(r, commit, ks, t);
      pages.push({ status: 200, ops: pageOps.length, commit: !!r.body?.commit, ...(commit ? { commitRev: commit.rev } : {}), mac });
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
    const r = await this.fetch(xrpc(t, 'com.atproto.space.getRepo'), { ...ks.headers, accept: 'application/vnd.atproto.star' });
    if (r.status !== 200) return { response: r, error: `getRepo answered ${r.status}` };
    let check;
    try {
      check = checkSpaceRepo(r.bytes);
    } catch (e) {
      return { response: r, error: (e as Error).message };
    }
    const mac = this.checkCommit(r, { ...check.meta }, ks, t);
    return { response: r, check, mac, digestMatches: hex(check.computed) === hex(check.meta.data) };
  }
}
