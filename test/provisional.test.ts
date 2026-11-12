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
  it('reads area status from the shipped vectors: phase 3 cleared every area', () => {
    const s = vectorStatus();
    for (const area of ['cbor', 'lthash', 'mac', 'httpsig', 'jwt', 'star'] as const) expect(s.get(area)!.pending, area).toBe(false);
  });

  /** Shipped status, with mac pending: the fencing logic, independent of today's vectors. */
  const withMacPending = () => {
    const s = vectorStatus();
    s.set('mac', { area: 'mac', pending: true, pendingVectors: ['mac.json: x'] });
    return s;
  };

  it('makes an assertion provisional while any of its areas is pending', () => {
    const s = withMacPending();
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

  it('leaves no assertion in the shipped catalogue provisional by area, now every area is cleared', () => {
    const s = vectorStatus();
    const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
    for (const a of cat.assertions.filter((a) => !a.provisional)) expect(provisionalReason(a, s), a.id).toBeNull();
  });

  it('makes every MAC assertion provisional while the mac area is pending', () => {
    const s = withMacPending();
    const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
    for (const a of cat.assertions.filter((a) => a.suite === 'mac' && a.areas?.includes('mac'))) expect(provisionalReason(a, s), a.id).not.toBeNull();
  });
});
