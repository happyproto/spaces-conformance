import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawResult } from '../harness/assert.ts';
import { capEvidence } from '../harness/assert.ts';
import { loadCatalogue, resolveCatalogue } from '../harness/catalogue.ts';
import { assertionDigest, assertionDigests } from '../harness/digests.ts';
import { vectorStatus } from '../harness/provisional.ts';
import { assemble, openSetupSteps, readRaw, reconcile } from '../harness/reporter.ts';
import { DeadlineExceeded, fail, Pending, pending, runAssertion, setup, SetupError } from '../harness/assert.ts';
import { loadManifest, notApplicable } from '../harness/manifest.ts';
import { checkTimeouts } from '../harness/timeouts.ts';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadDeviations, wholeMatch } from '../harness/deviations.ts';
import { tmpdir } from 'node:os';
import { declaredAssertions } from '../harness/coverage.ts';
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

describe('deviations whose failure changed', () => {
  it('gate a listed fail that differs from its expect, and only warn while provisional', () => {
    expect(judge('fail', true, false, false, false)).toEqual({ display: 'deviation changed', gate: 'fail', scored: true, passing: false });
    expect(judge('fail', true, true, false, false)).toEqual({ display: 'deviation changed', gate: 'warn', scored: false, passing: false });
  });
});

describe('flaky passes', () => {
  it('show as pass (flaky), score as a pass, and warn', () => {
    expect(judge('pass', false, false, true)).toEqual({ display: 'pass (flaky)', gate: 'warn', scored: true, passing: true });
  });
});

describe('reconciling Vitest with the raw records', () => {
  const declared = new Map([
    ['a.timeout', 'suites/x/a.test.ts'],
    ['a.unrecorded', 'suites/x/a.test.ts'],
    ['a.ok', 'suites/x/a.test.ts'],
    ['b.lost', 'suites/x/b.test.ts'],
    ['b.notapplicable', 'suites/x/b.test.ts'],
    ['c.twice', 'suites/x/c.test.ts'],
  ]);
  const cases = new Map([
    ['a.timeout', { state: 'failed' as const, errors: ['Test timed out in 60000ms.'] }],
    ['a.unrecorded', { state: 'failed' as const, errors: ['boom in a hook'] }],
    ['a.ok', { state: 'passed' as const, errors: [] }],
    ['c.twice', { state: 'passed' as const, errors: [] }],
  ]);
  const raw: RawResult[] = [
    { id: 'a.timeout', suite: 'x', status: 'pass', ms: 61000 }, // finished after its timeout
    { id: 'a.ok', suite: 'x', status: 'pass' },
    { id: 'c.twice', suite: 'x', status: 'pass' },
    { id: 'c.twice', suite: 'x', status: 'fail' },
  ];
  const out = new Map(
    reconcile(raw, cases, declared, new Map([['suites/x/b.test.ts', 'SyntaxError: nope']]), (id) => (id === 'b.notapplicable' ? 'role pds not claimed' : null), () => 'x').map((r) => [r.id, r]),
  );
  it('turns a late pass after a timeout into fail', () => expect(out.get('a.timeout')).toMatchObject({ status: 'fail' }));
  it('turns a failed test with no record into error', () => expect(out.get('a.unrecorded')).toMatchObject({ status: 'error', message: 'boom in a hook' }));
  it('keeps a good record', () => expect(out.get('a.ok')!.status).toBe('pass'));
  it('reports the declared assertions of a file that failed to load as error', () =>
    expect(out.get('b.lost')).toMatchObject({ status: 'error', message: expect.stringMatching(/b\.test\.ts failed to load: SyntaxError/) }));
  it('records an unrun but inapplicable assertion as skip', () => expect(out.get('b.notapplicable')).toMatchObject({ status: 'skip' }));
  it('turns a duplicate record into error', () => expect(out.get('c.twice')).toMatchObject({ status: 'error', message: 'recorded more than once in one run' }));
});

