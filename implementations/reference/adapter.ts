// Reference PDS setup hooks (ungraded). Accounts come from createAccount, and
// requests use the account's password session (Bearer), which 0016 doesn't
// name; the run records write_auth: password-session. Spaces come from the
// Oct 22 com.atproto.simplespace.createSpace the pinned image serves.

import { randomBytes } from '@noble/hashes/utils.js';
import type { Account, Adapter, Policy, StackCtx } from '../../harness/adapter.ts';
import { setup } from '../../harness/assert.ts';
import { hex } from '../../harness/crypto/bytes.ts';
import { http, json } from '../../harness/http.ts';

const PASSWORD = 'conformance-password';

function bearer(token: string): Account['auth'] {
  return {
    mode: 'password-session',
    request: (method, url, body) =>
      http(url, body === undefined ? { method, headers: { authorization: `Bearer ${token}` } } : { ...json(body), method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }),
  };
}

/** Oct 29 policy object to the Oct 22 simplespace triple. */
function simplespacePolicy(p: Policy) {
  if (p.$type !== 'com.atproto.memberspace.policy') throw new Error(`the pinned reference image can't express ${p.$type}`);
  return {
    readPolicy: { $type: p.publicRead ? 'com.atproto.simplespace.defs#publicPolicy' : 'com.atproto.simplespace.defs#memberListPolicy' },
    writePolicy: { $type: p.publicWrite ? 'com.atproto.simplespace.defs#publicPolicy' : 'com.atproto.simplespace.defs#memberListPolicy' },
    appAccess: { $type: 'com.atproto.simplespace.defs#open' },
  };
}

export const adapter: Adapter = {
  setupMode: { accounts: 'create-account', spaces: 'simplespace' },

  provisionAccount: (ctx: StackCtx, name: string) =>
    setup(`createAccount ${name}`, async () => {
      // Handles are capped per label, so keep the random part short.
      const handle = `${name}-${hex(randomBytes(4))}.test`;
      const r = await http(`${ctx.baseUrl}/xrpc/com.atproto.server.createAccount`, json({ handle, email: `${handle}@example.invalid`, password: PASSWORD }));
      if (r.status !== 200) throw new Error(`createAccount answered ${r.status}: ${JSON.stringify(r.body)}`);
      return { did: r.body.did, handle, repoHost: ctx.baseUrl, auth: bearer(r.body.accessJwt) };
    }),

  createSpace: (ctx, owner, spaceType, policy) =>
    setup('simplespace.createSpace', async () => {
      const r = await owner.auth.request('POST', `${ctx.baseUrl}/xrpc/com.atproto.simplespace.createSpace`, {
        spaceType,
        skey: hex(randomBytes(6)),
        ...simplespacePolicy(policy),
      });
      if (r.status !== 200 || typeof r.body?.uri !== 'string') throw new Error(`createSpace answered ${r.status}: ${JSON.stringify(r.body)}`);
      return r.body.uri;
    }),
};
