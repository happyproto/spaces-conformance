// Presenting a space credential (0016 #presenting-a-space-credential): RFC
// 9421 HTTP Message Signatures with ecdsa-p256-sha256 over exactly
// ("authorization" "atproto-space-audience"), tag "atproto-space-credential".
//
// The builder takes overrides so assertions can produce each bad signature
// a host must refuse (cred.httpsig-*), plus a high-S one it must accept.

import { p256 } from '@noble/curves/nist.js';
import { b64, utf8 } from './bytes.ts';
import type { KeyPair, PublicKey } from './keys.ts';
import { parseDictionary } from './sf.ts';

export const LABEL = 'atproto-space-credential';
export const COMPONENTS = ['authorization', 'atproto-space-audience'] as const;
export const SCHEME = 'Atproto-Space-Credential';

export const signatureParams = (components: readonly string[], tag: string): string =>
  `(${components.map((c) => `"${c}"`).join(' ')});tag="${tag}"`;

/** The RFC 9421 signature base for these two header values. */
export function signatureBase(fields: Record<string, string>, components: readonly string[], tag: string): string {
  const lines = components.map((c) => {
    const v = fields[c];
    if (v === undefined) throw new Error(`component ${c} has no value`);
    return `"${c}": ${v}`;
  });
  lines.push(`"@signature-params": ${signatureParams(components, tag)}`);
  return lines.join('\n');
}

const N = p256.Point.CURVE().n;

/** Turn a low-S r||s signature into its high-S twin (s' = n - s). Both verify. */
export function toHighS(sig: Uint8Array): Uint8Array {
  const s = BigInt(`0x${Buffer.from(sig.subarray(32)).toString('hex')}`);
  const hs = s > N / 2n ? s : N - s;
  const out = new Uint8Array(sig);
  out.set(Buffer.from(hs.toString(16).padStart(64, '0'), 'hex'), 32);
  return out;
}

export interface PresentOptions {
  /** Sign a different component list (cred.httpsig-wrong-components). */
  components?: readonly string[];
  /** Sign with a different tag (cred.httpsig-wrong-tag). */
  tag?: string;
  /** Send this audience header, but sign `audience` (or vice versa) — see signedAudience. */
  signedAudience?: string;
  /** Sign with a key other than the bound one (cred.httpsig-non-p256-key and friends). */
  signer?: KeyPair;
  highS?: boolean;
  /** Omit Signature and Signature-Input (cred.httpsig-no-signature). */
  omitSignature?: boolean;
  /** Scheme spelling, e.g. lowercase (cred.scheme-case-insensitive). */
  scheme?: string;
}

/** Headers presenting `credential` to `audience`, signed by the bound key. */
export function presentCredential(credential: string, audience: string, key: KeyPair, o: PresentOptions = {}): Record<string, string> {
  const authorization = `${o.scheme ?? SCHEME} ${credential}`;
  const headers: Record<string, string> = { authorization, 'atproto-space-audience': audience };
  if (o.omitSignature) return headers;
  const components = o.components ?? COMPONENTS;
  const tag = o.tag ?? LABEL;
  const base = signatureBase({ authorization, 'atproto-space-audience': o.signedAudience ?? audience }, components, tag);
  const signer = o.signer ?? key;
  let sig: Uint8Array = p256.sign(utf8(base), signer.secret, { lowS: true });
  if (o.highS) sig = toHighS(sig);
  headers['signature-input'] = `${LABEL}=${signatureParams(components, tag)}`;
  headers.signature = `${LABEL}=:${b64(sig)}:`;
  return headers;
}

/**
 * The host-side check, for the harness's own space-host actor and for vectors:
 * exact components, the tag, and an ecdsa-p256-sha256 signature by `bound`
 * over the headers as received. Returns a reason on failure.
 */
export function verifyPresentation(headers: Record<string, string | undefined>, bound: PublicKey): string | null {
  const authorization = headers.authorization;
  const audience = headers['atproto-space-audience'];
  if (!authorization || !/^atproto-space-credential /i.test(authorization)) return 'no Atproto-Space-Credential authorization';
  if (!audience) return 'no Atproto-Space-Audience';
  if (!headers['signature-input'] || !headers.signature) return 'no signature';
  if (bound.curve !== 'p256') return 'cnf.kid is not P-256';
  // The input must be exactly this, so a string compare is the whole check.
  if (headers['signature-input'].trim() !== `${LABEL}=${signatureParams(COMPONENTS, LABEL)}`) return 'wrong components or tag';
  let sigs;
  try {
    sigs = parseDictionary(headers.signature);
  } catch {
    return 'malformed signature';
  }
  const sig = sigs.get(LABEL);
  if (!(sig instanceof Uint8Array) || sig.length !== 64) return 'malformed signature';
  const base = signatureBase({ authorization, 'atproto-space-audience': audience }, COMPONENTS, LABEL);
  return p256.verify(sig, utf8(base), bound.compressed, { lowS: false }) ? null : 'signature does not verify';
}
