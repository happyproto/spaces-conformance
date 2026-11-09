// Commit and record MACs (0016 #commit-mac, #record-mac) and the
// Atproto-Space-Want-Mac / Atproto-Space-Mac headers (#authenticity-headers).

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, equalBytes, lenPrefixed, utf8 } from './bytes.ts';
import { didKey, type KeyPair, parseDidKey, type PublicKey } from './keys.ts';
import { parseDictionary, serializeDictionary } from './sf.ts';

export const REPO_TYPE = 'atproto-space-repo';
export const RECORD_TYPE = 'atproto-space-record';

export interface CommitFields {
  ver: number;
  space: string;
  repo: string;
  rev: string;
  data: Uint8Array;
}

/** context = "atproto-space-repo-v{ver}" || lp(space) || lp(repo) || lp(rev); mac = HMAC(ss, context || data) */
export function commitMac(sharedSecret: Uint8Array, c: CommitFields): Uint8Array {
  const context = concat(utf8(`${REPO_TYPE}-v${c.ver}`), lenPrefixed(c.space), lenPrefixed(c.repo), lenPrefixed(c.rev));
  return hmac(sha256, sharedSecret, concat(context, c.data));
}

/** context = "atproto-space-record-v1" || lp(uri); mac = HMAC(ss, context || cid_bytes) */
export function recordMac(sharedSecret: Uint8Array, uri: string, cidBytes: Uint8Array): Uint8Array {
  const context = concat(utf8(`${RECORD_TYPE}-v1`), lenPrefixed(uri));
  return hmac(sha256, sharedSecret, concat(context, cidBytes));
}

export const macEquals = (a: Uint8Array, b: Uint8Array): boolean => equalBytes(a, b);

/** The request header: type="…", ver=1, key_share="did:key:…" */
export function wantMacHeader(type: string, ver: number, keyShare: PublicKey): string {
  return serializeDictionary([
    ['type', type],
    ['ver', ver],
    ['key_share', didKey(keyShare)],
  ]);
}

export interface ParsedWantMac {
  type: string;
  ver: number;
  keyShare: PublicKey;
}

/** Parse a Want-Mac header as a host must. Any missing field or bad key is an error. */
export function parseWantMac(header: string): ParsedWantMac {
  const d = parseDictionary(header);
  const type = d.get('type');
  const ver = d.get('ver');
  const ks = d.get('key_share');
  if (typeof type !== 'string') throw new Error('Want-Mac: type must be a string');
  if (typeof ver !== 'number') throw new Error('Want-Mac: ver must be an integer');
  if (typeof ks !== 'string') throw new Error('Want-Mac: key_share must be a string');
  const keyShare = parseDidKey(ks);
  if (keyShare.curve !== 'p256') throw new Error('Want-Mac: key_share must be P-256');
  return { type, ver, keyShare };
}

export interface ParsedMac {
  type: string;
  ver: number;
  mac: Uint8Array;
}

/** Parse a response Atproto-Space-Mac header: type, ver and a 32-byte mac byte sequence. */
export function parseMacHeader(header: string): ParsedMac {
  const d = parseDictionary(header);
  const type = d.get('type');
  const ver = d.get('ver');
  const mac = d.get('mac');
  if (typeof type !== 'string') throw new Error('Atproto-Space-Mac: type must be a string');
  if (typeof ver !== 'number') throw new Error('Atproto-Space-Mac: ver must be an integer');
  if (!(mac instanceof Uint8Array) || mac.length !== 32) throw new Error('Atproto-Space-Mac: mac must be a 32-byte byte sequence');
  return { type, ver, mac };
}

export function macHeader(type: string, ver: number, mac: Uint8Array): string {
  return serializeDictionary([
    ['type', type],
    ['ver', ver],
    ['mac', mac],
  ]);
}

/** A fresh ephemeral key share for one request (never reused, per #shared-secret). */
export type KeyShare = KeyPair;