describe('setup hangs', () => {
  it('a setup step past its deadline throws SetupError, so it records error', async () => {
    const hung = setup('createAccount', () => new Promise(() => {}), 20);
    await expect(hung).rejects.toBeInstanceOf(SetupError);
    await expect(setup('fine', async () => 7, 1000)).resolves.toBe(7);
  });

  it('steps that each fit but together outlast the deadline record error, and the next test is unaffected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'raw-'));
    const prev = process.env.CONFORMANCE_RAW_DIR;
    process.env.CONFORMANCE_RAW_DIR = dir;
    try {
      const step = (ms: number) => () => new Promise<void>((r) => setTimeout(r, ms));
      let finished = false;
      const slow = runAssertion('a.slow', 'x', {}, async () => {
        for (const n of [1, 2, 3]) await setup(`step ${n}`, step(350), 1000);
        finished = true;
      }, 900);
      await expect(slow).rejects.toBeInstanceOf(DeadlineExceeded);
      await runAssertion('a.next', 'x', {}, async () => {}, 900);
      // Let the orphaned fn finish: its late pass must not be recorded.
      await new Promise((r) => setTimeout(r, 400));
      expect(finished).toBe(true);
      const recs = readRaw(dir);
      expect(recs.filter((r) => r.id === 'a.slow')).toEqual([expect.objectContaining({ status: 'error', evidence: { step: 'step 3' } })]);
      expect(recs.find((r) => r.id === 'a.next')).toMatchObject({ status: 'pass' });
      const cases = new Map([
        ['a.slow', { state: 'failed' as const, errors: ['ran past 900 ms during setup step step 3'] }],
        ['a.next', { state: 'passed' as const, errors: [] }],
      ]);
      const out = reconcile(recs, cases, new Map(), new Map(), () => null, () => 'x', openSetupSteps(dir));
      expect(out.find((r) => r.id === 'a.slow')).toMatchObject({ status: 'error' });
    } finally {
      if (prev === undefined) delete process.env.CONFORMANCE_RAW_DIR;
      else process.env.CONFORMANCE_RAW_DIR = prev;
    }
  });

  it('outlasting the deadline with no setup step open is a scored fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'raw-'));
    const prev = process.env.CONFORMANCE_RAW_DIR;
    process.env.CONFORMANCE_RAW_DIR = dir;
    try {
      const slow = runAssertion('a.slowhost', 'x', {}, async () => {
        await setup('fast', async () => {}, 1000);
        await new Promise((r) => setTimeout(r, 300));
      }, 100);
      await expect(slow).rejects.toBeInstanceOf(DeadlineExceeded);
      await new Promise((r) => setTimeout(r, 300));
      expect(readRaw(dir)).toEqual([expect.objectContaining({ id: 'a.slowhost', status: 'fail' })]);
    } finally {
      if (prev === undefined) delete process.env.CONFORMANCE_RAW_DIR;
      else process.env.CONFORMANCE_RAW_DIR = prev;
    }
  });

  it('a slow host that finishes after the deadline, either way, leaves exactly one fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'raw-'));
    const prev = process.env.CONFORMANCE_RAW_DIR;
    process.env.CONFORMANCE_RAW_DIR = dir;
    try {
      const late = (outcome: 'resolve' | 'reject') => async () => {
        await new Promise((r) => setTimeout(r, 200));
        if (outcome === 'reject') fail('the host answered wrongly, late');
      };
      await expect(runAssertion('a.lateok', 'x', {}, late('resolve'), 50)).rejects.toBeInstanceOf(DeadlineExceeded);
      await expect(runAssertion('a.latebad', 'x', {}, late('reject'), 50)).rejects.toBeInstanceOf(DeadlineExceeded);
      await new Promise((r) => setTimeout(r, 300));
      const recs = readRaw(dir);
      expect(recs.filter((r) => r.id === 'a.lateok')).toEqual([expect.objectContaining({ status: 'fail' })]);
      expect(recs.filter((r) => r.id === 'a.latebad')).toEqual([expect.objectContaining({ status: 'fail' })]);
      const out = reconcile(recs, new Map(), new Map(), new Map(), () => null, () => 'x');
      expect(out.map((r) => r.status)).toEqual(['fail', 'fail']);
    } finally {
      if (prev === undefined) delete process.env.CONFORMANCE_RAW_DIR;
      else process.env.CONFORMANCE_RAW_DIR = prev;
    }
  });

  it('a duplicate assertion id in one file still records twice, so reconcile flags it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'raw-'));
    const prev = process.env.CONFORMANCE_RAW_DIR;
    process.env.CONFORMANCE_RAW_DIR = dir;
    try {
      await runAssertion('a.twice', 'x', {}, async () => {}, 1000);
      await runAssertion('a.twice', 'x', {}, async () => {}, 1000);
      const [r] = reconcile(readRaw(dir), new Map(), new Map(), new Map(), () => null, () => 'x');
      expect(r).toMatchObject({ id: 'a.twice', status: 'error', message: 'recorded more than once in one run' });
    } finally {
      if (prev === undefined) delete process.env.CONFORMANCE_RAW_DIR;
      else process.env.CONFORMANCE_RAW_DIR = prev;
    }
  });

  it('refuses a deadline at or past the test timeout, or a setup timeout at or past the deadline', () => {
    expect(() => checkTimeouts({ test: 60_000, deadline: 58_000, setup: 45_000 })).not.toThrow();
    expect(() => checkTimeouts({ test: 60_000, deadline: 60_000, setup: 45_000 })).toThrow(/below the test timeout/);
    expect(() => checkTimeouts({ test: 30_000, deadline: 58_000, setup: 45_000 })).toThrow(/below the test timeout/);
    expect(() => checkTimeouts({ test: 60_000, deadline: 40_000, setup: 45_000 })).toThrow(/below the assertion deadline/);
  });

  it('a pending precondition records skip with a pending reason, not error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'raw-'));
    const prev = process.env.CONFORMANCE_RAW_DIR;
    process.env.CONFORMANCE_RAW_DIR = dir;
    try {
      await expect(runAssertion('a.pending', 'x', {}, async () => pending('credential path in phase 7'), 1000)).rejects.toBeInstanceOf(Pending);
      const recs = readRaw(dir);
      expect(recs).toEqual([expect.objectContaining({ id: 'a.pending', status: 'skip', skip_reason: 'pending: credential path in phase 7' })]);
      const cases = new Map([['a.pending', { state: 'skipped' as const, errors: [] }]]);
      expect(reconcile(recs, cases, new Map(), new Map(), () => null, () => 'x')[0]).toMatchObject({ status: 'skip' });
    } finally {
      if (prev === undefined) delete process.env.CONFORMANCE_RAW_DIR;
      else process.env.CONFORMANCE_RAW_DIR = prev;
    }
  });

  it('a row that requires harness.credential_reads is not applicable to every manifest', () => {
    const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
    const row = cat.assertions.find((a) => a.id === 'mac.commit-bound-to-repo')!;
    for (const impl of ['zds', 'pdsjs', 'reference', 'atproto-pds', 'happyview']) {
      const m = loadManifest(join(ROOT, 'implementations', impl, 'manifest.yaml'));
      expect(notApplicable(row, m)).toMatch(/harness\.credential_reads not claimed/);
    }
  });

  it('a test timeout during an open setup step is error, not a scored fail', () => {
    const cases = new Map([['a.hung', { state: 'failed' as const, errors: ['Test timed out in 60000ms.'] }]]);
    const declared = new Map([['a.hung', 'suites/x/a.test.ts']]);
    const [r] = reconcile([], cases, declared, new Map(), () => null, () => 'x', new Map([['a.hung', 'createSpace']]));
    expect(r).toMatchObject({ status: 'error', message: expect.stringMatching(/during setup step createSpace/), evidence: { step: 'createSpace' } });
  });

  it('reads open setup steps from the markers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'raw-'));
    writeFileSync(
      join(dir, '1.setup.jsonl'),
      [
        { id: 'a', step: 'createAccount', phase: 'start' },
        { id: 'a', step: 'createAccount', phase: 'end' },
        { id: 'a', step: 'createSpace', phase: 'start' },
        { id: 'b', step: 'createAccount', phase: 'start' },
        { id: 'b', step: 'createAccount', phase: 'end' },
      ].map((x) => JSON.stringify(x)).join('\n'),
    );
    expect([...openSetupSteps(dir)]).toEqual([['a', 'createSpace']]);
    // Setup markers aren't results.
    writeFileSync(join(dir, '1.jsonl'), JSON.stringify({ id: 'a', suite: 'x', status: 'pass' }));
    expect(readRaw(dir).map((r) => r.id)).toEqual(['a']);
  });
});

