// Runs inside the harness container against a live stack (base + pdsjs +
// happyview fragments), with HappyView's seed.sql applied:
//
//   bun run stack:test
//
// Skipped unless CONFORMANCE_STACK=1, so the unit run never needs containers.

import { describe, expect, it } from 'vitest';
import { Plc } from '../../harness/actors/plc.ts';
import { generate } from '../../harness/crypto/keys.ts';
import { http, json } from '../../harness/http.ts';
import { authorize, loopbackClientId } from '../../harness/oauth/client.ts';
import { dpopRequest, keyFromJwk } from '../../harness/oauth/dpop.ts';
import { sessionRegistration } from '../../harness/oauth/registration.ts';
import { consent, provisionAccount } from '../../implementations/pdsjs/adapter.ts';

const live = process.env.CONFORMANCE_STACK === '1';
const plc = new Plc('http://plc:2582');
const SPACE_TYPE = 'com.example.conformance.space';
const scope = `atproto space:${SPACE_TYPE}?authority=*&manage=create&manage=update&manage=delete&collection=*`;

describe.skipIf(!live)('OAuth against the live stack', () => {
  it('gets a DPoP token from pds.js with headless consent and uses it at pds.js', async () => {
    const acct = await provisionAccount(plc, 'http://pdsjs-bob.test', 'bob.test');
    const key = generate('p256');
    const t = await authorize({ issuer: acct.pdsUrl, clientId: loopbackClientId(scope), scope, loginHint: acct.did, dpopKey: key, consent: consent(acct) });
    expect(t.sub).toBe(acct.did);
    expect(t.scope.split(' ')).toContain('atproto');
    const me = await dpopRequest(key, 'GET', `${acct.pdsUrl}/xrpc/com.atproto.server.getSession`, { accessToken: t.accessToken });
    expect(me.status).toBe(200);
    expect(me.body.did).toBe(acct.did);
  });

  it('registers the granted session with HappyView and writes a space over DPoP', async () => {
    const acct = await provisionAccount(plc, 'http://pdsjs-alice.test', 'alice.test');
    const client = { 'x-client-key': 'hvc_conformance', 'x-client-secret': process.env.HV_CLIENT_SECRET ?? 'hvs_conformance-secret' };
    const prov = await http('https://happyview.test/oauth/dpop-keys', { ...json({}), headers: { ...client, 'content-type': 'application/json' } });
    expect(prov.status).toBe(201);
    const key = keyFromJwk(prov.body.dpop_key);
    const t = await authorize({ issuer: acct.pdsUrl, clientId: loopbackClientId(scope), scope, loginHint: acct.did, dpopKey: key, consent: consent(acct) });
    const reg = await http('https://happyview.test/oauth/sessions', {
      ...json(sessionRegistration(prov.body.provision_id, t)),
      headers: { ...client, 'content-type': 'application/json' },
    });
    expect(reg.status).toBe(201);
    expect(reg.body.scopes.join(' ')).toBe(t.scope);
    const created = await dpopRequest(key, 'POST', 'https://happyview.test/xrpc/com.atproto.space.createSpace', {
      accessToken: t.accessToken,
      headers: { 'x-client-key': 'hvc_conformance', 'content-type': 'application/json' },
      body: JSON.stringify({ spaceType: SPACE_TYPE, policy: { $type: 'com.atproto.memberspace.policy', publicRead: false } }),
    });
    expect(created.status).toBe(200);
    expect(created.body.uri).toMatch(new RegExp(`^at://did:plc:[a-z2-7]{24}/space/${SPACE_TYPE.replace(/\./g, '\\.')}/`));
  });
});
