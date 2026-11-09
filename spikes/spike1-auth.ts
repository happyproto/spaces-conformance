// HAP-408 spike 1: a real OAuth/DPoP session on HappyView through pds.js
// headless consent, then createSpace and space writes over DPoP.
//
// Prereq: the stack is up and spikes/stack/seed.sql has run (spike1.sh does both).
// Exit code 0 means every step worked; each step logs what it saw.

import { dpopFetch, http, keyFromJwk, log, pdsjsAccount, pdsjsOAuth, pkce } from './lib.ts';

const HV = 'https://happyview.test';
const CLIENT_KEY = 'hvc_conformance';
const CLIENT_SECRET = process.env.HV_CLIENT_SECRET ?? 'hvs_conformance-spike-secret';
export const SPACE_TYPE = 'com.example.conformance.space';
const COLLECTION = 'com.example.conformance.note';
const PASSWORD = 'password123';
const REDIRECT = 'http://127.0.0.1/callback';

export const scopeFor = (spaceType = SPACE_TYPE) =>
  `atproto space:${spaceType}?authority=*&manage=create&manage=update&manage=delete&collection=*`;

export const clientIdFor = (scope: string) =>
  `http://localhost?${new URLSearchParams({ redirect_uri: REDIRECT, scope })}`;

/** One user's HappyView session: provision a key, OAuth at their PDS, register. */
export async function happyviewSession(who: string, pdsUrl: string, scope = scopeFor()) {
  const account = await pdsjsAccount(pdsUrl, `${who}.test`, PASSWORD);
  log(`${who}: account`, account);

  const client = { 'x-client-key': CLIENT_KEY, 'x-client-secret': CLIENT_SECRET };
  const prov = await http(`${HV}/oauth/dpop-keys`, {
    method: 'POST',
    headers: { ...client, 'content-type': 'application/json' },
    body: '{}',
  });
  if (prov.status !== 201) throw new Error(`dpop-keys ${prov.status}: ${JSON.stringify(prov.body)}`);
  log(`${who}: HappyView provisioned DPoP key`, { provision_id: prov.body.provision_id, confidential: prov.body.confidential });
  const dpopKey = keyFromJwk(prov.body.dpop_key);

  const tok = await pdsjsOAuth({
    issuer: pdsUrl,
    clientId: clientIdFor(scope),
    redirectUri: REDIRECT,
    scope,
    loginHint: account.did,
    password: PASSWORD,
    dpopKey,
    pkce: pkce(),
  });

  const reg = await http(`${HV}/oauth/sessions`, {
    method: 'POST',
    headers: { ...client, 'content-type': 'application/json' },
    body: JSON.stringify({
      provision_id: prov.body.provision_id,
      did: account.did,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : undefined,
      scopes: tok.scope,
      issuer: tok.issuer,
    }),
  });
  if (reg.status !== 201) throw new Error(`register session ${reg.status}: ${JSON.stringify(reg.body)}`);
  log(`${who}: HappyView session registered`, reg.body);

  /** Call a HappyView XRPC method as this user. */
  const xrpc = async (method: 'GET' | 'POST', nsid: string, arg?: Record<string, unknown>) => {
    let url = `${HV}/xrpc/${nsid}`;
    if (method === 'GET' && arg) url += `?${new URLSearchParams(arg as Record<string, string>)}`;
    return dpopFetch(dpopKey, method, url, {
      token: tok.access_token,
      headers: { 'x-client-key': CLIENT_KEY, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: method === 'POST' ? JSON.stringify(arg ?? {}) : undefined,
    });
  };
  return { did: account.did, xrpc, token: tok };
}

async function main() {
  const alice = await happyviewSession('alice', 'http://pdsjs-alice.test');

  const created = await alice.xrpc('POST', 'com.atproto.space.createSpace', {
    spaceType: SPACE_TYPE,
    policy: { $type: 'com.atproto.memberspace.policy', publicRead: false },
  });
  log('alice: createSpace', { status: created.status, body: created.body });
  if (created.status !== 200) process.exitCode = 1;
  const space = created.body?.uri as string | undefined;

  if (space) {
    const got = await alice.xrpc('GET', 'com.atproto.space.getSpace', { space });
    log('alice: getSpace', { status: got.status, body: got.body });

    // alice is spaces-on: HappyView forwards her write to her own PDS.
    const w = await alice.xrpc('POST', 'com.atproto.space.createRecord', {
      space,
      repo: alice.did,
      collection: COLLECTION,
      record: { $type: COLLECTION, text: 'hello from alice', createdAt: new Date().toISOString() },
    });
    log('alice: createRecord (native author)', { status: w.status, body: w.body });
    if (w.status >= 300) process.exitCode = 1;
  }

  // carol is spaces-off: HappyView hosts her space repo (polyfill).
  try {
    // A spaces-off pds.js refuses any space: scope at PAR, so carol can only
    // ask for `atproto`. The HappyView client must allow that scope too.
    const carol = await happyviewSession('carol', 'http://pdsjs-carol.test', process.env.CAROL_SCOPE ?? 'atproto');
    log('carol: session ok', { did: carol.did });
    if (space) {
      const put = await alice.xrpc('POST', 'com.atproto.memberspace.putMember', { space, did: carol.did, access: 'write' });
      log('alice: memberspace.putMember carol', { status: put.status, body: put.body });
      const putOld = await alice.xrpc('POST', 'com.atproto.simplespace.putMember', { space, did: carol.did, read: true, write: true });
      log('alice: simplespace.putMember carol', { status: putOld.status, body: putOld.body });
      const w = await carol.xrpc('POST', 'com.atproto.space.createRecord', {
        space,
        repo: carol.did,
        collection: COLLECTION,
        record: { $type: COLLECTION, text: 'hello from carol', createdAt: new Date().toISOString() },
      });
      log('carol: createRecord (polyfill author)', { status: w.status, body: w.body });
      if (w.status >= 300) process.exitCode = 1;
    }
  } catch (e) {
    log('carol: FAILED', (e as Error).message);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    log('FAILED', e.stack ?? String(e));
    process.exit(1);
  });
}