describe('declared assertions', () => {
  it('finds every assertion() in the suites, by source', () => {
    const d = declaredAssertions();
    for (const id of ['digest.cid-drisl-plain', 'records.commit-fields', 'info.unknown-method-status']) expect(d.has(id), id).toBe(true);
    expect(declaredAssertions(['digest']).has('records.commit-fields')).toBe(false);
  });
});

describe('scoring', () => {
  const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
  const byId = new Map(cat.assertions.map((a) => [a.id, a]));
  // mac set pending, so the provisional path stays covered now the shipped vectors are all cleared.
  const areas = vectorStatus();
  areas.set('mac', { area: 'mac', pending: true, pendingVectors: ['mac.json: x'] });

  it('scores must rows per role, counts deviations as not passing, and leaves out provisional, info and skipped rows', () => {
    const results: RawResult[] = [
      { id: 'digest.cid-drisl-plain', suite: 'digest', status: 'pass' }, // cbor: cross-checked, scored
      { id: 'records.commit-fields', suite: 'records', status: 'fail' }, // no areas, scored
      { id: 'records.params-repo', suite: 'records', status: 'fail' }, // listed below: known deviation
      { id: 'mac.commit-valid', suite: 'mac', status: 'fail' }, // mac pending: provisional, excluded
      { id: 'info.unknown-method-status', suite: 'records', status: 'pass' }, // info: never scored
      { id: 'lifecycle.implicit-create', suite: 'lifecycle', status: 'skip', skip_reason: 'role' },
    ];
    const { judged, summary } = judgeAll(results, byId, new Map([['records.params-repo', {}]]), areas, ['repo-host', 'space-host']);
    expect(summary.by_role['repo-host']).toEqual({ must_applicable: 3, must_pass: 1, should_applicable: 0, should_pass: 0 });
    expect(summary.unexpected).toBe(1); // only records.commit-fields
    expect(judged.find((j) => j.id === 'mac.commit-valid')).toMatchObject({ display: 'fail (provisional)', gate: 'warn' });
    expect(judged.find((j) => j.id === 'records.params-repo')).toMatchObject({ display: 'known deviation', gate: 'ok' });
  });

  it('counts a fixed, still listed result as a pass but gates on it', () => {
    const { judged, summary } = judgeAll([{ id: 'records.commit-fields', status: 'pass' }], byId, new Map([['records.commit-fields', {}]]), areas, ['repo-host']);
    expect(summary.by_role['repo-host']!.must_pass).toBe(1);
    expect(judged[0].display).toBe('fixed, still listed');
    expect(summary.unexpected).toBe(1);
  });
});

