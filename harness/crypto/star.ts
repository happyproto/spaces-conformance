// STAR-lite v1 (the format 0016 @701ef9c6be cites for #repo-serialization),
// and its atproto-space-repo profile.
//
//   [ magic 2A 6C 01 00 | varint len | DRISL meta ] [ varint len | key | varint len | value ]* EOF
//
// Reader rules: exact magic; canonical varints; meta is exactly one canonical
// DRISL map with a string $type that fills its length; EOF only at a pair
// boundary. Any violation rejects the whole archive.

import { compareBytes, concat, fromUtf8, readVarint, utf8, varint } from './bytes.ts';
import { decode, type DrislValue, encode } from './drisl.ts';
import { Cid, CODEC_DRISL } from './cid.ts';
import { LtHash } from './lthash.ts';

export const MAGIC = new Uint8Array([0x2a, 0x6c, 0x01, 0x00]);
const MAX_RECORD = 1024 * 1024;

export interface StarArchive {
  meta: Record<string, DrislValue>;
  pairs: { key: Uint8Array; value: Uint8Array }[];
}

export function readStar(b: Uint8Array): StarArchive {
  for (let i = 0; i < 4; i++) if (b[i] !== MAGIC[i]) throw new Error('STAR: bad magic');
  let off = 4;
  const take = (what: string): Uint8Array => {
    const v = readVarint(b, off);
    if (!v) throw new Error(`STAR: EOF before ${what} length`);
    if (v.next + v.value > b.length) throw new Error(`STAR: ${what} truncated`);
    off = v.next + v.value;
    return b.subarray(v.next, off);
  };
  const metaBytes = take('meta');
  const meta = decode(metaBytes);
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta) || meta instanceof Uint8Array)
    throw new Error('STAR: meta must be a map');
  if (typeof (meta as Record<string, unknown>).$type !== 'string') throw new Error('STAR: meta needs a string $type');
  const pairs: StarArchive['pairs'] = [];
  while (off < b.length) {
    const key = take('key');
    if (off >= b.length) throw new Error('STAR: EOF inside a pair');
    const value = take('value');
    pairs.push({ key, value });
  }
  return { meta: meta as Record<string, DrislValue>, pairs };
}

export function writeStar(meta: Record<string, DrislValue>, pairs: { key: Uint8Array; value: Uint8Array }[]): Uint8Array {
  const m = encode(meta);
  return concat(MAGIC, varint(m.length), m, ...pairs.flatMap((p) => [varint(p.key.length), p.key, varint(p.value.length), p.value]));
}

export interface SpaceRepoCheck {
  meta: { ver: number; repo: string; space: string; rev: string; data: Uint8Array };
  records: { collection: string; rkey: string; cid: string; bytes: Uint8Array }[];
  /** sha256 of the streamed set hash. */
  computed: Uint8Array;
}

/**
 * The atproto-space-repo profile on top of readStar: $type, the commit
 * fields, valid {collection}/{rkey} keys in strict byte order with no
 * duplicates, canonical DRISL record values up to 1 MiB. Returns the streamed
 * digest; the caller compares it with meta.data and checks the MAC.
 */
export function checkSpaceRepo(b: Uint8Array): SpaceRepoCheck {
  const { meta, pairs } = readStar(b);
  if (meta.$type !== 'atproto-space-repo') throw new Error(`STAR: $type ${String(meta.$type)} is not atproto-space-repo`);
  const { ver, repo, space, rev, data } = meta as Record<string, unknown>;
  if (ver !== 1) throw new Error('STAR: commit ver must be 1');
  if (typeof repo !== 'string' || typeof space !== 'string' || typeof rev !== 'string') throw new Error('STAR: repo, space, rev must be strings');
  if (!(data instanceof Uint8Array) || data.length !== 32) throw new Error('STAR: data must be 32 bytes');
  const h = new LtHash();
  const records: SpaceRepoCheck['records'] = [];
  let prev: Uint8Array | null = null;
  for (const { key, value } of pairs) {
    if (prev && compareBytes(prev, key) >= 0) throw new Error('STAR: keys out of order or duplicated');
    prev = key;
    const path = fromUtf8(key);
    const m = /^([a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)+)\/([A-Za-z0-9._:~-]{1,512})$/.exec(path);
    if (!m || m[2] === '.' || m[2] === '..') throw new Error(`STAR: ${path} isn't a record path`);
    if (value.length > MAX_RECORD) throw new Error(`STAR: ${path} is over 1 MiB`);
    const record = decode(value); // throws on non-canonical
    if (record === null || typeof record !== 'object' || Array.isArray(record) || record instanceof Uint8Array)
      throw new Error(`STAR: ${path} is not a record map`);
    // The value is the record's canonical DRISL bytes, so its CID hashes them directly.
    const cid = Cid.of(CODEC_DRISL, value).toString();
    h.add(LtHash.element(m[1], m[2], cid));
    records.push({ collection: m[1], rkey: m[2], cid, bytes: value });
  }
  return { meta: { ver, repo, space, rev, data }, records, computed: h.digest() };
}

export const pathKey = (collection: string, rkey: string): Uint8Array => utf8(`${collection}/${rkey}`);
