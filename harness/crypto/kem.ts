// The KEM shared secret (0016 #shared-secret): P-256 ECDH framed as RFC 9180
// DHKEM, with HKDF-SHA256 over the labels the spec lists.
//
// 2026-10-29 uses the DHKEM's shared_secret directly:
//
//   dh     = x-coordinate of ECDH(syncer, author)
//   keys   = 0x04||syncer.x||syncer.y || 0x04||author.x||author.y
//   prefix = "HPKE-v1" || "KEM" || uint16be(0x0010)
//   input  = prefix || "eae_prk" || dh
//   info   = uint16be(32) || prefix || "shared_secret" || keys
//   shared_secret = HKDF-SHA256(input, salt="", info, 32)

import { p256 } from '@noble/curves/nist.js';
import { expand, extract, hkdf } from '@noble/hashes/hkdf.js';
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

// 2026-11-12 on: HPKE base mode secret export (RFC 9180 section 6.2), with
// KEM 0x0010, KDF 0x0001 and the export-only AEAD 0xFFFF, info "atproto-mac"
// and an empty exporter context. The steps follow the spec's appendix
// ("Shared secret without HPKE"); the DHKEM step is the 2026-10-29 secret.

const HPKE_V1 = utf8('HPKE-v1');
const KEM_ID = concat(utf8('KEM'), u16be(0x0010));
const SUITE_ID = concat(utf8('HPKE'), u16be(0x0010), u16be(0x0001), u16be(0xffff));
const EMPTY = new Uint8Array(0);
export const MAC_INFO = 'atproto-mac';

const labeledExtract = (id: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  extract(sha256, concat(HPKE_V1, id, utf8(label), ikm), salt);
const labeledExpand = (id: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number) =>
  expand(sha256, prk, concat(u16be(length), HPKE_V1, id, utf8(label), info), length);

/** HPKE's export from the DHKEM shared secret: base mode, no PSK, `info`, an empty exporter context, 32 bytes. */
export function exportFromKemSecret(kemSecret: Uint8Array, info = MAC_INFO): Uint8Array {
  const pskIdHash = labeledExtract(SUITE_ID, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(SUITE_ID, EMPTY, 'info_hash', utf8(info));
  const context = concat(new Uint8Array([0x00]), pskIdHash, infoHash);
  const secret = labeledExtract(SUITE_ID, kemSecret, 'secret', EMPTY);
  const exporterSecret = labeledExpand(SUITE_ID, secret, 'exp', context, 32);
  return labeledExpand(SUITE_ID, exporterSecret, 'sec', EMPTY, 32);
}

/** The DHKEM step on its own: eae_prk, then shared_secret over enc || pkR. Equals deriveSharedSecret. */
export function kemSecret(dh: Uint8Array, enc: PublicKey, authorPub: PublicKey): Uint8Array {
  const eaePrk = labeledExtract(KEM_ID, EMPTY, 'eae_prk', dh);
  return labeledExpand(KEM_ID, eaePrk, 'shared_secret', concat(uncompressed(enc), uncompressed(authorPub)), 32);
}

/** The syncer side at 2026-11-12: SendExportBase with an ephemeral keypair as enc. */
export function syncerExportSecret(ephemeral: KeyPair, authorKem: PublicKey): Uint8Array {
  return exportFromKemSecret(kemSecret(ecdhX(ephemeral.secret, authorKem), ephemeral, authorKem));
}

/** The repo-host side at 2026-11-12: ReceiveExportBase with the author's KEM private key. */
export function hostExportSecret(authorKem: KeyPair, enc: PublicKey): Uint8Array {
  return exportFromKemSecret(kemSecret(ecdhX(authorKem.secret, enc), enc, authorKem));
}
