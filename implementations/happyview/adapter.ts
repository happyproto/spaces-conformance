// HappyView setup hooks (ungraded, design ch. 4.2). HappyView hosts no
// accounts: users live on pds.js (one container per user), and HappyView runs
// their sessions for an app through its API-client flow (phase 0 spike 1):
//
//   1. POST /oauth/dpop-keys with the seeded API client's key and secret.
//      HappyView returns the DPoP key it will bind the session to.
//   2. OAuth (PAR, PKCE, DPoP) against the user's pds.js with that key, and
//      pds.js's headless consent.
//   3. POST /oauth/sessions with the granted token set. The registered scope
//      is always what the authorization server granted (registration.ts).
//   4. XRPC calls to HappyView with Authorization: DPoP, a DPoP proof and
//      X-Client-Key.
//
// With feature.spaces_pds_migration off, HappyView hosts every user's space
// repos itself, so an account's repoHost is HappyView. Spaces are created
// with com.atproto.space.createSpace (setup mode oct29), and HappyView
// creates each under its own space DID.

import { setup } from '../../harness/assert.ts';
import type { Account, Adapter, WriteAuth } from '../../harness/adapter.ts';
import { http, json } from '../../harness/http.ts';
import { authorize, loopbackClientId } from '../../harness/oauth/client.ts';
import { dpopRequest, keyFromJwk, NonceStore } from '../../harness/oauth/dpop.ts';
import { sessionRegistration } from '../../harness/oauth/registration.ts';
import { createSpace, recordedMode } from '../../harness/setup.ts';
import { consent, provisionAccount, USERS } from '../pdsjs/adapter.ts';

/** The fixture space type, as bootstrap.sh seeds the API client's scope. */
export const SPACE_TYPE = 'com.example.conformance.space';
export const SCOPE = `atproto space:${SPACE_TYPE}?authority=*&manage=create&manage=update&manage=delete&collection=*`;

/** The API client seed.sql registers. The secret comes from HV_CLIENT_SECRET, as in bootstrap.sh. */
const CLIENT_KEY = 'hvc_conformance';
const clientSecret = () => process.env.HV_CLIENT_SECRET ?? 'hvs_conformance-secret';

/** Requests as a HappyView-held OAuth session: DPoP-bound, with the API client's key. */
export function happyviewSession(key: ReturnType<typeof keyFromJwk>, accessToken: string): WriteAuth {
  const nonces = new NonceStore();
  return {
    mode: 'oauth-dpop',
    request: (method, url, body, headers = {}) =>
      dpopRequest(key, method, url, {
        accessToken,
        nonces,
        headers: { ...headers, 'x-client-key': CLIENT_KEY, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };
}

/** One pds.js user, signed in to HappyView through the API-client flow. */
export async function signIn(baseUrl: string, plc: Parameters<typeof provisionAccount>[0], name: string, scope = SCOPE): Promise<Account> {
  if (!(USERS as readonly string[]).includes(name)) throw new Error(`pds.js has a container only for ${USERS.join(', ')}, not ${name}`);
  const pdsUrl = `http://pdsjs-${name}.test`;
  const acct = await setup(`pds.js account ${name}`, () => provisionAccount(plc, pdsUrl, `${name}.test`));
  const client = { 'x-client-key': CLIENT_KEY, 'x-client-secret': clientSecret(), 'content-type': 'application/json' };
  const prov = await setup('HappyView /oauth/dpop-keys', async () => {
    const r = await http(`${baseUrl}/oauth/dpop-keys`, { ...json({}), headers: client });
    if (r.status !== 201 || !r.body?.dpop_key || !r.body?.provision_id) throw new Error(`answered ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body as { dpop_key: Record<string, string>; provision_id: string };
  });
  const key = keyFromJwk(prov.dpop_key);
  const tokens = await setup(`OAuth at pds.js for ${name}`, () =>
    authorize({ issuer: pdsUrl, clientId: loopbackClientId(scope), scope, loginHint: acct.did, dpopKey: key, consent: consent(acct) }),
  );
  await setup('HappyView /oauth/sessions', async () => {
    const r = await http(`${baseUrl}/oauth/sessions`, { ...json(sessionRegistration(prov.provision_id, tokens)), headers: client });
    if (r.status !== 201) throw new Error(`answered ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  });
  return {
    did: acct.did,
    handle: acct.handle,
    repoHost: baseUrl,
    auth: happyviewSession(key, tokens.accessToken),
    keys: { signing: acct.signing, others: [{ id: '#atproto_kem', key: acct.kem }] },
  };
}

export const adapter: Adapter = {
  setupMode: (m) => ({ ...recordedMode(m, 'external'), bootstrap: m.bootstrap }),
  provisionAccount: (ctx, name) => signIn(ctx.baseUrl, ctx.plc, name),
  createSpace: (ctx, owner, spaceType, policy) => createSpace(ctx.manifest, ctx.baseUrl, owner, spaceType, policy),
};
