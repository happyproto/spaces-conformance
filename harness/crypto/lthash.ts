// The commit digest's set hash (0016 #commit-digest): LtHash over 1024
// little-endian uint16 lanes, each element expanded to 2048 bytes with BLAKE3
// XOF, added or subtracted lane-wise mod 2^16. data = sha256(state).

import { blake3 } from '@noble/hashes/blake3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8 } from './bytes.ts';

const STATE_BYTES = 2048;
const LANES = STATE_BYTES / 2;

export class LtHash {
  /** 1024 lanes; Uint16Array arithmetic wraps mod 2^16 for us. */
  private lanes = new Uint16Array(LANES);

  static element(collection: string, rkey: string, cid: string): Uint8Array {
    return utf8(`${collection}/${rkey}/${cid}`);
  }

  private expand(element: Uint8Array): Uint16Array {
    const xof = blake3(element, { dkLen: STATE_BYTES });
    const view = new DataView(xof.buffer, xof.byteOffset, xof.byteLength);
    const out = new Uint16Array(LANES);
    for (let i = 0; i < LANES; i++) out[i] = view.getUint16(i * 2, true);
    return out;
  }

  add(element: Uint8Array): this {
    const e = this.expand(element);
    for (let i = 0; i < LANES; i++) this.lanes[i] += e[i];
    return this;
  }

  remove(element: Uint8Array): this {
    const e = this.expand(element);
    for (let i = 0; i < LANES; i++) this.lanes[i] -= e[i];
    return this;
  }

  /** The 2048-byte state, lanes little-endian. */
  state(): Uint8Array {
    const out = new Uint8Array(STATE_BYTES);
    const view = new DataView(out.buffer);
    for (let i = 0; i < LANES; i++) view.setUint16(i * 2, this.lanes[i], true);
    return out;
  }

  /** The commit's `data`: sha256(state). */
  digest(): Uint8Array {
    return sha256(this.state());
  }

  static ofRecords(records: Iterable<{ collection: string; rkey: string; cid: string }>): LtHash {
    const h = new LtHash();
    for (const r of records) h.add(LtHash.element(r.collection, r.rkey, r.cid));
    return h;
  }
}

/** The spec's constant: the empty repo's data. */
export const EMPTY_DIGEST_HEX = 'e5a00aa9991ac8a5ee3109844d84a55583bd20572ad3ffcd42792f3c36b183ad';
