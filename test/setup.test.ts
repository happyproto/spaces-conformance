import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HttpResponse } from '../harness/http.ts';
import type { Manifest } from '../harness/manifest.ts';
import { methodMissing, recordedMode, requestedMode, simplespacePolicy } from '../harness/setup.ts';

const manifest = { spaces: { create: 'simplespace', modes: ['oct29', 'simplespace', 'auto'] } } as unknown as Manifest;
const resp = (status: number, body: unknown) => ({ status, body, headers: new Headers(), bytes: new Uint8Array() }) as HttpResponse;

describe('setup modes', () => {
  it('takes --setup-mode over the manifest default, and refuses an unknown one', () => {
    expect(requestedMode(manifest, {})).toBe('simplespace');
    expect(requestedMode(manifest, { CONFORMANCE_SPACES_MODE: 'oct29' })).toBe('oct29');
    expect(() => requestedMode(manifest, { CONFORMANCE_SPACES_MODE: 'oct22' })).toThrow(/not one of/);
  });

  it('records what auto resolved to, or auto when nothing resolved it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'raw-'));
    const env = { CONFORMANCE_SPACES_MODE: 'auto', CONFORMANCE_RAW_DIR: dir };
    expect(recordedMode(manifest, 'create-account', env)).toEqual({ accounts: 'create-account', spaces: 'auto' });
    writeFileSync(join(dir, 'spaces-mode.json'), JSON.stringify({ spaces: 'simplespace' }));
    expect(recordedMode(manifest, 'create-account', env)).toEqual({ accounts: 'create-account', spaces: 'simplespace' });
    expect(recordedMode(manifest, 'custom', { CONFORMANCE_RAW_DIR: dir })).toEqual({ accounts: 'custom', spaces: 'simplespace' });
  });

  it('tells a method the host does not serve from a refused request', () => {
    expect(methodMissing(resp(404, { error: 'UnknownMethod' }))).toBe(true); // ZDS
    expect(methodMissing(resp(501, { error: 'MethodNotImplemented' }))).toBe(true); // pds.js, atproto-pds
    expect(methodMissing(resp(400, { error: 'InvalidRequest', message: 'No service configured for com.atproto.space.createSpace' }))).toBe(true); // reference
    expect(methodMissing(resp(400, { error: 'InvalidRequest', message: 'Missing spaceType' }))).toBe(false);
    expect(methodMissing(resp(401, { error: 'AuthRequired' }))).toBe(false);
  });
});

describe('Oct 29 policy to simplespace', () => {
  const defs = 'com.atproto.simplespace.defs';
  it('maps memberspace read, write and allowed apps', () => {
    expect(simplespacePolicy({ $type: 'com.atproto.memberspace.policy' })).toEqual({
      readPolicy: { $type: `${defs}#memberListPolicy` },
      writePolicy: { $type: `${defs}#memberListPolicy` },
      appAccess: { $type: `${defs}#open` },
    });
    expect(simplespacePolicy({ $type: 'com.atproto.memberspace.policy', publicRead: true, allowedApps: ['https://app.example/client.json'] })).toEqual({
      readPolicy: { $type: `${defs}#publicPolicy` },
      writePolicy: { $type: `${defs}#memberListPolicy` },
      appAccess: { $type: `${defs}#allowList`, allowed: ['https://app.example/client.json'] },
    });
  });

  it('maps managedspace to a managing-app policy, and refuses what simplespace cannot say', () => {
    const managed = { $type: `${defs}#managingAppPolicy`, managingApp: 'did:web:app.example#forum' };
    expect(simplespacePolicy({ $type: 'com.atproto.managedspace.policy', managingApp: 'did:web:app.example#forum' })).toMatchObject({ readPolicy: managed, writePolicy: managed });
    expect(() => simplespacePolicy({ $type: 'com.atproto.personalspace.policy' })).toThrow(/can't express/);
  });
});
