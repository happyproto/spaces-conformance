// The phase 7 credential path, wired for the suites: the receiver's
// lifetime per suite file, the harness's own space authority, and a
// credentialed syncer for a space on the host under test.
//
// Rules shared by every suite that uses it (docs/catalogue.md, "Pending or
// fail"):
//   - steps that only set state up (spaces, writes, credentials for a
//     publicRead space) pend when the host refuses or answers 429 or 5xx;
//   - the method a row is about fails on a refusal, 501 included, and pends
//     only on 429 or another 5xx.

import { afterAll, beforeAll } from 'vitest';
import type { Account } from '../harness/adapter.ts';
import { pending, setup } from '../harness/assert.ts';
import { ForeignAuthority } from '../harness/actors/authority.ts';
import { Resolver } from '../harness/actors/identity.ts';
import { Plc, serviceEndpoint } from '../harness/actors/plc.ts';
import { type Received, Receiver } from '../harness/actors/receiver.ts';
import { authorityOf, SpaceSync } from '../harness/actors/space-sync.ts';
import type { RunContext } from '../harness/context.ts';
import type { HttpResponse } from '../harness/http.ts';
import { delegationToken } from './credentials/delegation-token.ts';
import { settled, SPACE_TYPE, xrpcUrl } from './fixtures.ts';
import type { Repo } from './repo.ts';

export const short = (r: HttpResponse) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;

/** 429 or a 5xx other than 501: an answer that says nothing about the row. */
export const transient = (r: HttpResponse) => r.status === 429 || (r.status >= 500 && r.status !== 501);

/** A setup call's answer: anything but 2xx means the row can't be set up, so it pends. */
export function setupOk(step: string, r: HttpResponse): HttpResponse {
  if (r.status >= 300) pending(`${step} answered ${short(r)}, so the row can't be set up`);
  return r;
}

let rx: Receiver | undefined;

/**
 * Start the receiver on :8080 for this suite file, and stop it after. Suite
 * files run one at a time, each in its own worker, so the port is free.
 * Returns a getter, since the receiver exists only once beforeAll ran.
 */
export function useReceiver(): () => Receiver {
  beforeAll(async () => {
    rx = new Receiver(new Resolver(new Plc(process.env.PLC_URL ?? 'http://plc:2582')));
    await rx.listen();
  });
  afterAll(async () => {
    await rx?.close();
    rx = undefined;
  });
  return () => {
    if (!rx) throw new Error('the receiver is not listening: call useReceiver() at the top of the suite file');
    return rx;
  };
}

let authority: Promise<ForeignAuthority> | undefined;

/** The harness's own space authority, registered in the stack's PLC; the receiver hosts its spaces. */
export async function foreignAuthority(ctx: RunContext, receiver: Receiver): Promise<ForeignAuthority> {
  authority ??= ForeignAuthority.ensure(ctx.plc);
  const a = await setup('register the harness space authority in PLC', () => authority!);
  receiver.hostFor(a.did);
  return a;
}

/** A new memberspace space owned by `owner`, readable by anyone (no delegation token needed). */
export async function publicSpace(ctx: RunContext, owner: Account, o: { publicWrite?: boolean } = {}): Promise<Repo> {
  const space = await ctx.adapter.createSpace(ctx, owner, SPACE_TYPE, {
    $type: 'com.atproto.memberspace.policy',
    publicRead: true,
    ...(o.publicWrite ? { publicWrite: true } : {}),
  });
  return { ctx, owner, space };
}

/**
 * The space host for `space`: its authority's #atproto_pds (#space-authority).
 * When the authority is the owner itself, that's the owner's repo host. For
 * any other authority (e.g. a host's own space DID) the DID document must
 * name one: if it can't be resolved or names none, the row pends, rather
 * than falling back to a host the spec doesn't point at.
 */
export async function spaceHost(ctx: RunContext, space: string, owner: Account): Promise<string> {
  const did = authorityOf(space);
  if (did === owner.did) return owner.repoHost;
  let doc;
  try {
    doc = await new Resolver(ctx.plc).resolve(did);
  } catch (e) {
    return pending(`setup can't find the space host: the authority ${did} doesn't resolve (${(e as Error).message})`);
  }
  return serviceEndpoint(doc, 'atproto_pds') ?? pending(`setup can't find the space host: the authority ${did}'s DID document names no #atproto_pds`);
}

