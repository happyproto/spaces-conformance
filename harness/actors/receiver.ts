// The receiver and managing-app actors: one HTTP server on :8080, reached by
// the stack as https://harness.test (through Caddy). It serves the harness's
// did:web document and records every call it gets:
//
//   2026-11-12 (G2)
//     com.atproto.space.confirmRegistration  (the space host, before registering the harness as a syncer)
//     com.atproto.space.notifySpaceUpdate    (the space host, to a registered syncer; token in the body)
//     com.atproto.space.notifyRepoUpdate     (a repo host, to the space host of a harness authority)
//   2026-10-29 (G1)
//     com.atproto.space.notifyWrite          (forwarded by a space host, or sent by a repo host)
//     com.atproto.space.notifySpaceDeleted   (sent by the authority)
//   both
//     com.atproto.managedspace.checkUserAccess (asked by a managedspace authority)
//
// Service-auth methods record whether their auth verified, and which
// audience the token named. The token methods record whether the token was
// one the harness issued for that space (issue()). Responses can be
// scripted, e.g. 503 on the first deletion notice for deletion.notify-retry.

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { harnessDidDocument, MANAGING_APP_SERVICE, type Resolver, SYNCER_SERVICE, type ServiceAuthCheck, verifyServiceAuth } from './identity.ts';

export type Method =
  | 'com.atproto.space.confirmRegistration'
  | 'com.atproto.space.notifySpaceUpdate'
  | 'com.atproto.space.notifyRepoUpdate'
  | 'com.atproto.space.notifyWrite'
  | 'com.atproto.space.notifySpaceDeleted'
  | 'com.atproto.managedspace.checkUserAccess';

/** Methods that carry the registration token in their body instead of service auth (#registering-for-notifications). */
const TOKEN_METHODS: readonly Method[] = ['com.atproto.space.confirmRegistration', 'com.atproto.space.notifySpaceUpdate'];
const QUERY_METHODS: readonly Method[] = ['com.atproto.managedspace.checkUserAccess'];
export const METHODS: readonly Method[] = [
  ...TOKEN_METHODS,
  'com.atproto.space.notifyRepoUpdate',
  'com.atproto.space.notifyWrite',
  'com.atproto.space.notifySpaceDeleted',
  ...QUERY_METHODS,
];

export interface Received {
  method: Method;
  at: number;
  /** The body for procedures, the query for queries. */
  input: Record<string, unknown>;
  /** Service auth, for the methods that take it. */
  auth?: ServiceAuthCheck;
  /** For the token methods: whether the token is one issue() gave out for this space. */
  token_ok?: boolean;
  host?: string;
  answered: number;
}

export type Responder = (e: Omit<Received, 'answered'>, n: number) => { status: number; body?: unknown } | undefined;

export interface AccessDecision {
  (q: { space: string; user: string; access: string; clientId?: string }): boolean;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((res, rej) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => res(s));
    req.on('error', rej);
  });

export class Receiver {
  readonly events: Received[] = [];
  private server?: Server;
  private readonly resolver: Resolver;
  private responders = new Map<Method, Responder>();
  private counts = new Map<Method, number>();
  /** Registration tokens the harness issued, token -> space. */
  private tokens = new Map<string, string>();
  /** DIDs the harness is the space host for: notifyRepoUpdate and notifyWrite may be addressed to them. */
  private authorities = new Set<string>();
  /** The managing app's answer; default refuses everyone. */
  decide: AccessDecision = () => false;
  private waiters: { pred: (e: Received) => boolean; resolve: (e: Received) => void }[] = [];

  constructor(resolver: Resolver) {
    this.resolver = resolver;
  }

  /** Script the response for a method; return undefined to fall through to the default. */
  respond(method: Method, fn: Responder | undefined) {
    if (fn) this.responders.set(method, fn);
    else this.responders.delete(method);
  }

  /** A fresh registration token for `space` (#registering-for-notifications: 32 random bytes, base64). */
  issue(space: string): string {
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(token, space);
    return token;
  }

  /** Answer service auth addressed to `did` (or `did#atproto_pds`) as its space host. */
  hostFor(did: string) {
    this.authorities.add(did);
  }

