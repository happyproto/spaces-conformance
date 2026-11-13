import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Assertion } from '../harness/catalogue.ts';
import { loadCatalogue } from '../harness/catalogue.ts';
import { buildPassIndex, independenceReason, independent, type Independence, loadIndependence, PASS_INDEX, staleSources, validatePassIndex } from '../harness/independence.ts';
import { provisionalReason, vectorStatus } from '../harness/provisional.ts';
import { ROOT } from '../harness/schema.ts';
import { judgeAll } from '../harness/verdict.ts';

const row = (over: Partial<Assertion>): Assertion => ({ id: 't.t', suite: 'digest', level: 'must', roles: ['repo-host'], areas: ['cbor'], checks: 'x', ...over });
const ind = (passes: Record<string, string[]>, lineage: Record<string, Record<string, string>>): Independence => ({
  passes: new Map(Object.entries(passes)),
  lineage: new Map(Object.entries(lineage)),
});

describe('independence (design S5)', () => {
  it('clears a row that passed on two implementations of different lineage', () => {
    expect(independenceReason(row({}), ind({ 't.t': ['a', 'b'] }, { a: { cbor: 'x' }, b: { cbor: 'y' } }))).toBeNull();
  });

  it('does not clear when both share a lineage: two hosts on one package count as one', () => {
    const r = independenceReason(row({}), ind({ 't.t': ['a', 'b'] }, { a: { cbor: '@atproto/lex-cbor' }, b: { cbor: '@atproto/lex-cbor' } }));
    expect(r).toMatch(/not yet passed on two implementations of independent cbor lineage \(passed only on a, b\)/);
  });

  it('does not clear when a lineage is unknown', () => {
    expect(independenceReason(row({}), ind({ 't.t': ['a', 'b'] }, { a: { cbor: 'x' }, b: {} }))).not.toBeNull();
    expect(independenceReason(row({}), ind({ 't.t': ['a', 'b'] }, { a: { cbor: 'x' } }))).not.toBeNull();
  });

  it('needs a pass on two implementations, not one', () => {
    expect(independenceReason(row({}), ind({ 't.t': ['a'] }, { a: { cbor: 'x' } }))).toMatch(/passed only on a/);
    expect(independenceReason(row({}), ind({}, {}))).toMatch(/not yet passed anywhere/);
  });

  it('needs the lineages to differ in every area the row uses', () => {
    const lineage = { a: { cbor: 'x', lthash: 'same' }, b: { cbor: 'y', lthash: 'same' }, c: { cbor: 'z', lthash: 'other' } };
    const r = row({ areas: ['cbor', 'lthash'] });
    expect(independenceReason(r, ind({ 't.t': ['a', 'b'] }, lineage))).not.toBeNull();
    expect(independenceReason(r, ind({ 't.t': ['a', 'b', 'c'] }, lineage))).toBeNull();
    expect(independent({ cbor: 'x' }, { cbor: 'y' }, ['cbor', 'mac'])).toBe(false);
  });

  it('leaves rows that use no harness crypto alone', () => {
    expect(independenceReason(row({ areas: [] }), ind({}, {}))).toBeNull();
  });

  it('applies after the catalogue flag and the vector areas', () => {
    const s = vectorStatus();
    const none = ind({}, {});
    expect(provisionalReason(row({ provisional: true }), s, none)).toMatch(/flagged/);
    expect(provisionalReason(row({}), s, none)).toMatch(/independent cbor lineage/);
    expect(provisionalReason(row({}), s)).toBeNull(); // without the evidence, only the earlier rules apply
  });

  it('makes an unindependent fail provisional, and keeps it out of the score', () => {
    const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
    const byId = new Map(cat.assertions.map((a) => [a.id, a]));
    const { judged, summary } = judgeAll([{ id: 'digest.multi-batch', status: 'fail' }], byId, new Map(), vectorStatus(), ['repo-host'], ind({}, {}));
    expect(judged[0]).toMatchObject({ display: 'fail (provisional)', gate: 'warn', scored: false });
    expect(summary.by_role['repo-host']!.must_applicable).toBe(0);
  });
});

