// Shared setup for adapters (ungraded, design ch. 3.1). Account creation,
// password sessions and space creation in either lifecycle: the Oct 29
// com.atproto.space.createSpace or the Oct 22
// com.atproto.simplespace.createSpace. (On Nov 11 every pinned PDS image
// served only the Oct 22 method.)
//
// The spaces mode comes from CONFORMANCE_SPACES_MODE (cli/run.ts
// --setup-mode), else the manifest's spaces.create. `auto` asks the host for
// the Oct 29 method and falls back to simplespace when the host doesn't serve
// it. A worker writes the mode it resolved to the raw directory, so the
// reporter, in another process, records what the run actually used.

import { randomBytes } from '@noble/hashes/utils.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, Policy, SetupMode, WriteAuth } from './adapter.ts';
import { rawDir, setup } from './assert.ts';
import { hex } from './crypto/bytes.ts';
import { http, json, type HttpResponse } from './http.ts';
import type { Manifest } from './manifest.ts';

export type SpacesMode = 'oct29' | 'simplespace' | 'auto';
export const SPACES_MODES: readonly SpacesMode[] = ['oct29', 'simplespace', 'auto'];

/** The mode this run asked for: --setup-mode, else the manifest's default. */
export function requestedMode(manifest: Manifest, env = process.env): SpacesMode {
  const m = (env.CONFORMANCE_SPACES_MODE ?? manifest.spaces.create) as SpacesMode;
  if (!SPACES_MODES.includes(m)) throw new Error(`spaces mode ${m} is not one of ${SPACES_MODES.join(', ')}`);
  return m;
}

const RESOLVED = 'spaces-mode.json';

function rememberResolved(mode: 'oct29' | 'simplespace') {
  const dir = rawDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, RESOLVED), JSON.stringify({ spaces: mode }));
}

/**
 * The setup mode to record. With `auto`, the mode a worker resolved, or
 * `auto` itself if no space was created (nothing resolved it).
 */
export function recordedMode(manifest: Manifest, accounts: SetupMode['accounts'], env = process.env): SetupMode {
  const asked = requestedMode(manifest, env);
  let spaces: SetupMode['spaces'] = asked;
  const file = join(env.CONFORMANCE_RAW_DIR ?? rawDir(), RESOLVED);
  if (asked === 'auto' && existsSync(file)) spaces = JSON.parse(readFileSync(file, 'utf8')).spaces;
  return { accounts, spaces };
}

/** Requests as the account's password session (Bearer). Outside 0016; recorded, not graded. */
export function bearer(token: string): WriteAuth {
  return {
    mode: 'password-session',
    request: (method, url, body) =>
      http(
        url,
        body === undefined
          ? { method, headers: { authorization: `Bearer ${token}` } }
          : { ...json(body), method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
      ),
  };
}

export const PASSWORD = 'conformance-password';

/**
 * com.atproto.server.createAccount, returning a password-session account.
 * `labelHex` bounds the random part of the handle: ZDS caps a label at 18
 * characters.
 */
export function createAccount(baseUrl: string, name: string, labelHex = 4): Promise<Account> {
  return setup(`createAccount ${name}`, async () => {
    const handle = `${name}-${hex(randomBytes(labelHex))}.test`;
    const r = await http(`${baseUrl}/xrpc/com.atproto.server.createAccount`, json({ handle, email: `${handle}@example.invalid`, password: PASSWORD }));
    if (r.status !== 200 || typeof r.body?.accessJwt !== 'string') throw new Error(`createAccount answered ${r.status}: ${JSON.stringify(r.body)}`);
    return { did: r.body.did, handle, repoHost: baseUrl, auth: bearer(r.body.accessJwt) };
  });
}

/** Oct 29 policy object to the Oct 22 simplespace fields. */
export function simplespacePolicy(p: Policy) {
  const defs = 'com.atproto.simplespace.defs';
  if (p.$type === 'com.atproto.memberspace.policy') {
    const apps = p.allowedApps as string[] | undefined;
    return {
      readPolicy: { $type: p.publicRead ? `${defs}#publicPolicy` : `${defs}#memberListPolicy` },
      writePolicy: { $type: p.publicWrite ? `${defs}#publicPolicy` : `${defs}#memberListPolicy` },
      appAccess: apps ? { $type: `${defs}#allowList`, allowed: apps } : { $type: `${defs}#open` },
    };
  }
  if (p.$type === 'com.atproto.managedspace.policy') {
    const managed = { $type: `${defs}#managingAppPolicy`, managingApp: p.managingApp };
    return { readPolicy: managed, writePolicy: managed, appAccess: { $type: `${defs}#open` } };
  }
  throw new Error(`simplespace can't express ${p.$type}`);
}

/** The host doesn't serve this method (as opposed to refusing the request). */
export function methodMissing(r: HttpResponse): boolean {
  if (r.status === 404 || r.status === 501) return true;
  const err = String(r.body?.error ?? '');
  const msg = String(r.body?.message ?? '');
  return r.status === 400 && (/UnknownMethod|MethodNotImplemented/.test(err) || /No service configured/i.test(msg));
}

const ok = (r: HttpResponse) => r.status === 200 && typeof r.body?.uri === 'string';

async function oct29(baseUrl: string, owner: Account, spaceType: string, skey: string, policy: Policy) {
  return owner.auth.request('POST', `${baseUrl}/xrpc/com.atproto.space.createSpace`, { spaceType, skey, policy });
}

async function simplespace(baseUrl: string, owner: Account, spaceType: string, skey: string, policy: Policy) {
  // `type` alongside `spaceType`, as HappyView's interop tests send it: some
  // Oct 22 builds read one, some the other.
  return owner.auth.request('POST', `${baseUrl}/xrpc/com.atproto.simplespace.createSpace`, {
    spaceType,
    type: spaceType,
    skey,
    ...simplespacePolicy(policy),
  });
}

/** Create a space in the run's mode and return its at:// URI. */
export function createSpace(manifest: Manifest, baseUrl: string, owner: Account, spaceType: string, policy: Policy): Promise<string> {
  const mode = requestedMode(manifest);
  return setup(`createSpace (${mode})`, async () => {
    const skey = hex(randomBytes(6));
    let r: HttpResponse;
    let used: 'oct29' | 'simplespace';
    if (mode === 'auto') {
      r = await oct29(baseUrl, owner, spaceType, skey, policy);
      used = 'oct29';
      if (methodMissing(r)) {
        r = await simplespace(baseUrl, owner, spaceType, skey, policy);
        used = 'simplespace';
      }
    } else {
      used = mode;
      r = await (mode === 'oct29' ? oct29 : simplespace)(baseUrl, owner, spaceType, skey, policy);
    }
    if (!ok(r)) throw new Error(`${used === 'oct29' ? 'space' : 'simplespace'}.createSpace answered ${r.status}: ${JSON.stringify(r.body).slice(0, 500)}`);
    if (mode === 'auto') rememberResolved(used);
    return r.body.uri as string;
  });
}