export interface Credentialed {
  sync: SpaceSync;
  /** 2026-11-12: the registration token, when one was asked for. */
  token?: string;
  /** 2026-10-29: registerNotify's answer, when registering. */
  registration?: HttpResponse;
  /** The credential request's answer (and registerNotify's), for evidence. */
  answers: Record<string, string>;
}

/**
 * A credential for `repo`'s space, optionally registered for notifications
 * with the receiver. The credential is setup for the rows that use it: a
 * refusal pends. When the space refuses without a delegation token and the
 * harness holds the owner's key, it asks once more with one.
 *
 * Not for a row that grades token-less issuance for a publicRead space: it
 * retries with a delegation token after any 4xx, so it would hide that refusal.
 */
export async function credentialed(repo: Repo, o: { receiver?: Receiver; register?: boolean; token?: string; gradeRegistration?: boolean } = {}): Promise<Credentialed> {
  const { ctx, owner, space } = repo;
  const host = await spaceHost(ctx, space, owner);
  const sync = new SpaceSync(host, space, settled(ctx));
  const token = o.register && settled(ctx) ? (o.token ?? o.receiver!.issue(space)) : undefined;
  let r = await sync.authorize({ notifyToken: token });
  if (r.status >= 400 && r.status < 500 && owner.keys) r = await sync.authorize({ notifyToken: token, delegationToken: delegationToken(owner, space, owner.keys.signing) });
  const answers: Record<string, string> = { credential: short(r) };
  setupOk(settled(ctx) ? 'authorizeSpaceSync' : 'getSpaceCredential', r);
  let registration: HttpResponse | undefined;
  if (o.register && !settled(ctx)) {
    registration = await sync.register();
    answers.registerNotify = short(registration);
    // registerNotify is setup, unless the row is about registration itself.
    if (!o.gradeRegistration) setupOk('registerNotify', registration);
  }
  return { sync, ...(token ? { token } : {}), ...(registration ? { registration } : {}), answers };
}

/** A repo's current state as its repo host reports it. */
export interface RepoState {
  rev: string;
  /** The commit's `data` (base64). For a pre-0016 commit, its `hash`, which is what that form has in its place. */
  data: string;
  form: '0016' | 'pre-0016';
}

/**
 * The repo's current commit, read with its owner's session (setup). A host
 * that names the parameter `did` instead of the lexicon's `repo` is asked
 * again that way, and a pre-0016 commit gives its `hash` as the data: this
 * is only setup here, and the records and mac rows grade getLatestCommit
 * and the commit's shape themselves.
 */
export async function commitOf(account: Account, space: string): Promise<RepoState> {
  return setup(`getLatestCommit for ${account.handle}`, async () => {
    const get = (param: 'repo' | 'did') => account.auth.request('GET', xrpcUrl(account.repoHost, 'com.atproto.space.getLatestCommit', { space, [param]: account.did }));
    let r = await get('repo');
    if (r.status === 400 && /\bdid\b/.test(JSON.stringify(r.body))) r = await get('did');
    const c = r.body?.commit ?? r.body;
    const data = c?.data?.$bytes ?? c?.hash?.$bytes;
    if (r.status !== 200 || typeof c?.rev !== 'string' || typeof data !== 'string') throw new Error(short(r));
    return { rev: c.rev, data, form: c?.data?.$bytes ? '0016' : 'pre-0016' };
  });
}

/** Strip base64 padding, so two $bytes forms compare equal. */
export const unpad = (b: string | undefined) => (b ?? '').replace(/=+$/, '');

/** Poll `read` until `done` holds or `ms` passes; the last value either way. */
export async function until<T>(read: () => Promise<T>, done: (t: T) => boolean, ms = 15_000, every = 1_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, every));
    v = await read();
  }
  return v;
}

/** Wait until the receiver holds `n` events matching pred since `from`, or `ms` passes; those events. */
export async function received(rx: Receiver, from: number, pred: (e: Received) => boolean, n: number, ms = 20_000) {
  return until(async () => rx.since(from, pred), (es) => es.length >= n, ms, 250);
}