describe('the pass index per revision and per assertion digest (HAP-432)', () => {
  const file = (impl: string, revision: string, digests?: Record<string, string>) => ({
    path: `test/${impl}.json`,
    file: {
      run: { id: `r-${impl}` },
      suite: { commit: 'abc1234', assertions_digest: 'sha256:x', ...(digests ? { assertion_digests: digests } : {}) },
      spec: { revision },
      implementation: { id: impl, image: 'i' },
      results: [
        { id: 'a.one', status: 'pass' },
        { id: 'a.two', status: 'pass' },
        { id: 'a.three', status: 'fail' },
      ],
    },
  });

  it('keeps passes apart by revision', () => {
    const idx = buildPassIndex([file('x', '2026-10-29'), file('y', '2026-11-12')]);
    expect(idx.passes).toEqual({ '2026-10-29': { 'a.one': ['x'], 'a.two': ['x'] }, '2026-11-12': { 'a.one': ['y'], 'a.two': ['y'] } });
    expect(idx.sources.map((s) => s.revision)).toEqual(['2026-10-29', '2026-11-12']);
  });

  it('refuses a pass whose row or test changed since the run, and names it', () => {
    const idx = buildPassIndex([file('x', '2026-11-12', { 'a.one': 'sha256:old', 'a.two': 'sha256:same' })], [], () => ({ 'a.one': 'sha256:new', 'a.two': 'sha256:same' }));
    expect(idx.passes['2026-11-12']).toEqual({ 'a.two': ['x'] });
    expect(idx.sources[0].stale_passes).toEqual(['a.one']);
  });

  it('still counts every pass of a source from before per-assertion digests', () => {
    const idx = buildPassIndex([file('x', '2026-10-29')], [], () => ({ 'a.one': 'sha256:new' }));
    expect(idx.passes['2026-10-29']).toEqual({ 'a.one': ['x'], 'a.two': ['x'] });
    expect(idx.sources[0].stale_passes).toBeUndefined();
  });

  it('loads one revision\'s passes', () => {
    const g1 = loadIndependence('2026-10-29').passes;
    const g2 = loadIndependence('2026-11-12').passes;
    expect(g1.size).toBeGreaterThan(0);
    expect(g2.size).toBeGreaterThan(0);
    // A row that isn't in 2026-11-12 can't have passed there.
    expect(g1.has('mac.commit-valid')).toBe(true);
    expect(g2.has('mac.commit-valid')).toBe(false);
  });
});

describe('the committed pass index', () => {
  it('matches its sources', () => {
    expect(validatePassIndex(loadCatalogue(join(ROOT, 'spec', 'assertions.yaml')))).toEqual([]);
  });

  it('refuses a pass added by hand', () => {
    const dir = mkdtempSync(join(tmpdir(), 'passes-'));
    const path = join(dir, 'passes.json');
    copyFileSync(PASS_INDEX, path);
    const index = JSON.parse(readFileSync(path, 'utf8'));
    index.passes['2026-10-29']['digest.multi-batch'] = ['pdsjs', 'zds'];
    writeFileSync(path, JSON.stringify(index));
    const p = validatePassIndex(loadCatalogue(join(ROOT, 'spec', 'assertions.yaml')), path);
    expect(p.map((x) => x.message).join()).toMatch(/does not match its sources/);
  });

  it('requires every committed results file to be a source or excluded with a reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'passes-'));
    const path = join(dir, 'passes.json');
    const index = JSON.parse(readFileSync(PASS_INDEX, 'utf8'));
    index.excluded = index.excluded.slice(1);
    writeFileSync(path, JSON.stringify(index));
    const p = validatePassIndex(loadCatalogue(join(ROOT, 'spec', 'assertions.yaml')), path);
    expect(p.map((x) => x.message).join()).toMatch(/neither a source nor excluded/);
  });

  it('names sources that ran against another catalogue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'passes-'));
    const path = join(dir, 'passes.json');
    const index = JSON.parse(readFileSync(PASS_INDEX, 'utf8'));
    // Only a source without per-assertion digests is judged by the whole-file digest.
    index.sources[0] = { ...index.sources[0], file: 'test/fixtures/results/reference-2026-11-10.json', assertions_digest: 'sha256:0' };
    writeFileSync(path, JSON.stringify(index));
    expect(staleSources(path).map((s) => s.implementation)).toContain(index.sources[0].implementation);
  });

  it('loads every passing implementation with its manifest lineage', () => {
    const real = loadIndependence();
    expect(real.passes.get('digest.cid-drisl-plain')).toContain('reference');
    expect(real.lineage.get('reference')?.cbor).toBe('@atproto/lex-cbor');
  });
});
