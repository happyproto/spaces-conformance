// The KEM shared secret (0016 #shared-secret): P-256 ECDH framed as RFC 9180
// DHKEM, with HKDF-SHA256 over the labels the spec lists.
//
//   dh     = x-coordinate of ECDH(syncer, author)
//   keys   = 0x04||syncer.x||syncer.y || 0x04||author.x||author.y
//   prefix = "HPKE-v1" || "KEM" || uint16be(0x0010)
//   input  = prefix || "eae_prk" || dh
//   info   = uint16be(32) || prefix || "shared_secret" || keys
//   shared_secret = HKDF-SHA256(input, salt="", info, 32)

import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, u16be, utf8 } from './bytes.ts';
import { type KeyPair, type PublicKey, uncompressed } from './keys.ts';

const PREFIX = concat(utf8('HPKE-v1'), utf8('KEM'), u16be(0x0010));

/** The 32-byte x-coordinate of the ECDH shared point. */
export function ecdhX(secret: Uint8Array, pub: PublicKey): Uint8Array {
  if (pub.curve !== 'p256') throw new Error('KEM keys are P-256');
  return p256.getSharedSecret(secret, pub.compressed, true).slice(1);
}

export function deriveSharedSecret(dh: Uint8Array, syncerPub: PublicKey, authorPub: PublicKey): Uint8Array {
  const keys = concat(uncompressed(syncerPub), uncompressed(authorPub));
  const input = concat(PREFIX, utf8('eae_prk'), dh);
  const info = concat(u16be(32), PREFIX, utf8('shared_secret'), keys);
  return hkdf(sha256, input, new Uint8Array(0), info, 32);
}

/** The syncer side: an ephemeral keypair against the author's #atproto_kem key. */
export function syncerSharedSecret(ephemeral: KeyPair, authorKem: PublicKey): Uint8Array {
  return deriveSharedSecret(ecdhX(ephemeral.secret, authorKem), ephemeral, authorKem);
}

/** The repo-host side: the author's KEM private key against the syncer's key_share. */
export function hostSharedSecret(authorKem: KeyPair, syncerPub: PublicKey): Uint8Array {
  return deriveSharedSecret(ecdhX(authorKem.secret, syncerPub), syncerPub, authorKem);
}
