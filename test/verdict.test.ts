import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawResult } from '../harness/assert.ts';
import { capEvidence } from '../harness/assert.ts';
import { loadCatalogue } from '../harness/catalogue.ts';
import { vectorStatus } from '../harness/provisional.ts';
import { assemble } from '../harness/reporter.ts';
import { validateResults } from '../harness/results.ts';
import { ROOT } from '../harness/schema.ts';
import { judge, judgeAll } from '../harness/verdict.ts';

describe('display states and gating (design ch. 4.4)', () => {
  it.each([
    ['pass', false, false, 'pass', 'ok', true, true],
    ['pass', false, true, 'pass', 'ok', false, true],
    ['fail', false, false, 'fail', 'fail', true, false],
    ['fail', false, true, 'fail (provisional)', 'warn', false, false],
    ['fail', true, false, 'known deviation', 'ok', true, false],
    ['fail', true, true, 'known deviation', 'ok', false, false],
    ['pass', true, false, 'fixed, still listed', 'fail', true, true],
    ['pass', true, true, 'fixed, still listed', 'warn', false, true],
    ['error', false, false, 'error', 'fail', false, false],
    ['error', true, true, 'error', 'fail', false, false],
    ['skip', false, false, 'not applicable', 'ok', false, false],
  ] as const)('raw %s, listed %s, provisional %s -> %s (%s)', (raw, listed, prov, display, gate, scored, passing) => {
    expect(judge(raw, listed, prov)).toEqual({ display, gate, scored, passing });
  });
});

describe('scoring', () => {
  const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
  const byId = new Map(cat.assertions.map((a) => [a.id, a]));
  const areas = vectorStatus();

  it('scores must rows per role, counts deviations as not passing, and leaves out provisional, info and skipped rows', () => {
    const results: RawResult[] = [
      { id: 'digest.cid-drisl-plain', suite: 'digest', status: 'pass' }, // cbor: cross-checked, scored
      { id: 'records.commit-fields', suite: 'records', status: 'fail' }, // no areas, scored
      { id: 'records.params-repo', suite: 'records', status: 'fail' }, // listed below: known deviation
      { id: 'mac.commit-valid', suite: 'mac', status: 'fail' }, // mac pending: provisional, excluded
      { id: 'info.unknown-method-status', suite: 'records', status: 'pass' }, // info: never scored
      { id: 'lifecycle.implicit-create', suite: 'lifecycle', status: 'skip', skip_reason: 'role' },
    ];
    const { judged, summary } = judgeAll(results, byId, new Set(['records.params-repo']), areas, ['repo-host', 'space-host']);
    expect(summary.by_role['repo-host']).toEqual({ must_applicable: 3, must_pass: 1, should_applicable: 0, should_pass: 0 });
    expect(summary.unexpected).toBe(1); // only records.commit-fields
    expect(judged.find((j) => j.id === 'mac.commit-valid')).toMatchObject({ display: 'fail (provisional)', gate: 'warn' });
    expect(judged.find((j) => j.id === 'records.params-repo')).toMatchObject({ display: 'known deviation', gate: 'ok' });
  });

  it('counts a fixed, still listed result as a pass but gates on it', () => {
    const { judged, summary } = judgeAll([{ id: 'records.commit-fields', status: 'pass' }], byId, new Set(['records.commit-fields']), areas, ['repo-host']);
    expect(summary.by_role['repo-host']!.must_pass).toBe(1);
    expect(judged[0].display).toBe('fixed, still listed');
    expect(summary.unexpected).toBe(1);
  });
});

describe('the reporter', () => {
  it('assembles a results file that passes the schema and cross-checks', () => {
    const raw: RawResult[] = [
      { id: 'digest.cid-drisl-plain', suite: 'digest', status: 'pass', ms: 10 },
      { id: 'records.commit-fields', suite: 'records', status: 'fail', ms: 5, message: 'shape', evidence: { body: '{}' } },
      { id: 'lifecycle.create-caller-is-authority', suite: 'lifecycle', status: 'skip', skip_reason: 'role pds not claimed' },
    ];
    const env = {
      CONFORMANCE_IMPL: 'reference',
      CONFORMANCE_RUN_ID: '2026-11-10T05-24-57Z-reference-d3e5',
      CONFORMANCE_IMAGES: JSON.stringify({ reference: `ghcr.io/x/y@sha256:${'a'.repeat(64)}` }),
      CONFORMANCE_PEERS: JSON.stringify([{ id: 'plc', image: `ghcr.io/x/plc@sha256:${'b'.repeat(64)}` }]),
      SUITE_COMMIT: 'abc1234',
    };
    const file = assemble(env, { accounts: 'create-account', spaces: 'simplespace' }, raw);
    expect(validateResults(file, 'r', loadCatalogue(join(ROOT, 'spec', 'assertions.yaml')))).toEqual([]);
    expect(file.summary.by_role['repo-host']).toEqual({ must_applicable: 2, must_pass: 1, should_applicable: 0, should_pass: 0 });
    expect(file.summary.unexpected).toBe(1);
    expect(file.implementation.setup_mode).toEqual({ accounts: 'create-account', spaces: 'simplespace' });
  });

  it('caps evidence at 4 KiB', () => {
    const e = capEvidence({ body: 'x'.repeat(10_000), status: 400 });
    expect(JSON.stringify(e).length).toBeLessThanOrEqual(4096);
    expect(e.status).toBe(400);
  });
});
