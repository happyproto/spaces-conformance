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
import { Receiver } from '../harness/actors/receiver.ts';
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

/** The space host for `space`: its authority's #atproto_pds, else the owner's repo host. */
export async function spaceHost(ctx: RunContext, space: string, owner: Account): Promise<string> {
  const did = authorityOf(space);
  if (did === owner.did) return owner.repoHost;
  try {
    const resolver = new Resolver(ctx.plc);
    return serviceEndpoint(await resolver.resolve(did), 'atproto_pds') ?? owner.repoHost;
  } catch {
    return owner.repoHost;
  }
}

export interface Credentialed {
  sync: SpaceSync;
  /** 2026-11-12: the registration token, when one was asked for. */
  token?: string;
  /** The answer to the credential request (and, at 2026-10-29, to registerNotify). */
  answers: Record<string, string>;
}

/**
 * A credential for `repo`'s space, optionally registered for notifications
 * with the receiver. The credential is setup for the rows that use it: a
 * refusal pends. When the space refuses without a delegation token and the
 * harness holds the owner's key, it asks once more with one.
 */
export async function credentialed(repo: Repo, o: { receiver?: Receiver; register?: boolean } = {}): Promise<Credentialed> {
  const { ctx, owner, space } = repo;
  const host = await spaceHost(ctx, space, owner);
  const sync = new SpaceSync(host, space, settled(ctx));
  const token = o.register && settled(ctx) ? o.receiver!.issue(space) : undefined;
  let r = await sync.authorize({ notifyToken: token });
  if (r.status >= 400 && r.status < 500 && owner.keys) r = await sync.authorize({ notifyToken: token, delegationToken: delegationToken(owner, space, owner.keys.signing) });
  const answers: Record<string, string> = { credential: short(r) };
  setupOk(settled(ctx) ? 'authorizeSpaceSync' : 'getSpaceCredential', r);
  if (o.register && !settled(ctx)) answers.registerNotify = short(setupOk('registerNotify', await sync.register()));
  return { sync, ...(token ? { token } : {}), answers };
}

/** The repo's current commit, read with its owner's session (setup). */
export async function commitOf(account: Account, space: string): Promise<{ rev: string; data: string }> {
  return setup(`getLatestCommit for ${account.handle}`, async () => {
    const r = await account.auth.request('GET', xrpcUrl(account.repoHost, 'com.atproto.space.getLatestCommit', { space, repo: account.did }));
    const c = r.body?.commit ?? r.body;
    if (r.status !== 200 || typeof c?.rev !== 'string' || typeof c?.data?.$bytes !== 'string') throw new Error(short(r));
    return { rev: c.rev, data: c.data.$bytes };
  });
}

/** Strip base64 padding, so two $bytes forms compare equal. */
export const unpad = (b: string | undefined) => (b ?? '').replace(/=+$/, '');
