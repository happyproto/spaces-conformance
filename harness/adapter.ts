// What an implementation's adapter provides (design ch. 4.2). Everything an
// adapter does is setup, which isn't graded: a failure here records `error`.

import type { Plc } from './actors/plc.ts';
import type { KeyPair } from './crypto/keys.ts';
import type { HttpResponse } from './http.ts';
import type { Manifest } from './manifest.ts';

/** How requests are authenticated as an account. Outside 0016 for password sessions; recorded, not graded. */
export interface WriteAuth {
  mode: 'password-session' | 'oauth-dpop' | 'api-key';
  /** Send an authenticated request, with any extra headers (e.g. Atproto-Space-Want-Mac). */
  request(method: 'GET' | 'POST', url: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResponse>;
}

export interface Account {
  did: string;
  handle: string;
  /** The host that holds this account's space repos. */
  repoHost: string;
  auth: WriteAuth;
  /**
   * The account's own keys, when the harness made its identity (pds.js). The
   * credential suites sign delegation tokens with `signing`; `others` are
   * other keys its DID document lists, such as #atproto_kem.
   */
  keys?: { signing: KeyPair; others: { id: string; key: KeyPair }[] };
}

export interface SetupMode {
  accounts: 'create-account' | 'custom' | 'external';
  /** `auto` only when no space was created, so nothing resolved it (harness/setup.ts). */
  spaces: 'oct29' | 'simplespace' | 'auto' | 'custom';
  bootstrap?: string;
}

export interface StackCtx {
  manifest: Manifest;
  /** Where the harness reaches the implementation under test. */
  baseUrl: string;
  plc: Plc;
}

/** A policy as 0016 writes it; adapters translate for older lifecycles. */
export interface Policy {
  $type: string;
  [k: string]: unknown;
}

export interface Adapter {
  /** What this run used for setup. Called by the reporter after the suites ran. */
  setupMode(manifest: Manifest): SetupMode;
  provisionAccount(ctx: StackCtx, name: string): Promise<Account>;
  /** Create a space owned by `owner` and return its at:// URI. */
  createSpace(ctx: StackCtx, owner: Account, spaceType: string, policy: Policy): Promise<string>;
}
