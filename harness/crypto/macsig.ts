// MACs from 2026-11-12 on (0016 #requesting-a-mac, #commit-mac, #record-mac):
// RFC 9421 HTTP Message Signatures with hmac-sha256, keyed by the HPKE
// export secret (kem.ts). The syncer asks with Accept-Signature; the host
// answers with the profile's covered header, Signature-Input, Signature and
// `Vary: Accept-Signature`. The covered header is a Structured Field
// Dictionary, signed with the `sf` flag, so its value is normalized
// (re-serialized) before it goes into the signature base.
//
// 2026-10-29's Want-Mac / Atproto-Space-Mac headers stay in mac.ts.

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { equalBytes, utf8 } from './bytes.ts';
import { didKey, type PublicKey } from './keys.ts';
import type { CommitFields } from './mac.ts';
import { isInnerList, parseDictionary, serializeDictionary, serializeInnerList, type SfDictionary, type SfInnerList, type SfParams } from './sf.ts';

export const COMMIT_PROFILE = 'atproto-space-commit';
export const RECORD_PROFILE = 'atproto-space-record';
export type MacProfile = typeof COMMIT_PROFILE | typeof RECORD_PROFILE;
export const MAC_ALG = 'hmac-sha256';

/** Each profile covers exactly one header, named like its tag. */
export const coveredHeader = (profile: MacProfile): string => profile;

/** The request's inner list: ("<header>";sf);keyid="did:key:…";tag="<profile>", plus alg if asked. */
export function macRequestList(profile: MacProfile, keyShare: PublicKey | string, alg?: string): SfInnerList {
  const params: SfParams = [
    ['keyid', typeof keyShare === 'string' ? keyShare : didKey(keyShare)],
    ['tag', profile],
  ];
  if (alg !== undefined) params.push(['alg', alg]);
  return { inner: [coveredHeader(profile)], itemParams: [[['sf', true]]], params };
}

/** `Accept-Signature: <label>=("<header>";sf);keyid="did:key:…";tag="<profile>"` */
export function acceptSignature(profile: MacProfile, keyShare: PublicKey | string, o: { label?: string; alg?: string } = {}): string {
  return serializeDictionary([[o.label ?? 'mac', macRequestList(profile, keyShare, o.alg)]]);
}

/** `Atproto-Space-Commit: ver=1, repo="…", space="…", rev="…", data=:…:` */
export function commitHeader(c: CommitFields): string {
  return serializeDictionary([
    ['ver', c.ver],
    ['repo', c.repo],
    ['space', c.space],
    ['rev', c.rev],
    ['data', c.data],
  ]);
}

/** `Atproto-Space-Record: uri="…", cid="…"` */
export function recordHeader(uri: string, cid: string): string {
  return serializeDictionary([
    ['uri', uri],
    ['cid', cid],
  ]);
}

/** The `sf` normalization: parse the dictionary and serialize it again. */
export const normalize = (value: string): string => {
  const d = parseDictionary(value);
  return serializeDictionary([...d.entries()]);
};

/** The RFC 9421 signature base over the profile's one covered header. */
export function macSignatureBase(profile: MacProfile, covered: string, list: SfInnerList): string {
  return `"${coveredHeader(profile)}";sf: ${normalize(covered)}\n"@signature-params": ${serializeInnerList(list)}`;
}

export const computeMac = (sharedSecret: Uint8Array, base: string): Uint8Array => hmac(sha256, sharedSecret, utf8(base));

/**
 * What a host answers: the covered header, and Signature-Input and Signature
 * under the requested label and parameters. Used to build vectors and the
 * suite's own negatives; the suite never acts as a host toward an implementation.
 */
export function macResponseHeaders(profile: MacProfile, covered: string, request: { label: string; list: SfInnerList }, sharedSecret: Uint8Array): Record<string, string> {
  const mac = computeMac(sharedSecret, macSignatureBase(profile, covered, request.list));
  return {
    [coveredHeader(profile)]: covered,
    'signature-input': serializeDictionary([[request.label, request.list]]),
    signature: serializeDictionary([[request.label, mac]]),
    vary: 'Accept-Signature',
  };
}

export interface VerifiedMac {
  label: string;
  /** The covered header, parsed. */
  fields: SfDictionary;
}

/**
 * Check a MAC response as a syncer must (#requesting-a-mac): exactly one
 * signature with the profile's tag, covering exactly the profile's header
 * with `sf`, alg absent or hmac-sha256, keyid (if present) the requested
 * key, and an HMAC that matches. Returns the parsed covered header, or why it
 * fails. The caller then matches the fields against the body and request.
 */
export function verifyMacResponse(
  profile: MacProfile,
  headers: Record<string, string | undefined>,
  sharedSecret: Uint8Array,
  requestedKeyid: string,
): VerifiedMac | string {
  const covered = headers[coveredHeader(profile)];
  if (covered === undefined) return `no ${coveredHeader(profile)} header`;
  if (!headers['signature-input'] || !headers.signature) return 'no Signature-Input or Signature';
  let inputs: SfDictionary, sigs: SfDictionary, fields: SfDictionary;
  try {
    inputs = parseDictionary(headers['signature-input']);
    sigs = parseDictionary(headers.signature);
    fields = parseDictionary(covered);
  } catch (e) {
    return `malformed header: ${(e as Error).message}`;
  }
  const tagged = [...inputs].filter(([, v]) => isInnerList(v) && v.params.some(([k, p]) => k === 'tag' && p === profile));
  if (tagged.length !== 1) return `${tagged.length} signatures with tag "${profile}", not exactly one`;
  const [label, list] = tagged[0] as [string, SfInnerList];
  const item = list.itemParams?.[0] ?? [];
  if (list.inner.length !== 1 || list.inner[0] !== coveredHeader(profile) || item.length !== 1 || item[0][0] !== 'sf' || item[0][1] !== true)
    return `the signature covers ${serializeInnerList({ ...list, params: [] })}, not ("${coveredHeader(profile)}";sf)`;
  const param = (k: string) => list.params.find(([n]) => n === k)?.[1];
  const alg = param('alg');
  if (alg !== undefined && alg !== MAC_ALG) return `alg is ${String(alg)}, not ${MAC_ALG}`;
  const keyid = param('keyid');
  if (keyid !== undefined && keyid !== requestedKeyid) return 'keyid is not the requested key';
  const mac = sigs.get(label);
  if (!(mac instanceof Uint8Array) || mac.length !== 32) return `Signature has no 32-byte ${label}`;
  if (!equalBytes(mac, computeMac(sharedSecret, macSignatureBase(profile, covered, list)))) return 'the MAC does not match';
  return { label, fields };
}

/** The commit a verified Atproto-Space-Commit header describes, or why it isn't one. */
export function commitFromFields(d: SfDictionary): CommitFields | string {
  const ver = d.get('ver');
  const repo = d.get('repo');
  const space = d.get('space');
  const rev = d.get('rev');
  const data = d.get('data');
  if (typeof ver !== 'number' || typeof repo !== 'string' || typeof space !== 'string' || typeof rev !== 'string' || !(data instanceof Uint8Array))
    return 'Atproto-Space-Commit needs ver (integer), repo, space, rev (strings) and data (bytes)';
  return { ver, repo, space, rev, data };
}

/** The record a verified Atproto-Space-Record header describes, or why it isn't one. */
export function recordFromFields(d: SfDictionary): { uri: string; cid: string } | string {
  const uri = d.get('uri');
  const cid = d.get('cid');
  if (typeof uri !== 'string' || typeof cid !== 'string') return 'Atproto-Space-Record needs uri and cid (strings)';
  return { uri, cid };
}