describe('expect on deviations', () => {
  const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
  const byId = new Map(cat.assertions.map((a) => [a.id, a]));
  const expectation = { message: 'following cursor with limit=2 returned p0 \\d+ times, not once', evidence: { pages: '\\[2,2\\]' } };
  const listed = new Map([['records.commit-fields', { expect: expectation }]]);
  const run = (message: string, evidence?: Record<string, unknown>) =>
    judgeAll([{ id: 'records.commit-fields', status: 'fail', message, evidence }], byId, listed, vectorStatus(), ['repo-host']);

  it('keeps a fail that matches as a known deviation', () => {
    const { judged, summary } = run('following cursor with limit=2 returned p0 2 times, not once', { pages: '[2,2]' });
    expect(judged[0]).toMatchObject({ display: 'known deviation', gate: 'ok' });
    expect(judged[0].changed).toBeUndefined();
    expect(summary.unexpected).toBe(0);
  });

  it('fails the gate on another message, even one that only contains the expected text', () => {
    const { judged, summary } = run('before: following cursor with limit=2 returned p0 2 times, not once', { pages: '[2,2]' });
    expect(judged[0]).toMatchObject({ display: 'deviation changed', gate: 'fail', changed: expect.stringMatching(/^message/) });
    expect(summary.unexpected).toBe(1);
  });

  it('fails the gate on a message with extra text after the expected one', () => {
    const { judged } = run('following cursor with limit=2 returned p0 2 times, not once; and more', { pages: '[2,2]' });
    expect(judged[0]).toMatchObject({ display: 'deviation changed', gate: 'fail', changed: expect.stringMatching(/^message/) });
  });

  it('fails the gate on evidence with extra text after the expected value', () => {
    expect(run('following cursor with limit=2 returned p0 2 times, not once', { pages: '[2,2]x' }).judged[0]).toMatchObject({ display: 'deviation changed' });
  });

  it('refuses a pattern that would escape its anchors', () => {
    expect(() => wholeMatch('x)|(.*')).toThrow(SyntaxError);
  });

  it('fails the gate on different or missing evidence', () => {
    expect(run('following cursor with limit=2 returned p0 2 times, not once', { pages: '[2,1]' }).judged[0]).toMatchObject({
      display: 'deviation changed',
      changed: 'evidence pages doesn\'t match /\\[2,2\\]/',
    });
    expect(run('following cursor with limit=2 returned p0 2 times, not once').judged[0]).toMatchObject({ changed: 'evidence has no pages' });
  });

  it('matches non-string evidence as JSON', () => {
    const l = new Map([['records.commit-fields', { expect: { message: 'x', evidence: { status: '404' } } }]]);
    const j = judgeAll([{ id: 'records.commit-fields', status: 'fail', message: 'x', evidence: { status: 404 } }], byId, l, vectorStatus(), ['repo-host']);
    expect(j.judged[0].display).toBe('known deviation');
  });

  it('leaves an error as an error, whatever the entry expects', () => {
    const j = judgeAll([{ id: 'records.commit-fields', status: 'error', message: 'setup failed' }], byId, listed, vectorStatus(), ['repo-host']);
    expect(j.judged[0]).toMatchObject({ display: 'error', gate: 'fail' });
    expect(j.judged[0].changed).toBeUndefined();
  });

  it('judges an entry without expect, from a result file that predates it, as before', () => {
    const j = judgeAll([{ id: 'records.commit-fields', status: 'fail', message: 'anything' }], byId, new Map([['records.commit-fields', {}]]), vectorStatus(), ['repo-host']);
    expect(j.judged[0].display).toBe('known deviation');
  });
});

