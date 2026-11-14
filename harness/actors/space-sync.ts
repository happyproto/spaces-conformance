// The credentialed-syncer actor: the harness as an application that syncs a
// space with a space credential (#authorizing-space-sync,
// #presenting-a-space-credential), registers for its notifications
// (#registering-for-notifications) and reads its writer set
// (#the-sync-boundary-writer-set). It follows the revision graded:
//
//   step         2026-11-12                          2026-10-29
//   credential   authorizeSpaceSync {credentialKey}  getSpaceCredential {credentialKid}
//   register     authorizeSpaceSync {notify}         registerNotify {service}
//   unregister   (stop reauthorizing)                unregisterNotify
//   writer set   listWriters                         listRepos
//
// Like the syncer actor, it answers what the host said rather than throwing,
// so suites decide what is setup and what is graded. Each credential gets a
// fresh P-256 key, as #credential-key-binding says it should.

import { decodeJwt } from '../crypto/jwt.ts';
import { didKey, generate, type KeyPair } from '../crypto/keys.ts';
import { presentCredential } from '../crypto/httpsig.ts';
import { http, type HttpResponse, json } from '../http.ts';
import { HARNESS_URL, SYNCER_SERVICE } from './identity.ts';

export const NOTIFY_ENDPOINT = HARNESS_URL;

/** The authority DID of a space URI. */
export const authorityOf = (space: string) => space.slice('at://'.length).split('/')[0];

/** One writer-set entry, the same shape at both revisions. */
export interface Writer {
  repo: string;
  /** False for a 2026-11-12 repoRemoved entry. */
  present: boolean;
  repoRev?: string;
  /** Base64, as the $bytes JSON form carries it. */
  data?: string;
  spaceRev?: string;
  $type?: string;
}

export interface WriterSet {
  writers: Writer[];
  /** Each page's status and entry count, in order. */
  pages: { status: number; n: number; cursor?: string }[];
  /** The first non-200 page, if any. */
  error?: HttpResponse;
  /** Paging stopped because a cursor repeated or the page cap was hit. */
  runaway?: string;
}

const xrpc = (base: string, nsid: string, params?: Record<string, string>) =>
  `${base.replace(/\/$/, '')}/xrpc/${nsid}${params ? `?${new URLSearchParams(params)}` : ''}`;

/** Normalize one listWriters (repoWrite | repoRemoved) or listRepos (#repo) entry. */
export function writerOf(e: Record<string, any>): Writer {
  const t = typeof e.$type === 'string' ? e.$type : undefined;
  return {
    repo: String(e.repo ?? e.did ?? ''),
    present: !(t ?? '').endsWith('#repoRemoved'),
    ...(e.repoRev !== undefined ? { repoRev: String(e.repoRev) } : {}),
    ...(e.data?.$bytes !== undefined ? { data: String(e.data.$bytes) } : {}),
    ...(e.spaceRev !== undefined ? { spaceRev: String(e.spaceRev) } : {}),
    ...(t ? { $type: t } : {}),
  };
}

export interface AuthorizeOptions {
  delegationToken?: string;
  /** 2026-11-12: register for notifications with this token on the harness endpoint. */
  notifyToken?: string;
}

export class SpaceSync {
  /** The space host: the authority's #atproto_pds. */
  readonly host: string;
  readonly space: string;
  readonly settled: boolean;
  key: KeyPair = generate('p256');
  credential?: string;
  /** 2026-11-12: the spaceRev authorizeSpaceSync answered with. */
  spaceRev?: string;

  constructor(host: string, space: string, settled: boolean) {
    this.host = host;
    this.space = space;
    this.settled = settled;
  }

  get authority(): string {
    return authorityOf(this.space);
  }

  /** The credential's claims, once one was issued. */
  claims(): Record<string, unknown> | undefined {
    return this.credential ? decodeJwt(this.credential).payload : undefined;
  }

