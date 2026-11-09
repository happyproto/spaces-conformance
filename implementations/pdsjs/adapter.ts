// pds.js setup hooks (ungraded). pds.js hosts one account and has no
// createAccount: the operator registers a did:plc and hands the server its
// signing and KEM keys through /init.

import { hex } from '../../harness/crypto/bytes.ts';
import { generate } from '../../harness/crypto/keys.ts';
import { http, json } from '../../harness/http.ts';
import type { Plc } from '../../harness/actors/plc.ts';
import { pdsjsConsent } from '../../harness/oauth/consent/pdsjs.ts';

export const PASSWORD = 'password123';

export interface PdsjsAccount {
  did: string;
  handle: string;
  pdsUrl: string;
  password: string;
  created: boolean;
}

/** The container's account, created on first use. */
export async function provisionAccount(plc: Plc, pdsUrl: string, handle: string, password = PASSWORD): Promise<PdsjsAccount> {
  const existing = await http(`${pdsUrl}/.well-known/atproto-did`);
  if (existing.status === 200 && typeof existing.body === 'string') {
    return { did: existing.body.trim(), handle, pdsUrl, password, created: false };
  }
  // The signing key doubles as the rotation key: nothing outside this stack sees it.
  const signing = generate('p256');
  const kem = generate('p256');
  const did = await plc.register({ rotation: signing, signing, kem, handle, pdsUrl });
  const r = await http(
    `${pdsUrl}/init`,
    json({ did, privateKey: hex(signing.secret), kemKey: hex(kem.secret), handle, curve: 'p256', password }),
  );
  if (r.status >= 300) throw new Error(`pds.js /init refused (${r.status}): ${JSON.stringify(r.body)}`);
  return { did, handle, pdsUrl, password, created: true };
}

export const consent = (account: PdsjsAccount) => pdsjsConsent(account.password);
