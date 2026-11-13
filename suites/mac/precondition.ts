// What the MAC rows need before they can judge a host, shared so it can be
// unit tested. Missing either is `skip` ("pending: ..."), never a fail:
//   - the author's #atproto_kem key, without which no MAC can be requested.
//     Its absence is graded once, by mac.kem-key-published;
//   - a MAC on the response (Atproto-Space-Mac, or from 2026-11-12 any of
//     the covered header, Signature-Input or Signature). 0016 requires it on
//     space-credential reads. On a credential read its absence is a fail; on
//     a session read (the fallback when the harness can't get a credential)
//     it's pending, since 0016 doesn't require it there.

import type { MacCheck, Target } from '../../harness/actors/syncer.ts';
import { fail, pending } from '../../harness/assert.ts';
import type { PublicKey } from '../../harness/crypto/keys.ts';

export const NO_KEM = 'no #atproto_kem key to request a MAC with (graded by mac.kem-key-published)';
export const CREDENTIAL_PENDING = "MAC only required on credential reads, and the harness read with a session: it couldn't get a space credential";
export const NO_MAC_ON_CREDENTIAL = 'a read with a space credential and a MAC request came back with no MAC';

export function requireAuthorKem(target: Target): PublicKey {
  return target.authorKem ?? pending(NO_KEM);
}

/** The MAC header: on a credential read its absence fails, on a session read it pends. */
export function requireMacHeader(mac: MacCheck, credential = false, evidence?: Record<string, unknown>): string {
  if (mac.header) return mac.header;
  return credential ? fail(NO_MAC_ON_CREDENTIAL, evidence) : pending(CREDENTIAL_PENDING);
}

/** From 2026-11-12 a MAC is three headers; any of them answered counts as a MAC, so its gaps are graded. */
export function requireMac(mac: MacCheck, credential = false, evidence?: Record<string, unknown>): void {
  if (mac.present) return;
  if (credential) fail(NO_MAC_ON_CREDENTIAL, evidence);
  pending(CREDENTIAL_PENDING);
}
