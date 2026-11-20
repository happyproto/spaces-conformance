import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../harness/catalogue.ts';
import { ROOT } from '../harness/schema.ts';
import { addRuns, checkStore, type ImplIndex, type LatestIndex, rebuildIndex, runPath } from '../harness/store.ts';

const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
const fixture = (name: string) => JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'results', name), 'utf8'));
const zds = () => fixture('parity-zds-2026-11-13.json');
const store = () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  rebuildIndex(dir);
  return dir;
};
const latest = (dir: string): LatestIndex => JSON.parse(readFileSync(join(dir, 'index', 'latest.json'), 'utf8'));
/** A copy of a run with a new id, start time and kind. */
const rerun = (f: any, stamp: string, kind = f.run.kind) => {
  const g = structuredClone(f);
  g.run.id = `${stamp.replace(/:/g, '-').replace(/\.\d+Z$/, 'Z')}-${g.implementation.id}-0001`;
  g.run.started_at = stamp;
  g.run.finished_at = stamp;
  g.run.kind = kind;
  return g;
};

describe('the results store (design ch. 7.2)', () => {
  it('files each run by implementation and month', () => {
    expect(runPath(zds())).toBe('runs/zds/2026/11/2026-11-14T20-24-12Z-zds-5a34.json');
  });

  it('adds valid runs and rebuilds an index that checks clean', () => {
    const dir = store();
    const { added, problems } = addRuns(dir, [{ name: 'zds', data: zds() }, { name: 'hv', data: fixture('happyview-beta14-2026-11-13.json') }], cat);
    expect(problems).toEqual([]);
    expect(added).toHaveLength(2);
    expect(Object.keys(latest(dir).implementations).sort()).toEqual(['happyview', 'zds']);
    expect(checkStore(dir)).toEqual([]);
    const idx: ImplIndex = JSON.parse(readFileSync(join(dir, 'index', 'zds.json'), 'utf8'));
    expect(idx.runs[0].counts.pass).toBeGreaterThan(0);
  });

  it('writes nothing when any file fails validation', () => {
    const dir = store();
    const bad = zds();
    bad.results[0].status = 'maybe';
    const { added, problems } = addRuns(dir, [{ name: 'ok', data: fixture('happyview-beta14-2026-11-13.json') }, { name: 'bad', data: bad }], cat);
    expect(added).toEqual([]);
    expect(problems.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'runs'))).toBe(false);
  });

  it('refuses an assertion the catalogue does not have', () => {
    const bad = zds();
    bad.results[0].id = 'records.no-such-row';
    expect(addRuns(store(), [{ name: 'bad', data: bad }], cat).problems.map((p) => p.message)).toContain('assertion is not in the catalogue');
  });

  it('treats the same run twice as a no-op, and a changed one as a refusal', () => {
    const dir = store();
    addRuns(dir, [{ name: 'zds', data: zds() }], cat);
    expect(addRuns(dir, [{ name: 'zds', data: zds() }], cat).unchanged).toHaveLength(1);
    const edited = zds();
    edited.results[0].message = 'edited';
    expect(addRuns(dir, [{ name: 'zds', data: edited }], cat).problems[0].message).toMatch(/already in the store with different content/);
  });

  it('points latest at the newest non-candidate run, and shows a newer candidate beside it', () => {
    const dir = store();
    const f = zds();
    addRuns(dir, [{ name: 'a', data: f }, { name: 'b', data: rerun(f, '2026-11-16T00:00:00.000Z', 'nightly') }, { name: 'c', data: rerun(f, '2026-11-17T00:00:00.000Z', 'candidate') }], cat);
    const l = latest(dir);
    expect(l.implementations.zds['2026-11-12'].run).toBe('2026-11-16T00-00-00Z-zds-0001');
    expect(l.candidates.zds['2026-11-12'].run).toBe('2026-11-17T00-00-00Z-zds-0001');
    expect(l.updated_at).toBe('2026-11-17T00:00:00.000Z');
    // A nightly after the candidate hides it again.
    addRuns(dir, [{ name: 'd', data: rerun(f, '2026-11-18T00:00:00.000Z', 'nightly') }], cat);
    expect(latest(dir).candidates).toEqual({});
  });

  it('flags a hand-edited index, a misfiled run and a stray index file', () => {
    const dir = store();
    addRuns(dir, [{ name: 'zds', data: zds() }], cat);
    writeFileSync(join(dir, 'index', 'latest.json'), '{"schema":1,"updated_at":null,"implementations":{},"candidates":{}}\n');
    expect(checkStore(dir).map((p) => p.message).join()).toMatch(/doesn't match what runs\/ rebuilds to/);
    rebuildIndex(dir);
    writeFileSync(join(dir, 'index', 'ghost.json'), '{}');
    expect(checkStore(dir).map((p) => p.message)).toContain('index file for an implementation with no runs');
  });

  it('carries a run\'s fingerprint into its index entry', () => {
    const dir = store();
    const f = zds();
    f.run.fingerprint = { digest: `sha256:${'a'.repeat(64)}`, code: `sha256:${'b'.repeat(64)}`, images: { zds: f.implementation.image }, revision: { key: '2026-11-12', proposal: 'x', lexicons: 'y' }, slow: true };
    expect(addRuns(dir, [{ name: 'zds', data: f }], cat).problems).toEqual([]);
    const idx: ImplIndex = JSON.parse(readFileSync(join(dir, 'index', 'zds.json'), 'utf8'));
    expect(idx.runs[0].fingerprint).toBe(`sha256:${'a'.repeat(64)}`);
    expect(checkStore(dir)).toEqual([]);
  });

  it('marks a run whose earlier attempt hit infrastructure', () => {
    const dir = store();
    const f = zds();
    f.run.infrastructure = 'stack: the stack did not come up healthy';
    expect(addRuns(dir, [{ name: 'zds', data: f }], cat).problems).toEqual([]);
    const idx: ImplIndex = JSON.parse(readFileSync(join(dir, 'index', 'zds.json'), 'utf8'));
    expect(idx.runs[0].infrastructure).toBe(true);
    expect(checkStore(dir)).toEqual([]);
  });

  it('is not a store without runs/', () => {
    expect(checkStore(mkdtempSync(join(tmpdir(), 'nostore-')))[0].message).toMatch(/not a results store/);
  });
});
