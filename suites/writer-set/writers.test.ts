// The writer set and write notifications (#write-notifications,
// #the-sync-boundary-writer-set). Every row here needs the harness to hold a
// space credential (listWriters, registration), to be a registered syncer, or
// to act as a foreign authority, which is the phase 7 credential path. Each
// row pends until then, so it's reported rather than missing.

import { assertion, pending } from '../../harness/assert.ts';
import { PHASE7_PENDING } from '../fixtures.ts';

// Spelled out one per row: coverage reads the declared ids from the source.
assertion('writers.notify-write-sent', async () => pending(PHASE7_PENDING));
assertion('writers.notify-write-forwarded', async () => pending(PHASE7_PENDING));
assertion('writers.register-expiry', async () => pending(PHASE7_PENDING));
assertion('writers.list-repos', async () => pending(PHASE7_PENDING));
assertion('writers.list-repos-since-space-rev', async () => pending(PHASE7_PENDING));
assertion('writers.remove-writer', async () => pending(PHASE7_PENDING));
assertion('writers.removed-writer-retracked', async () => pending(PHASE7_PENDING));