describe('per-assertion digests (HAP-432)', () => {
  const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
  const base = cat.assertions.find((a) => a.id === 'digest.cid-drisl-plain')!;

  it('changes with the row and with its test source, not with key order', () => {
    const d = assertionDigest(base, 'src');
    expect(assertionDigest({ ...base, checks: `${base.checks} more` }, 'src')).not.toBe(d);
    expect(assertionDigest(base, 'src2')).not.toBe(d);
    expect(assertionDigest(base, 'src', 'pin other')).not.toBe(d);
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as typeof base;
    expect(assertionDigest(reordered, 'src')).toBe(d);
  });

  it('folds in the revision pins and the vector files of the row\'s areas', () => {
    const one = (a: typeof base, rev: string) => assertionDigests({ ...cat, assertions: [a] }, rev, new Map())[a.id];
    const plain = { ...base, variants: undefined, until: undefined, since: undefined };
    // The same row, unchanged, digests differently at each pinned revision.
    expect(one(plain, '2026-10-29')).not.toBe(one(plain, '2026-11-12'));
    // A row's areas bring their vector files in; a row with none digests without them.
    expect(one({ ...plain, areas: ['cbor'] }, '2026-10-29')).not.toBe(one({ ...plain, areas: [] }, '2026-10-29'));
    expect(one({ ...plain, areas: ['cbor'] }, '2026-10-29')).not.toBe(one({ ...plain, areas: ['star'] }, '2026-10-29'));
  });

  it('covers exactly the rows that apply at a revision', () => {
    for (const rev of ['2026-10-29', '2026-11-12']) expect(Object.keys(assertionDigests(cat, rev)).length).toBe(resolveCatalogue(cat, rev).length);
  });
});

