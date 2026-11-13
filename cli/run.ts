// `conformance run <impl>`: the stack runner (design ch. 6.1, 4.4 rule 7).
//
//   node cli/run.ts reference                 run every suite, then tear down
//   node cli/run.ts happyview --keep          leave the stack up afterwards
//   node cli/run.ts pdsjs --suites digest,records --deviations path.yaml
//   node cli/run.ts zds --setup-mode oct29    space creation through Oct 29 createSpace
//   node cli/run.ts happyview --revision 2026-11-12   grade another revision it claims
//
// It brings up base + the implementation's fragment (+ its partner's), runs
// the implementation's bootstrap.sh if it has one, runs the suites inside the
// harness container, and writes results-local/<run-id>.json. A run with any
// `error` result, or whose stack or bootstrap failed, is rerun once on a fresh
// stack. --setup-mode picks how spaces are created (oct29, simplespace or
// auto; default: the manifest's spaces.create), and the run records it as
// setup_mode. --revision picks the spec revision to grade (default: the first
// of the manifest's spec_revisions); a run grades exactly one. The second attempt stands, but it keeps the first attempt's failing
// ids, and a fail-to-pass flip is marked flaky (it warns, never gates). Two
// infrastructure failures in a row exit 3 with the step that failed.

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCatalogue } from '../harness/catalogue.ts';
import { loadDeviations } from '../harness/deviations.ts';
import { loadManifest } from '../harness/manifest.ts';
import { formatProblem } from '../harness/problems.ts';
import { validateResults } from '../harness/results.ts';
import { loadRevisions } from '../harness/spec.ts';
import { checkSchema, ROOT } from '../harness/schema.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    keep: { type: 'boolean', default: false },
    suites: { type: 'string' },
    deviations: { type: 'string' },
    kind: { type: 'string', default: 'local' },
    'no-retry': { type: 'boolean', default: false },
    'setup-mode': { type: 'string' },
    revision: { type: 'string' },
  },
});
const impl = positionals[0];
if (!impl) {
  console.error('usage: node cli/run.ts <implementation> [--keep] [--suites a,b] [--deviations file] [--setup-mode oct29|simplespace|auto] [--revision key] [--kind local]');
  process.exit(2);
}
const manifest = loadManifest(join(ROOT, 'implementations', impl, 'manifest.yaml'));
const setupMode = values['setup-mode'];
if (setupMode) {
  const modes = manifest.spaces.modes ?? [manifest.spaces.create];
  if (!modes.includes(setupMode)) {
    console.error(`${impl}'s adapter supports setup modes ${modes.join(', ')}, not ${setupMode}`);
    process.exit(2);
  }
}
const revision = values.revision ?? manifest.spec_revisions[0];
if (!loadRevisions().revisions[revision]) {
  console.error(`revision ${revision} is not in spec/revisions.json`);
  process.exit(2);
}
// Grading a revision the implementation doesn't claim is allowed (it shows how far it is), but say so.
if (!manifest.spec_revisions.includes(revision)) console.warn(`note: ${impl} claims ${manifest.spec_revisions.join(', ')}, not ${revision}`);
const pins = Object.fromEntries(
  readFileSync(join(ROOT, 'pins', 'images.env'), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z][A-Z0-9_]*)=(\S+)/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1], m[2]]),
);

const ids = [impl, ...(manifest.accounts.partner ? [manifest.accounts.partner] : [])];
const files = ['implementations/base.compose.yml', ...ids.map((id) => `implementations/${id}/compose.yml`)];
const project = `conformance-${impl}`;
const dc = (args: string[], opts: { input?: string; stdio?: 'inherit' | 'pipe' } = {}) => {
  const r = spawnSync('docker', ['compose', '-p', project, '--env-file', 'pins/images.env', ...files.flatMap((f) => ['-f', f]), ...args], {
    cwd: ROOT,
    input: opts.input,
    stdio: opts.input !== undefined ? ['pipe', opts.stdio ?? 'inherit', 'inherit'] : (opts.stdio ?? 'inherit'),
    encoding: 'utf8',
  });
  return r;
};

const suiteCommit = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '0000000';
  }
})();
const imageOf = (id: string) => pins[loadManifest(join(ROOT, 'implementations', id, 'manifest.yaml')).image.pin];
const images = Object.fromEntries(ids.map((id) => [id, imageOf(id)]));
const peers = [
  ...(manifest.accounts.partner ? [{ id: manifest.accounts.partner, image: imageOf(manifest.accounts.partner) }] : []),
  { id: 'plc', image: pins.PLC_IMAGE },
];
const deviations =
  values.deviations ?? (typeof manifest.deviations === 'string' ? `implementations/${impl}/${manifest.deviations}` : undefined);
if (manifest.deviations && typeof manifest.deviations === 'object' && !values.deviations)
  console.warn(`note: ${impl}'s deviations live in ${manifest.deviations.repo}; pass --deviations to apply them`);
// Refuse a list without `expect` before the stack starts: an entry without it would cover any failure.
if (deviations) {
  const problems = checkSchema('deviations', loadDeviations(join(ROOT, deviations)), deviations);
  if (problems.length) {
    for (const p of problems) console.error(formatProblem(p));
    process.exit(2);
  }
}

type Outcome =
  | { kind: 'results'; runId: string; out: string; file: any }
  | { kind: 'infrastructure'; runId: string; step: string };

