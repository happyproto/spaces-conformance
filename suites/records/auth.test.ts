import { assertion, fail } from '../../harness/assert.ts';
import { http } from '../../harness/http.ts';
import { ownerSpace, xrpcUrl } from '../fixtures.ts';

const READS = ['com.atproto.space.listRecords', 'com.atproto.space.getLatestCommit', 'com.atproto.space.listRepoOps'];
assertion('records.read-requires-auth', async (ctx) => {
  const { owner, space } = await ownerSpace(ctx);
  for (const nsid of READS) {
    const r = await http(xrpcUrl(owner.repoHost, nsid, { space, repo: owner.did }));
    if (r.status < 400 || r.status >= 500) fail(`${nsid} with no auth answered ${r.status}, not a refusal`, { request: `GET ${nsid}`, status: r.status, body: JSON.stringify(r.body).slice(0, 500) });
  }
});

assertion('info.read-auth-status', async (ctx) => {
  const { owner, space } = await ownerSpace(ctx);
  const r = await http(xrpcUrl(owner.repoHost, 'com.atproto.space.listRecords', { space, repo: owner.did }));
  // Informational: recorded, never scored.
  return `listRecords with no auth answered ${r.status}`;
});

assertion('info.unknown-method-status', async (ctx) => {
  const r = await http(xrpcUrl(ctx.baseUrl, 'com.atproto.space.thisMethodDoesNotExist'));
  return `an unknown method answered ${r.status}`;
});
