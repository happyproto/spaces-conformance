import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Assertion } from '../harness/catalogue.ts';
import { loadCatalogue } from '../harness/catalogue.ts';
import { provisionalReason, vectorStatus } from '../harness/provisional.ts';
import { ROOT } from '../harness/schema.ts';

const row = (over: Partial<Assertion>): Assertion => ({ id: 't.t', suite: 'digest', level: 'must', roles: ['repo-host'], areas: [], checks: 'x', ...over });

describe('provisional fencing', () => {
  it('reads area status from the shipped vectors', () => {
    const s = vectorStatus();
    expect(s.get('cbor')!.pending).toBe(false); // every CID vector agrees with a third-party encoder
    expect(s.get('jwt')!.pending).toBe(false); // RFC 7515 A.3
    expect(s.get('mac')!.pending).toBe(true); // MAC vectors are harness-only
    expect(s.get('star')!.pending).toBe(true);
    expect(s.get('mac')!.pendingVectors.join()).toMatch(/mac\.json/);
  });

  it('makes an assertion provisional while any of its areas is pending', () => {
    const s = vectorStatus();
    expect(provisionalReason(row({ areas: ['cbor'] }), s)).toBeNull();
    expect(provisionalReason(row({ areas: ['cbor', 'mac'] }), s)).toMatch(/mac not yet cross-checked/);
    expect(provisionalReason(row({ provisional: true }), s)).toMatch(/flagged/);
    expect(provisionalReason(row({ areas: [] }), s)).toBeNull();
  });

  it('treats an area with no vectors as pending, and one pending entry as enough', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vec-'));
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ vectors: [
      { name: 'x', cross_check: { area: 'cbor', status: 'cross-checked', against: ['y'] } },
      { name: 'z', cross_check: { area: 'lthash', status: 'cross-checked', against: ['y'] } },
      { name: 'w', cross_check: { area: 'lthash', status: 'pending', against: [] } },
    ] }));
    const s = vectorStatus(dir);
    expect(s.get('cbor')!.pending).toBe(false);
    expect(s.get('lthash')!.pending).toBe(true);
    expect(s.get('lthash')!.pendingVectors).toEqual(['a.json: w']);
    expect(s.get('httpsig')!.pending).toBe(true);
  });

  it('leaves every MAC and STAR assertion in the shipped catalogue provisional for now', () => {
    const s = vectorStatus();
    const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
    for (const a of cat.assertions.filter((a) => a.suite === 'mac' || a.suite === 'export')) expect(provisionalReason(a, s), a.id).not.toBeNull();
  });
});
