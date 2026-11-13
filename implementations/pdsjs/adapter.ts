// pds.js setup hooks (ungraded). pds.js hosts one account and has no
// createAccount: the operator registers a did:plc and hands the server its
// signing and KEM keys through /init. Each harness user has its own
// container, pdsjs-<name>.test (compose.yml).
//
// Requests use the account's password session (createSession, then Bearer),
// as HappyView's pds.js interop tests do; 0016 doesn't name it, and the run
// records write_auth: password-session. OAuth with DPoP through consent()
// works too (test/stack/oauth.stack.test.ts); the scope suites use it (phase 7).
// The pinned image serves only the Oct 22 com.atproto.simplespace.createSpace;
// --setup-mode picks.

import { createHash } from 'node:crypto';
import type { Adapter } from '../../harness/adapter.ts';
import { setup } from '../../harness/assert.ts';
import { hex } from '../../harness/crypto/bytes.ts';
import { fromSecret, type KeyPair } from '../../harness/crypto/keys.ts';
import { http, json } from '../../harness/http.ts';
import type { Plc } from '../../harness/actors/plc.ts';
import { pdsjsConsent } from '../../harness/oauth/consent/pdsjs.ts';
import { bearer, createSpace, recordedMode } from '../../harness/setup.ts';

export const PASSWORD = 'password123';

export interface PdsjsAccount {
  did: string;
  handle: string;
  pdsUrl: string;
  password: string;
  created: boolean;
  signing: KeyPair;
  kem: KeyPair;
}

/**
 * The account's keys, derived from the run id and handle, so every worker
 * gets the same ones whichever of them created the account. Nothing outside
 * this run's stack ever sees them.
 *
 * Without CONFORMANCE_RUN_ID the seed is the fixed string 'local', so anyone
 * can derive these keys. That's harmless: they sign only for throwaway
 * accounts on this run's internal stack, whose PLC is the harness's own.
 */
export function accountKeys(handle: string, seed = process.env.CONFORMANCE_RUN_ID ?? 'local'): { signing: KeyPair; kem: KeyPair } {
  const key = (label: string) => fromSecret('p256', new Uint8Array(createHash('sha256').update(`spaces-conformance ${seed} ${handle} ${label}`).digest()));
  return { signing: key('signing'), kem: key('kem') };
}

/** The container's account, created on first use. */
export async function provisionAccount(plc: Plc, pdsUrl: string, handle: string, password = PASSWORD): Promise<PdsjsAccount> {
  // The signing key doubles as the rotation key: nothing outside this stack sees it.
  const { signing, kem } = accountKeys(handle);
  const existing = await http(`${pdsUrl}/.well-known/atproto-did`);
  if (existing.status === 200 && typeof existing.body === 'string') {
    return { did: existing.body.trim(), handle, pdsUrl, password, created: false, signing, kem };
  }
  const did = await plc.register({ rotation: signing, signing, kem, handle, pdsUrl });
  const r = await http(
    `${pdsUrl}/init`,
    json({ did, privateKey: hex(signing.secret), kemKey: hex(kem.secret), handle, curve: 'p256', password }),
  );
  if (r.status >= 300) throw new Error(`pds.js /init refused (${r.status}): ${JSON.stringify(r.body)}`);
  return { did, handle, pdsUrl, password, created: true, signing, kem };
}

export const consent = (account: PdsjsAccount) => pdsjsConsent(account.password);

/** The harness users that have a pds.js container. */
export const USERS = ['alice', 'bob'] as const;

export const adapter: Adapter = {
  setupMode: (m) => recordedMode(m, 'custom'),
  provisionAccount: (ctx, name) =>
    setup(`pds.js account ${name}`, async () => {
      if (!(USERS as readonly string[]).includes(name)) throw new Error(`pds.js has a container only for ${USERS.join(', ')}, not ${name}`);
      const pdsUrl = `http://pdsjs-${name}.test`;
      const a = await provisionAccount(ctx.plc, pdsUrl, `${name}.test`);
      const r = await http(`${pdsUrl}/xrpc/com.atproto.server.createSession`, json({ identifier: a.did, password: a.password }));
      if (r.status !== 200 || typeof r.body?.accessJwt !== 'string') throw new Error(`createSession answered ${r.status}: ${JSON.stringify(r.body)}`);
      return { did: a.did, handle: a.handle, repoHost: pdsUrl, auth: bearer(r.body.accessJwt), keys: { signing: a.signing, others: [{ id: '#atproto_kem', key: a.kem }] } };
    }),
  createSpace: (ctx, owner, spaceType, policy) => createSpace(ctx.manifest, owner.repoHost, owner, spaceType, policy),
};