describe('the shipped deviation lists', () => {
  // Each list's expect must describe the failure its newest committed parity run recorded.
  const fixtures = readdirSync(join(ROOT, 'test', 'fixtures', 'results'));
  const impls = readdirSync(join(ROOT, 'implementations')).filter((id) => existsSync(join(ROOT, 'implementations', id, 'deviations.yaml')));
  const newestParity = (impl: string) =>
    fixtures
      .filter((f) => f.startsWith(`parity-${impl}-`) && /^\d{4}-\d{2}-\d{2}\.json$/.test(f.slice(`parity-${impl}-`.length)))
      .sort()
      .at(-1);

  it('covers every implementation that ships a list', () => {
    expect(impls.length).toBeGreaterThan(0);
    for (const impl of impls) expect(newestParity(impl), impl).toBeDefined();
  });

  it.each(impls)('%s matches its newest parity run', (impl) => {
    const list = loadDeviations(join(ROOT, 'implementations', impl, 'deviations.yaml'));
    const run = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'results', newestParity(impl)!), 'utf8'));
    const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
    const { judged } = judgeAll(run.results, new Map(cat.assertions.map((a) => [a.id, a])), new Map(list.map((d) => [d.assertion, d])), vectorStatus(), run.implementation.roles);
    for (const d of list) expect(judged.find((j) => j.id === d.assertion)).toMatchObject({ display: 'known deviation' });
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

  it('grades the revision it is given, and records a digest per row that applies there', () => {
    const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
    const ended = cat.assertions.find((a) => a.until === '2026-10-29')!;
    const env = {
      CONFORMANCE_IMPL: 'reference',
      CONFORMANCE_RUN_ID: '2026-11-13T05-24-57Z-reference-d3e5',
      CONFORMANCE_IMAGES: JSON.stringify({ reference: `ghcr.io/x/y@sha256:${'a'.repeat(64)}` }),
      SUITE_COMMIT: 'abc1234',
      CONFORMANCE_REVISION: '2026-11-12',
    };
    const raw: RawResult[] = [
      { id: 'digest.cid-drisl-plain', suite: 'digest', status: 'pass', ms: 10 },
      { id: ended.id, suite: ended.suite, status: 'skip', skip_reason: 'not in revision 2026-11-12' },
    ];
    const file = assemble(env, { accounts: 'create-account', spaces: 'simplespace' }, raw);
    expect(validateResults(file, 'r', cat)).toEqual([]);
    expect(file.spec).toMatchObject({ revision: '2026-11-12', commit: '2755e73a31', lexicons: 'atproto@d4def6e9' });
    expect(file.suite.assertion_digests['digest.cid-drisl-plain']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(file.suite.assertion_digests).not.toHaveProperty(ended.id);
  });

  it('skips a declared row that does not apply at the run\'s revision', () => {
    const out = reconcile([], new Map(), new Map([['x.gone', 'suites/x/a.test.ts']]), new Map(), (id) => (id === 'x.gone' ? 'not in revision 2026-11-12' : null), () => 'x');
    expect(out).toEqual([{ id: 'x.gone', suite: 'x', status: 'skip', skip_reason: 'not in revision 2026-11-12' }]);
  });

  it('caps evidence at 4 KiB of UTF-8, not UTF-16 units', () => {
    const e = capEvidence({ body: 'x'.repeat(10_000), status: 400 });
    expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(4096);
    expect(e.status).toBe(400);
    const wide = capEvidence({ body: '世'.repeat(2000) }); // 2000 units but 6000 bytes
    expect(Buffer.byteLength(JSON.stringify(wide))).toBeLessThanOrEqual(4096);
  });

  it('accepts a rerun with previous attempts and a flaky pass, and refuses evidence over 4 KiB in bytes', () => {
    const env = { CONFORMANCE_IMPL: 'reference', CONFORMANCE_RUN_ID: '2026-11-10T05-24-57Z-reference-d3e5', CONFORMANCE_IMAGES: JSON.stringify({ reference: `ghcr.io/x/y@sha256:${'a'.repeat(64)}` }), SUITE_COMMIT: 'abc1234' };
    const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
    const file: any = assemble(env, { accounts: 'create-account', spaces: 'simplespace' }, [{ id: 'records.commit-fields', suite: 'records', status: 'pass' }]);
    file.run.previous_attempts = [{ id: 'earlier', failed: ['records.commit-fields'], errored: [] }];
    file.results[0].flaky = { attempt: 1, status: 'fail', run: 'earlier' };
    expect(validateResults(file, 'r', cat)).toEqual([]);
    const big: any = assemble(env, { accounts: 'create-account', spaces: 'simplespace' }, [{ id: 'records.commit-fields', suite: 'records', status: 'fail', evidence: { b: '世'.repeat(1500) } }]);
    expect(validateResults(big, 'r', cat).map((p) => p.message)).toContain('evidence is over 4096 bytes');
  });
});
