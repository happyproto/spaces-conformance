// DASL CIDs: CIDv1, SHA-256, codec DRISL (0x71) or raw (0x55), rendered as
// multibase base32 lower ("b..."). https://dasl.ing/cid.html

import { sha256 } from '@noble/hashes/sha2.js';
import { base32, concat, equalBytes, fromBase32Lower } from './bytes.ts';

export const CODEC_DRISL = 0x71;
export const CODEC_RAW = 0x55;
const SHA256 = 0x12;

export class Cid {
  readonly codec: number;
  readonly digest: Uint8Array;

  constructor(codec: number, digest: Uint8Array) {
    if (codec !== CODEC_DRISL && codec !== CODEC_RAW) throw new Error(`unsupported CID codec 0x${codec.toString(16)}`);
    if (digest.length !== 32) throw new Error('a SHA-256 digest is 32 bytes');
    this.codec = codec;
    this.digest = digest;
  }

  static of(codec: number, data: Uint8Array): Cid {
    return new Cid(codec, sha256(data));
  }

  /** Binary form: version, codec, hash code, hash length, digest (all single-byte varints here). */
  get bytes(): Uint8Array {
    return concat(new Uint8Array([0x01, this.codec, SHA256, 32]), this.digest);
  }

  static fromBytes(b: Uint8Array): Cid {
    if (b.length !== 36 || b[0] !== 0x01 || b[2] !== SHA256 || b[3] !== 32) throw new Error('not a DASL CID');
    return new Cid(b[1], b.slice(4));
  }

  toString(): string {
    return `b${base32(this.bytes)}`;
  }

  static parse(s: string): Cid {
    if (!s.startsWith('b')) throw new Error(`CID ${s} isn't base32 multibase`);
    return Cid.fromBytes(fromBase32Lower(s.slice(1)));
  }

  equals(o: Cid): boolean {
    return this.codec === o.codec && equalBytes(this.digest, o.digest);
  }

  toJSON() {
    return { $link: this.toString() };
  }
}
