// atproto-pds setup hooks (ungraded). Accounts come from createAccount, and
// requests use the account's password session (Bearer), which 0016 doesn't
// name. The pinned image serves only the Oct 22
// com.atproto.simplespace.createSpace; --setup-mode picks.
//
// Quirk (manifest quirks.serial_account_creation): the server names signing
// keys sk-<millis>, so two accounts created in the same millisecond collide.
// Creation is serialized here, with a short pause between accounts.

import type { Account, Adapter } from '../../harness/adapter.ts';
import { createAccount, createSpace, recordedMode } from '../../harness/setup.ts';

let queue: Promise<unknown> = Promise.resolve();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const adapter: Adapter = {
  setupMode: (m) => recordedMode(m, 'create-account'),
  provisionAccount: (ctx, name) => {
    const next = queue.then(async (): Promise<Account> => {
      try {
        return await createAccount(ctx.baseUrl, name);
      } finally {
        await pause(5);
      }
    });
    queue = next.catch(() => undefined);
    return next;
  },
  createSpace: (ctx, owner, spaceType, policy) => createSpace(ctx.manifest, owner.repoHost, owner, spaceType, policy),
};
