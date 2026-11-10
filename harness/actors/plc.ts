// The PLC actor: mint did:plc identities in the stack's own directory, and
// resolve DID documents and the keys the spec names (#atproto, #atproto_kem).

import { sha256 } from '@noble/hashes/sha2.js';
import { b64url, base32 } from '../crypto/bytes.ts';
import { encode } from '../crypto/drisl.ts';
import { curveOf, didKey, type KeyPair, parseMultikey, type PublicKey } from '../crypto/keys.ts';
import { http, json } from '../http.ts';

export interface GenesisInput {
  rotation: KeyPair;
  signing: PublicKey;
  kem?: PublicKey;
  handle?: string;
  pdsUrl: string;
}

export interface UnsignedOp {
  type: 'plc_operation';
  rotationKeys: string[];
  verificationMethods: Record<string, string>;
  alsoKnownAs: string[];
  services: Record<string, { type: string; endpoint: string }>;
  prev: null;
}

export function genesisOp(g: GenesisInput): UnsignedOp {
  const verificationMethods: Record<string, string> = { atproto: didKey(g.signing) };
  if (g.kem) verificationMethods.atproto_kem = didKey(g.kem);
  return {
    type: 'plc_operation',
    rotationKeys: [didKey(g.rotation)],
    verificationMethods,
    alsoKnownAs: g.handle ? [`at://${g.handle}`] : [],
    services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: g.pdsUrl } },
    prev: null,
  };
}

/** Sign with the rotation key (low-S, sha256 of the DRISL bytes) and derive the DID. */
export function signGenesis(op: UnsignedOp, rotation: KeyPair): { did: string; signed: UnsignedOp & { sig: string } } {
  const sig = curveOf(rotation.curve).sign(encode(op as never), rotation.secret, { lowS: true });
  const signed = { ...op, sig: b64url(sig) };
  const did = `did:plc:${base32(sha256(encode(signed as never))).slice(0, 24)}`;
  return { did, signed };
}

export class Plc {
  readonly url: string;
  constructor(url: string) {
    this.url = url.replace(/\/$/, '');
  }

  async register(g: GenesisInput): Promise<string> {
    const { did, signed } = signGenesis(genesisOp(g), g.rotation);
    const r = await http(`${this.url}/${did}`, json(signed));
    if (r.status >= 300) throw new Error(`PLC refused the genesis op for ${did} (${r.status}): ${JSON.stringify(r.body)}`);
    return did;
  }

  async resolve(did: string): Promise<DidDocument> {
    const r = await http(`${this.url}/${did}`);
    if (r.status !== 200) throw new Error(`PLC has no document for ${did} (${r.status})`);
    return r.body as DidDocument;
  }
}

export interface DidDocument {
  id: string;
  alsoKnownAs?: string[];
  verificationMethod?: { id: string; type: string; controller: string; publicKeyMultibase: string }[];
  service?: { id: string; type: string; serviceEndpoint: string }[];
}

/** A verification method by fragment (e.g. "atproto_kem"), checked against the spec's #kem-key shape. */
export function verificationKey(doc: DidDocument, fragment: string): PublicKey | null {
  const vm = doc.verificationMethod?.find((m) => m.id === `${doc.id}#${fragment}` || m.id === `#${fragment}`);
  if (!vm || vm.type !== 'Multikey' || vm.controller !== doc.id) return null;
  return parseMultikey(vm.publicKeyMultibase);
}

export function serviceEndpoint(doc: DidDocument, fragment: string): string | null {
  return doc.service?.find((s) => s.id === `#${fragment}` || s.id === `${doc.id}#${fragment}`)?.serviceEndpoint ?? null;
}
