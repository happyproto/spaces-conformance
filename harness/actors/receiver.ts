// The receiver and managing-app actors: one HTTP server on :8080, reached by
// the stack as https://harness.test (through Caddy). It serves the harness's
// did:web document and records every notification it gets:
//
//   com.atproto.space.notifyWrite           (forwarded by a space host, or sent by a repo host)
//   com.atproto.space.notifySpaceDeleted    (sent by the authority)
//   com.atproto.managedspace.checkUserAccess (asked by a managedspace authority)
//
// Each event records whether its service auth verified. Responses can be
// scripted, e.g. 503 on the first notifySpaceDeleted for deletion.notify-retry.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { harnessDidDocument, MANAGING_APP_SERVICE, type Resolver, SYNCER_SERVICE, type ServiceAuthCheck, verifyServiceAuth } from './identity.ts';

export type Method = 'com.atproto.space.notifyWrite' | 'com.atproto.space.notifySpaceDeleted' | 'com.atproto.managedspace.checkUserAccess';

export interface Received {
  method: Method;
  at: number;
  /** The body for procedures, the query for queries. */
  input: Record<string, unknown>;
  auth: ServiceAuthCheck;
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
  /** The managing app's answer; default refuses everyone. */
  decide: AccessDecision = () => false;
  private waiters: { pred: (e: Received) => boolean; resolve: (e: Received) => void }[] = [];

  constructor(resolver: Resolver) {
    this.resolver = resolver;
  }

  /** Script the response for a method; return undefined to fall through to the default. */
  respond(method: Method, fn: Responder) {
    this.responders.set(method, fn);
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
      const isQuery = method === 'com.atproto.managedspace.checkUserAccess';
      if (!['com.atproto.space.notifyWrite', 'com.atproto.space.notifySpaceDeleted', 'com.atproto.managedspace.checkUserAccess'].includes(method))
        return send(501, { error: 'MethodNotImplemented', message: `the harness doesn't serve ${url.pathname}` });
      let input: Record<string, unknown>;
      try {
        input = isQuery ? Object.fromEntries(url.searchParams) : JSON.parse((await readBody(req)) || '{}');
      } catch {
        return send(400, { error: 'InvalidRequest', message: 'body is not JSON' });
      }
      const aud = isQuery ? MANAGING_APP_SERVICE : SYNCER_SERVICE;
      const auth = await verifyServiceAuth(req.headers.authorization, { aud, lxm: method }, this.resolver);
      const n = (this.counts.get(method) ?? 0) + 1;
      this.counts.set(method, n);
      const base = { method, at: Date.now(), input, auth, host: req.headers.host };
      const scripted = this.responders.get(method)?.(base, n);
      const status = scripted?.status ?? (auth.ok ? 200 : 401);
      const body =
        scripted?.body ??
        (status === 200
          ? isQuery
            ? { authorized: this.decide(input as never) }
            : {}
          : { error: auth.ok ? 'ScriptedFailure' : 'AuthenticationRequired', message: auth.reason ?? 'scripted' });
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
   * The receiver lives for the whole run, so events from earlier tests are
   * still here: pass `from` (a mark() taken before the action) to look only at
   * later events, or make pred specific to this test's space and repo.
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

  count(method: Method): number {
    return this.counts.get(method) ?? 0;
  }

  close(): Promise<void> {
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