  /** Ask for a credential with a fresh key; on success it's kept for the calls below. */
  async authorize(o: AuthorizeOptions = {}): Promise<HttpResponse> {
    const key = generate('p256');
    const body = this.settled
      ? {
          space: this.space,
          credentialKey: didKey(key),
          ...(o.delegationToken ? { delegationToken: o.delegationToken } : {}),
          ...(o.notifyToken ? { notify: { endpoint: NOTIFY_ENDPOINT, token: o.notifyToken } } : {}),
        }
      : { space: this.space, credentialKid: didKey(key), ...(o.delegationToken ? { delegationToken: o.delegationToken } : {}) };
    const r = await http(xrpc(this.host, this.settled ? 'com.atproto.space.authorizeSpaceSync' : 'com.atproto.space.getSpaceCredential'), json(body));
    if (r.status === 200 && typeof r.body?.credential === 'string') {
      this.key = key;
      this.credential = r.body.credential;
      if (typeof r.body.spaceRev === 'string') this.spaceRev = r.body.spaceRev;
    }
    return r;
  }

  /** Use a credential minted elsewhere (e.g. by the harness's own authority), bound to `key`. */
  adopt(credential: string, key: KeyPair) {
    this.credential = credential;
    this.key = key;
  }

  /** Credential presentation headers for `audience` (default: the authority, for calls to the space host). */
  present(audience = this.authority): Record<string, string> {
    if (!this.credential) throw new Error('no credential: authorize() first');
    return presentCredential(this.credential, audience, this.key);
  }

  /** 2026-10-29: registerNotify for the harness syncer service. */
  register(service = SYNCER_SERVICE): Promise<HttpResponse> {
    return http(xrpc(this.host, 'com.atproto.space.registerNotify'), { ...json({ space: this.space, service }), headers: { 'content-type': 'application/json', ...this.present() } });
  }

  /** 2026-10-29: unregisterNotify. */
  unregister(service = SYNCER_SERVICE): Promise<HttpResponse> {
    return http(xrpc(this.host, 'com.atproto.space.unregisterNotify'), { ...json({ space: this.space, service }), headers: { 'content-type': 'application/json', ...this.present() } });
  }

  /** One page of the writer set. */
  writersPage(o: { cursor?: string; limit?: number } = {}): Promise<HttpResponse> {
    const params = { space: this.space, ...(o.limit ? { limit: String(o.limit) } : {}), ...(o.cursor ? { cursor: o.cursor } : {}) };
    return http(xrpc(this.host, this.settled ? 'com.atproto.space.listWriters' : 'com.atproto.space.listRepos', params), { headers: this.present() });
  }

  /** The whole writer set from `cursor`, following cursor. A repeated cursor or 50 pages stops it. */
  async writers(o: { cursor?: string; limit?: number } = {}): Promise<WriterSet> {
    const out: WriterSet = { writers: [], pages: [] };
    const seen = new Set<string>();
    let cursor = o.cursor;
    for (let i = 0; i < 50; i++) {
      const r = await this.writersPage({ cursor, limit: o.limit });
      const entries: Record<string, any>[] = Array.isArray(r.body?.repos) ? r.body.repos : [];
      const next = typeof r.body?.cursor === 'string' ? r.body.cursor : undefined;
      out.pages.push({ status: r.status, n: entries.length, ...(next ? { cursor: next } : {}) });
      if (r.status !== 200) {
        out.error = r;
        return out;
      }
      out.writers.push(...entries.map(writerOf));
      if (!next || !entries.length) return out;
      if (seen.has(next)) {
        out.runaway = `cursor ${next} came back twice`;
        return out;
      }
      seen.add(next);
      cursor = next;
    }
    out.runaway = 'more than 50 pages';
    return out;
  }

  /** getLatestCommit for `repo` on `repoHost`, presenting the credential to that repo's owner. */
  latestCommit(repoHost: string, repo: string): Promise<HttpResponse> {
    return http(xrpc(repoHost, 'com.atproto.space.getLatestCommit', { space: this.space, repo }), { headers: this.present(repo) });
  }
}

/** The latest state of each repo in a writer set (the last entry wins, as entries come in spaceRev order). */
export function latestByRepo(ws: Writer[]): Map<string, Writer> {
  const m = new Map<string, Writer>();
  for (const w of ws) m.set(w.repo, w);
  return m;
}
