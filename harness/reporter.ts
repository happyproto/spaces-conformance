// The Vitest reporter: at the end of a run, assembles the raw results the
// assertion() helper recorded into one results file (design ch. 7.1),
// validates it against schemas/results.schema.json and writes it.
//
// Run metadata comes from the environment cli/run.ts sets: CONFORMANCE_IMPL,
// CONFORMANCE_RUN_ID, CONFORMANCE_RUN_KIND, CONFORMANCE_STARTED_AT,
// CONFORMANCE_ATTEMPT, SUITE_COMMIT, CONFORMANCE_IMAGES (JSON: id -> image),
// CONFORMANCE_PEERS (JSON list), CONFORMANCE_DEVIATIONS (a file path),
// CONFORMANCE_REVISION (the revision graded; default the manifest's first).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Reporter, TestModule } from 'vitest/node';
import type { SetupMode } from './adapter.ts';
import type { RawResult } from './assert.ts';
import { rawDir } from './assert.ts';
import { loadCatalogue, resolveCatalogue } from './catalogue.ts';
import { assertionDigests } from './digests.ts';
import { type Deviation, deviationsAt, loadDeviations } from './deviations.ts';
import { loadManifest, notApplicable } from './manifest.ts';
import { declaredAssertions } from './coverage.ts';
import { formatProblem } from './problems.ts';
import { loadIndependence } from './independence.ts';
import { vectorStatus } from './provisional.ts';
import { validateResults } from './results.ts';
import { ROOT } from './schema.ts';
import { loadRevisions } from './spec.ts';
import { judgeAll } from './verdict.ts';

/** Every raw record, in file order. Duplicates are kept so reconcile() can flag them. */
export function readRaw(dir = rawDir()): RawResult[] {
  if (!existsSync(dir)) return [];
  const out: RawResult[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.endsWith('.setup.jsonl')).sort())
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)) out.push(JSON.parse(line));
  return out;
}

/** Setup steps each assertion started but never finished, from setup()'s markers. */
export function openSetupSteps(dir = rawDir()): Map<string, string> {
  const open = new Map<string, string[]>();
  if (!existsSync(dir)) return new Map();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.setup.jsonl')).sort())
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)) {
      const m: { id: string; step: string; phase: 'start' | 'end' } = JSON.parse(line);
      const steps = open.get(m.id) ?? [];
      if (m.phase === 'start') steps.push(m.step);
      else steps.splice(steps.lastIndexOf(m.step), 1);
      open.set(m.id, steps);
    }
  return new Map([...open].filter(([, s]) => s.length).map(([id, s]) => [id, s[s.length - 1]]));
}

/** What Vitest says happened to one test, keyed by test name (the assertion id). */
export interface CaseOutcome {
  state: 'passed' | 'failed' | 'skipped' | 'pending';
  errors: string[];
}

const TIMEOUT = /timed out/i;

/**
 * Reconcile the raw records with what Vitest saw, so no result vanishes:
 *  - a test Vitest failed but whose record says pass (it finished after its
 *    timeout), or that recorded nothing, is `fail` on a timeout and `error` otherwise;
 *  - a declared assertion with no record and no test case (its file failed to
 *    import, a hook threw) is `error`, or `skip` if it doesn't apply;
 *  - an id recorded twice is `error`;
 *  - module-level errors are attached to every assertion that file declares.
 */
export function reconcile(
  raw: RawResult[],
  cases: Map<string, CaseOutcome>,
  declared: Map<string, string>,
  moduleErrors: Map<string, string>,
  skipReason: (id: string) => string | null,
  suiteOf: (id: string) => string,
  openSetup: Map<string, string> = new Map(),
): RawResult[] {
  const byId = new Map<string, RawResult>();
  const dupes = new Set<string>();
  for (const r of raw) {
    if (byId.has(r.id)) dupes.add(r.id);
    byId.set(r.id, r);
  }
  const ids = new Set([...declared.keys(), ...byId.keys(), ...cases.keys()]);
  const out: RawResult[] = [];
  for (const id of [...ids].sort()) {
    const rec = byId.get(id);
    const c = cases.get(id);
    const suite = rec?.suite ?? suiteOf(id);
    if (dupes.has(id)) {
      out.push({ id, suite, status: 'error', message: 'recorded more than once in one run' });
      continue;
    }
    if (c?.state === 'failed' && (!rec || rec.status === 'pass' || rec.status === 'skip')) {
      const msg = c.errors.join('; ').slice(0, 500) || 'the test failed without recording a result';
      const step = openSetup.get(id);
      // A timeout is the host's fault (fail) unless it hit during ungraded setup.
      if (step) out.push({ id, suite, status: 'error', ms: rec?.ms, message: `timed out during setup step ${step}: ${msg}`.slice(0, 500), evidence: { step } });
      else out.push({ id, suite, status: TIMEOUT.test(msg) ? 'fail' : 'error', ms: rec?.ms, message: msg });
      continue;
    }
    if (rec) {
      out.push(rec);
      continue;
    }
    const why = skipReason(id);
    if (why) {
      out.push({ id, suite, status: 'skip', skip_reason: why });
      continue;
    }
    const file = declared.get(id);
    const modErr = file ? moduleErrors.get(file) : undefined;
    out.push({ id, suite, status: 'error', message: modErr ? `${file} failed to load: ${modErr}`.slice(0, 500) : 'no result recorded: the test did not run' });
  }
  return out;
}

