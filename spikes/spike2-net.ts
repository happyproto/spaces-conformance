// HAP-408 spike 2: who can reach whom on the bridge network, over https,
// trusting Caddy's internal CA. Evidence is each step's response plus the
// Caddy access log (which records Host and the caller's address).
//
//   harness  -> everyone          (fetch, NODE_EXTRA_CA_CERTS)
//   HappyView -> harness          (session registration calls the user's PDS: harness.test)
//   pds.js   -> HappyView         (a native write into a HappyView space notifies its host)
//   ZDS      -> HappyView         (the same, from a Zig TLS client)

import { createServer } from 'node:http';
import { b64u, http, log, newP256, plcGenesis } from './lib.ts';
import { happyviewSession } from './spike1-auth.ts';

const seen: { method: string; url: string; host?: string; from?: string }[] = [];

// The harness's own server, fronted by Caddy as https://harness.test.
const harnessDid: { did?: string } = {};
const server = createServer((req, res) => {
  seen.push({ method: req.method!, url: req.url!, host: req.headers.host, from: String(req.headers['x-forwarded-for'] ?? '') });
  log('harness <-', `${req.method} ${req.url} host=${req.headers.host} xff=${req.headers['x-forwarded-for']} ua=${req.headers['user-agent']}`);
  res.setHeader('content-type', 'application/json');
  if (req.url?.startsWith('/xrpc/com.atproto.server.getSession')) {
    res.end(JSON.stringify({ did: harnessDid.did, handle: 'dave.test' }));
  } else if (req.url?.startsWith('/.well-known/oauth-protected-resource')) {
    res.end(JSON.stringify({ resource: 'https://harness.test', authorization_servers: ['https://harness.test'] }));
  } else {
    res.statusCode = 404;
    res.end('{"error":"NotFound"}');
  }
});
await new Promise<void>((r) => server.listen(8080, '::', r));
log('harness: listening on :8080 (https://harness.test via Caddy)');

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'} ${name}`, detail);
};

// 1. harness -> everything over https.
for (const u of ['https://happyview.test/health', 'https://zds.test/xrpc/_health', 'http://pdsjs-alice.test/xrpc/_health', 'https://harness.test/nothing']) {
  try {
    const r = await http(u);
    check(`harness -> ${u}`, r.status < 500, r.status);
  } catch (e) {
    check(`harness -> ${u}`, false, (e as any).cause?.code ?? String(e));
  }
}

// 2. HappyView -> harness. dave's DID document names https://harness.test as
// his PDS, so registering a session makes HappyView call getSession there.
harnessDid.did = await plcGenesis({ signing: newP256(), kem: newP256(), handle: 'dave.test', pdsUrl: 'https://harness.test' });
const client = { 'x-client-key': 'hvc_conformance', 'x-client-secret': 'hvs_conformance-spike-secret' };
const prov = await http('https://happyview.test/oauth/dpop-keys', { method: 'POST', headers: { ...client, 'content-type': 'application/json' }, body: '{}' });
const reg = await http('https://happyview.test/oauth/sessions', {
  method: 'POST',
  headers: { ...client, 'content-type': 'application/json' },
  body: JSON.stringify({ provision_id: prov.body.provision_id, did: harnessDid.did, access_token: b64u(newP256().secret), scopes: 'atproto' }),
});
// ZDS -> harness is checked after the ZDS steps below.
check('HappyView -> harness (getSession on https://harness.test)', seen.some((s) => s.url.includes('getSession')), {
  register: reg.status,
  body: reg.body,
});

// A HappyView space for the PDS-side writes, created by alice over DPoP.
const alice = await happyviewSession('alice', 'http://pdsjs-alice.test');
const created = await alice.xrpc('POST', 'com.atproto.space.createSpace', {
  spaceType: 'com.example.conformance.space',
  policy: { $type: 'com.atproto.memberspace.policy', publicRead: false },
});
const space = created.body.uri as string;
log('space', space);

// 3. pds.js -> HappyView: alice writes into the HappyView space at her own pds.js.
const aliceSess = await http('http://pdsjs-alice.test/xrpc/com.atproto.server.createSession', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ identifier: alice.did, password: 'password123' }),
});
const pw = await http('http://pdsjs-alice.test/xrpc/com.atproto.space.createRecord', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceSess.body.accessJwt}` },
  body: JSON.stringify({ space, repo: alice.did, collection: 'com.example.conformance.note', record: { $type: 'com.example.conformance.note', text: 'native write on pds.js' } }),
});
log('pds.js createRecord in HappyView space', { status: pw.status, body: pw.body });

// 4. ZDS -> HappyView: a ZDS account writes into the same space.
const handle = `z${Date.now().toString(36)}.test`;
const zAcct = await http('https://zds.test/xrpc/com.atproto.server.createAccount', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ handle, email: `${handle}@example.invalid`, password: 'password123' }),
});
log('zds createAccount', { status: zAcct.status, did: zAcct.body.did, err: zAcct.body.error, msg: zAcct.body.message });
if (zAcct.body.accessJwt) {
  const zw = await http('https://zds.test/xrpc/com.atproto.space.createRecord', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${zAcct.body.accessJwt}` },
    body: JSON.stringify({ space, repo: zAcct.body.did, collection: 'com.example.conformance.note', record: { $type: 'com.example.conformance.note', text: 'native write on zds' } }),
  });
  log('zds createRecord in HappyView space', { status: zw.status, body: zw.body });
  const zdoc = await http(`http://plc:2582/${zAcct.body.did}`);
  log('zds account DID doc services', zdoc.body.service);
  // ZDS -> harness: ZDS_PROXY_SERVICE_URL is https://harness.test, so an
  // appview method is proxied there by ZDS's own TLS client.
  const zp = await http('https://zds.test/xrpc/app.bsky.actor.getProfile?actor=' + zAcct.body.did, {
    headers: { authorization: `Bearer ${zAcct.body.accessJwt}` },
  });
  log('zds proxied getProfile', { status: zp.status, body: zp.body });
  const rc = await http('https://zds.test/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${zAcct.body.accessJwt}` },
    body: JSON.stringify({ repo: zAcct.body.did, collection: 'com.example.conformance.note', record: { $type: 'com.example.conformance.note', text: 'public write, may trigger a crawl request' } }),
  });
  log('zds public createRecord', { status: rc.status });
}

// Give asynchronous notifications a moment, then report.
await new Promise((r) => setTimeout(r, 3000));
log('harness saw', seen);
check('ZDS -> harness (proxy or crawl, Zig TLS)', seen.some((s) => s.url.includes('app.bsky') || s.url.includes('requestCrawl')));
server.close();
log(failures ? `${failures} check(s) failed` : 'harness-side checks passed; read the Caddy log for the PDS -> HappyView legs');
process.exit(failures ? 1 : 0);