function attempt(n: number): Outcome {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  const runId = `${stamp}-${impl}-${randomBytes(2).toString('hex')}`;
  const startedAt = new Date().toISOString();
  console.log(`\n=== ${runId} (attempt ${n})`);
  try {
    if (dc(['up', '-d', '--wait', '--build']).status !== 0) return { kind: 'infrastructure', runId, step: 'stack: the stack did not come up healthy' };
    const bootstrap = join(ROOT, 'implementations', impl, 'bootstrap.sh');
    if (existsSync(bootstrap)) {
      const r = spawnSync('sh', [bootstrap], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, COMPOSE: `docker compose -p ${project} --env-file pins/images.env ${files.map((f) => `-f ${f}`).join(' ')}` } });
      if (r.status !== 0) return { kind: 'infrastructure', runId, step: `bootstrap: ${impl}/bootstrap.sh exited ${r.status}` };
    }
    const env: Record<string, string> = {
      CONFORMANCE_IMPL: impl,
      CONFORMANCE_RUN_ID: runId,
      CONFORMANCE_RUN_KIND: values.kind!,
      CONFORMANCE_STARTED_AT: startedAt,
      CONFORMANCE_ATTEMPT: String(n),
      CONFORMANCE_RAW_DIR: `/suite/results-local/raw/${runId}`,
      CONFORMANCE_OUT_DIR: '/suite/results-local',
      CONFORMANCE_IMAGES: JSON.stringify(images),
      CONFORMANCE_PEERS: JSON.stringify(peers),
      SUITE_COMMIT: suiteCommit,
      CONFORMANCE_REVISION: revision,
      ...(values.suites ? { CONFORMANCE_SUITES: values.suites } : {}),
      ...(setupMode ? { CONFORMANCE_SPACES_MODE: setupMode } : {}),
      ...(deviations ? { CONFORMANCE_DEVIATIONS: `/suite/${deviations}` } : {}),
      ...(process.env.CONFORMANCE_CI_URL ? { CONFORMANCE_CI_URL: process.env.CONFORMANCE_CI_URL } : {}),
    };
    const suites = values.suites ? values.suites.split(',').map((x) => `suites/${x}`) : [];
    const v = dc(['exec', '-T', ...Object.entries(env).flatMap(([k, val]) => ['-e', `${k}=${val}`]), 'harness', 'node_modules/.bin/vitest', 'run', '--config', 'vitest.suite.config.ts', ...suites]);
    // Vitest exits 1 when any assertion fails: that's a result. Anything else is the harness breaking.
    if (v.status !== 0 && v.status !== 1) return { kind: 'infrastructure', runId, step: `harness: vitest exited ${v.status}` };
  } finally {
    if (!values.keep) dc(['down', '-v'], { stdio: 'pipe' });
  }
  const out = join(ROOT, 'results-local', `${runId}.json`);
  if (!existsSync(out)) {
    const bad = join(ROOT, 'results-local', `${runId}.invalid.json`);
    return existsSync(bad)
      ? { kind: 'infrastructure', runId, step: `harness: results failed validation (${bad})` }
      : { kind: 'infrastructure', runId, step: 'harness: no results file was written (the reporter did not run)' };
  }
  const file = JSON.parse(readFileSync(out, 'utf8'));
  const problems = validateResults(file, out, loadCatalogue(join(ROOT, 'spec', 'assertions.yaml')));
  if (problems.length) return { kind: 'infrastructure', runId, step: `harness: results failed validation: ${problems.map(formatProblem).join('; ')}` };
  return { kind: 'results', runId, out, file };
}

const notPassing = (file: any, status: string) => file.results.filter((r: { status: string }) => r.status === status).map((r: { id: string }) => r.id);

const first = attempt(1);
let final = first;
const errored = first.kind === 'infrastructure' || notPassing(first.file, 'error').length > 0;
if (errored && !values['no-retry']) {
  console.log(`\n${first.kind === 'infrastructure' ? `infrastructure: ${first.step}` : `${notPassing(first.file, 'error').length} result(s) were error`}; rerunning once on a fresh stack`);
  final = attempt(2);
}
if (final.kind === 'infrastructure') {
  console.error(`\ninfrastructure: ${final.step}`);
  process.exit(3);
}
if (final !== first) {
  // Keep the first attempt visible: its non-passing ids, and any flip to pass.
  const f = final.file;
  if (first.kind === 'results') {
    const failed = notPassing(first.file, 'fail');
    const erroredIds = notPassing(first.file, 'error');
    f.run.previous_attempts = [{ id: first.runId, failed, errored: erroredIds }];
    for (const r of f.results)
      if (r.status === 'pass' && (failed.includes(r.id) || erroredIds.includes(r.id)))
        r.flaky = { attempt: 1, status: failed.includes(r.id) ? 'fail' : 'error', run: first.runId };
  } else f.run.infrastructure = first.step;
  const problems = validateResults(f, final.out, loadCatalogue(join(ROOT, 'spec', 'assertions.yaml')));
  if (problems.length) {
    console.error(problems.map(formatProblem).join('\n'));
    process.exit(3);
  }
  writeFileSync(final.out, `${JSON.stringify(f, null, 2)}\n`);
}
console.log(`\nresults: ${final.out}`);
const v = spawnSync(process.execPath, [join(ROOT, 'cli', 'verdict.ts'), final.out, ...(deviations ? ['--deviations', deviations] : [])], { stdio: 'inherit' });
process.exit(v.status ?? 1);
