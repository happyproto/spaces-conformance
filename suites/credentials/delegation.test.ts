// Delegation tokens (#delegation-token). The harness made the account's
// identity, so it holds the signing key and mints each token itself; the
// space host is asked for a credential with it (getSpaceCredential on Oct 29,
// authorizeSpaceSync from Nov 12, both with a fresh P-256 credential key).

import { assertion, fail, pending, setup } from '../../harness/assert.ts';
import { ownerSpace, settled } from '../fixtures.ts';
import { delegationToken, requestCredential } from './delegation-token.ts';

assertion('cred.delegation-token-kid-enforced', async (ctx) => {
  const { owner, space } = await ownerSpace(ctx);
  if (!owner.keys) pending("the harness doesn't hold this account's signing key");
  const { signing, others } = owner.keys!;
  const other = others[0];
  if (!other) pending('the account lists no second key to sign with');
  // Control: the same request with a well-formed token. If the host refuses
  // that too, its refusals below say nothing about kid, so the row can't be
  // judged (a host that refuses every token would pass vacuously).
  const control = await setup('a credential for a well-formed delegation token', () => requestCredential(ctx, owner, space, delegationToken(owner, space, signing)));
  if (control.status !== 200 || typeof control.body?.credential !== 'string')
    pending(`the host refused a well-formed delegation token too (${control.status} ${JSON.stringify(control.body).slice(0, 200)}), so kid enforcement can't be told apart`);
  const negatives: [string, string][] = [
    ['no kid', delegationToken(owner, space, signing, {})],
    ['kid "atproto"', delegationToken(owner, space, signing, { kid: 'atproto' })],
    ['kid "#atproto_label"', delegationToken(owner, space, signing, { kid: '#atproto_label' })],
    [`kid "${owner.did}#atproto"`, delegationToken(owner, space, signing, { kid: `${owner.did}#atproto` })],
    [`kid "#atproto", signed by the ${other.id} key`, delegationToken(owner, space, other.key)],
  ];
  const granted: string[] = [];
  const unanswered: string[] = [];
  const wrongError: string[] = [];
  const answers: Record<string, string> = {};
  for (const [name, token] of negatives) {
    const r = await requestCredential(ctx, owner, space, token);
    answers[name] = `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
    if (r.status < 300) granted.push(name);
    // A rate limit or a server error isn't a refusal of the token.
    else if (r.status === 429 || r.status >= 500) unanswered.push(name);
    // From Nov 12 the lexicon names the error for a bad token.
    else if (settled(ctx) && r.body?.error !== 'InvalidDelegationToken') wrongError.push(name);
  }
  if (granted.length) fail(`a credential was granted for a delegation token with ${granted.join('; ')}`, { answers: JSON.stringify(answers) });
  if (unanswered.length)
    pending(`the host answered 429 or 5xx for ${unanswered.join('; ')}, so those tokens weren't judged (${JSON.stringify(answers).slice(0, 400)})`);
  // Control again: if a well-formed token is now refused too, the refusals
  // above may be the host's state (a limit, a revocation), not kid.
  const after = await setup('a credential for a well-formed delegation token, after the negatives', () =>
    requestCredential(ctx, owner, space, delegationToken(owner, space, signing)),
  );
  if (after.status !== 200 || typeof after.body?.credential !== 'string')
    pending(`after the negatives the host refused a well-formed delegation token too (${after.status} ${JSON.stringify(after.body).slice(0, 200)}), so its refusals can't be told apart from kid enforcement`);
  if (wrongError.length)
    fail(`a delegation token with ${wrongError.join('; ')} was refused without error InvalidDelegationToken`, { answers: JSON.stringify(answers) });
});
