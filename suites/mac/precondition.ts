// What the MAC rows need before they can judge a host, shared so it can be
// unit tested. Missing either is `skip` ("pending: ..."), never a fail:
//   - the author's #atproto_kem key, without which no MAC can be requested.
//     Its absence is graded once, by mac.kem-key-published;
//   - a MAC on the response (Atproto-Space-Mac, or from 2026-11-12 any of
//     the covered header, Signature-Input or Signature). 0016 requires it only on
//     space-credential reads, and the harness has no credential path yet.

import type { MacCheck, Target } from '../../harness/actors/syncer.ts';
import { pending } from '../../harness/assert.ts';
import type { PublicKey } from '../../harness/crypto/keys.ts';

export const NO_KEM = 'no #atproto_kem key to request a MAC with (graded by mac.kem-key-published)';
export const CREDENTIAL_PENDING = 'MAC only required on credential reads; credential path in phase 7';

export function requireAuthorKem(target: Target): PublicKey {
  return target.authorKem ?? pending(NO_KEM);
}

export function requireMacHeader(mac: MacCheck): string {
  return mac.header ?? pending(CREDENTIAL_PENDING);
}

/** From 2026-11-12 a MAC is three headers; any of them answered counts as a MAC, so its gaps are graded. */
export function requireMac(mac: MacCheck): void {
  if (!mac.present) pending(CREDENTIAL_PENDING);
}
