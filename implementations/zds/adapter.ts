// ZDS setup hooks (ungraded). Accounts come from createAccount with a .test
// handle (ZDS caps a label at 18 characters), and requests use the account's
// password session (Bearer), which 0016 doesn't name. The pinned image serves
// only the Oct 22 com.atproto.simplespace.createSpace; --setup-mode picks.

import type { Adapter } from '../../harness/adapter.ts';
import { createAccount, createSpace, recordedMode } from '../../harness/setup.ts';

export const adapter: Adapter = {
  setupMode: (m) => recordedMode(m, 'create-account'),
  provisionAccount: (ctx, name) => createAccount(ctx.baseUrl, name),
  createSpace: (ctx, owner, spaceType, policy) => createSpace(ctx.manifest, owner.repoHost, owner, spaceType, policy),
};
