// Finding a space's host (#space-authority): a syncer knows only the space's
// URI, so the authority DID in it must lead to the host. This row grades
// that discovery once, as a fail when it breaks; the rows that only need the
// host pend instead (suites/sync.ts spaceHost).

import { assertion, fail, pending } from '../../harness/assert.ts';
import { Resolver } from '../../harness/actors/identity.ts';
import { serviceEndpoint } from '../../harness/actors/plc.ts';
import { authorityOf, SpaceSync } from '../../harness/actors/space-sync.ts';
import { ownerSpace, settled } from '../fixtures.ts';
import { publicSpace, short, transient } from '../sync.ts';

assertion('lifecycle.authority-names-space-host', async (ctx) => {
  const { owner } = await ownerSpace(ctx);
  const { space } = await publicSpace(ctx, owner);
  const did = authorityOf(space);
  let doc;
  try {
    doc = await new Resolver(ctx.plc).resolve(did);
  } catch (e) {
    return fail(`the space's authority ${did} doesn't resolve: ${(e as Error).message}`, { space });
  }
  const endpoint = serviceEndpoint(doc, 'atproto_pds');
  const evidence = { space, authority: did, services: JSON.stringify(doc.service ?? []).slice(0, 800) };
  if (!endpoint) fail(`the authority ${did}'s DID document names no #atproto_pds`, evidence);
  const sync = new SpaceSync(endpoint!, space, settled(ctx));
  const method = settled(ctx) ? 'authorizeSpaceSync' : 'getSpaceCredential';
  let r;
  try {
    r = await sync.authorize();
  } catch (e) {
    return fail(`the #atproto_pds endpoint ${endpoint} doesn't answer: ${(e as Error).message}`, { ...evidence, endpoint: endpoint! });
  }
  if (transient(r)) pending(`${method} at ${endpoint} answered ${short(r)}`);
  if (r.status !== 200 || !sync.credential) fail(`${method} at the authority's #atproto_pds (${endpoint}) answered ${short(r)}, for a space anyone may read`, { ...evidence, endpoint: endpoint! });
});