  /** The audiences a service-auth method accepts. */
  private audiences(method: Method): string[] {
    if (method === 'com.atproto.managedspace.checkUserAccess') return [MANAGING_APP_SERVICE];
    const asHost = [...this.authorities].flatMap((d) => [d, `${d}#atproto_pds`]);
    if (method === 'com.atproto.space.notifyRepoUpdate') return asHost;
    // G1 notifyWrite is both repo host -> space host and space host -> syncer.
    if (method === 'com.atproto.space.notifyWrite') return [SYNCER_SERVICE, ...asHost];
    return [SYNCER_SERVICE];
  }

  async listen(port = Number(process.env.HARNESS_PORT ?? 8080), host = '::'): Promise<void> {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://harness');
      const send = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/.well-known/did.json') return send(200, harnessDidDocument());
      if (url.pathname === '/xrpc/_health') return send(200, { version: 'spaces-conformance' });
      const method = url.pathname.replace(/^\/xrpc\//, '') as Method;
      if (!METHODS.includes(method)) return send(501, { error: 'MethodNotImplemented', message: `the harness doesn't serve ${url.pathname}` });
      const isQuery = QUERY_METHODS.includes(method);
      let input: Record<string, unknown>;
      try {
        input = isQuery ? Object.fromEntries(url.searchParams) : JSON.parse((await readBody(req)) || '{}');
      } catch {
        return send(400, { error: 'InvalidRequest', message: 'body is not JSON' });
      }
      const n = (this.counts.get(method) ?? 0) + 1;
      this.counts.set(method, n);
      const tokenMethod = TOKEN_METHODS.includes(method);
      const auth = tokenMethod ? undefined : await verifyServiceAuth(req.headers.authorization, { aud: this.audiences(method), lxm: method }, this.resolver);
      const token_ok = tokenMethod ? typeof input.token === 'string' && this.tokens.get(input.token) === input.space : undefined;
      const base = { method, at: Date.now(), input, ...(auth ? { auth } : {}), ...(tokenMethod ? { token_ok } : {}), host: req.headers.host };
      const scripted = this.responders.get(method)?.(base, n);
      const ok = tokenMethod ? token_ok! : auth!.ok;
      const status = scripted?.status ?? (ok ? 200 : tokenMethod ? 400 : 401);
      const body =
        scripted?.body ??
        (status === 200
          ? isQuery
            ? { authorized: this.decide(input as never) }
            : method === 'com.atproto.space.confirmRegistration'
              ? { challenge: input.challenge }
              : {}
          : ok
            ? { error: 'ScriptedFailure', message: 'scripted' }
            : tokenMethod
              ? { error: 'InvalidToken', message: 'the harness did not issue this token for this space' }
              : { error: 'AuthenticationRequired', message: auth!.reason ?? 'service auth did not verify' });
      const event: Received = { ...base, answered: status };
      this.events.push(event);
      this.waiters = this.waiters.filter((w) => (w.pred(event) ? (w.resolve(event), false) : true));
      send(status, body);
    });
    await new Promise<void>((r) => this.server!.listen(port, host, r));
  }

  /** A position in the event log, to pass as waitFor's `from`. */
  mark(): number {
    return this.events.length;
  }

  /**
   * Resolve with the first event matching pred, or reject after timeoutMs.
   * The receiver lives for the whole suite file, so events from earlier tests
   * are still here: pass `from` (a mark() taken before the action) to look
   * only at later events, or make pred specific to this test's space and repo.
   */
  waitFor(pred: (e: Received) => boolean, timeoutMs = 15_000, from = 0): Promise<Received> {
    const hit = this.events.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`no matching event within ${timeoutMs} ms`));
      }, timeoutMs).unref();
    });
  }

  /** Like waitFor, but undefined instead of a rejection when nothing comes. */
  async maybe(pred: (e: Received) => boolean, timeoutMs: number, from = 0): Promise<Received | undefined> {
    try {
      return await this.waitFor(pred, timeoutMs, from);
    } catch {
      return undefined;
    }
  }

  /** Events since `from` matching pred. */
  since(from: number, pred: (e: Received) => boolean = () => true): Received[] {
    return this.events.slice(from).filter(pred);
  }

  count(method: Method): number {
    return this.counts.get(method) ?? 0;
  }

  close(): Promise<void> {
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
