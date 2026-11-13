// Credential revocation (#credential-expiration-and-revocation). The authority
// sends notifyCredentialsRevoked to repo hosts, so grading it needs the
// harness to act as a foreign authority with service auth: phase 7.

import { assertion, pending } from '../../harness/assert.ts';
import { PHASE7_PENDING } from '../fixtures.ts';

assertion('cred.revocation-idempotent', async () => pending(PHASE7_PENDING));