export function assemble(env: NodeJS.ProcessEnv, setupMode: SetupMode, raw: RawResult[]) {
  const implId = env.CONFORMANCE_IMPL!;
  const manifest = loadManifest(join(ROOT, 'implementations', implId, 'manifest.yaml'));
  const catalogue = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
  const revision = env.CONFORMANCE_REVISION ?? manifest.spec_revisions[0];
  const rev = loadRevisions().revisions[revision];
  if (!rev) throw new Error(`revision ${revision} is not in spec/revisions.json`);
  const images: Record<string, string> = JSON.parse(env.CONFORMANCE_IMAGES ?? '{}');
  const deviations: Deviation[] = env.CONFORMANCE_DEVIATIONS ? deviationsAt(loadDeviations(env.CONFORMANCE_DEVIATIONS), revision) : [];
  // Only entries for assertions that have a result this run: results.ts
  // refuses a deviation with no result. The full list stays in its own file.
  const ran = new Set(raw.map((r) => r.id));
  const applied = deviations.filter((d) => ran.has(d.assertion));
  const { summary } = judgeAll(
    raw,
    new Map(resolveCatalogue(catalogue, revision).map((a) => [a.id, a])),
    new Map(applied.map((d) => [d.assertion, d])),
    vectorStatus(),
    manifest.roles,
    loadIndependence(revision),
  );
  return {
    schema: 1,
    run: {
      id: env.CONFORMANCE_RUN_ID!,
      kind: (env.CONFORMANCE_RUN_KIND ?? 'local') as 'local',
      started_at: env.CONFORMANCE_STARTED_AT ?? new Date().toISOString(),
      finished_at: new Date().toISOString(),
      attempt: Number(env.CONFORMANCE_ATTEMPT ?? 1),
      slow: env.CONFORMANCE_SLOW === '1',
      ...(env.CONFORMANCE_CI_URL ? { ci_url: env.CONFORMANCE_CI_URL } : {}),
    },
    suite: {
      commit: env.SUITE_COMMIT ?? '0000000',
      assertions_digest: `sha256:${createHash('sha256').update(readFileSync(join(ROOT, 'spec', 'assertions.yaml'))).digest('hex')}`,
      assertion_digests: assertionDigests(catalogue, revision),
    },
    spec: { proposal: rev.proposal, revision, commit: rev.commit.slice(0, 10), lexicons: `atproto@${rev.lexicons.commit.slice(0, 8)}` },
    implementation: {
      id: implId,
      image: images[implId],
      roles: manifest.roles,
      profile: manifest.profile,
      write_auth: manifest.accounts.write_auth,
      setup_mode: setupMode,
    },
    peers: JSON.parse(env.CONFORMANCE_PEERS ?? '[]'),
    deviations_applied: applied,
    results: raw,
    summary,
  };
}

export default class ConformanceReporter implements Reporter {
  async onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    const env = process.env;
    if (!env.CONFORMANCE_IMPL || !env.CONFORMANCE_RUN_ID) return;
    const manifest = loadManifest(join(ROOT, 'implementations', env.CONFORMANCE_IMPL, 'manifest.yaml'));
    const catalogue = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
    const revision = env.CONFORMANCE_REVISION ?? manifest.spec_revisions[0];
    const rows = new Map(catalogue.assertions.map((a) => [a.id, a]));
    const byId = new Map(resolveCatalogue(catalogue, revision).map((a) => [a.id, a]));
    const { adapter } = await import(join(ROOT, 'implementations', env.CONFORMANCE_IMPL, manifest.setup!));

    const cases = new Map<string, CaseOutcome>();
    const moduleErrors = new Map<string, string>();
    for (const m of testModules) {
      const errs = m.errors().map((e) => e.message);
      if (errs.length) moduleErrors.set(relative(ROOT, m.moduleId), errs.join('; '));
      for (const t of m.children.allTests()) {
        const r = t.result();
        cases.set(t.name, { state: r.state, errors: (r.errors ?? []).map((e) => e.message) });
      }
    }
    const suites = env.CONFORMANCE_SUITES ? env.CONFORMANCE_SUITES.split(',') : undefined;
    const results = reconcile(
      readRaw(),
      cases,
      declaredAssertions(suites),
      moduleErrors,
      (id) => {
        const a = byId.get(id);
        if (!a) return rows.has(id) ? `not in revision ${revision}` : null;
        return notApplicable(a, manifest);
      },
      (id) => rows.get(id)?.suite ?? 'records',
      openSetupSteps(),
    );
    const file = assemble(env, adapter.setupMode(manifest), results);
    const problems = validateResults(file, 'results', catalogue);
    const outDir = env.CONFORMANCE_OUT_DIR ?? join(ROOT, 'results-local');
    mkdirSync(outDir, { recursive: true });
    if (problems.length) {
      // Never leave an invalid file where verdict or the site would read it.
      // Vitest exits 1 regardless; cli/run.ts finds the .invalid.json and names the step.
      const bad = join(outDir, `${env.CONFORMANCE_RUN_ID}.invalid.json`);
      writeFileSync(bad, `${JSON.stringify(file, null, 2)}\n`);
      for (const p of problems) console.error(formatProblem(p));
      throw new Error(`results failed validation (${problems.length} problems); wrote ${bad}`);
    }
    const out = join(outDir, `${env.CONFORMANCE_RUN_ID}.json`);
    writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
    console.log(`conformance: wrote ${out} (${file.results.length} results)`);
  }
}
