// `conformance run <impl>`: the stack runner (design ch. 6.1, 4.4 rule 7).
//
//   node cli/run.ts reference                 run every suite, then tear down
//   node cli/run.ts happyview --keep          leave the stack up afterwards
//   node cli/run.ts pdsjs --suites digest,records --deviations path.yaml
//
// It brings up base + the implementation's fragment (+ its partner's), runs
// the implementation's bootstrap.sh if it has one, runs the suites inside the
// harness container, and writes results-local/<run-id>.json. A run with any
// `error` result is rerun once on a fresh stack; the second attempt stands.

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadManifest } from '../harness/manifest.ts';
import { ROOT } from '../harness/schema.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    keep: { type: 'boolean', default: false },
    suites: { type: 'string' },
    deviations: { type: 'string' },
    kind: { type: 'string', default: 'local' },
    'no-retry': { type: 'boolean', default: false },
  },
});
const impl = positionals[0];
if (!impl) {
  console.error('usage: node cli/run.ts <implementation> [--keep] [--suites a,b] [--deviations file] [--kind local]');
  process.exit(2);
}
const manifest = loadManifest(join(ROOT, 'implementations', impl, 'manifest.yaml'));
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

function attempt(n: number): { runId: string; out: string; errors: number } {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  const runId = `${stamp}-${impl}-${randomBytes(2).toString('hex')}`;
  const startedAt = new Date().toISOString();
  console.log(`\n=== ${runId} (attempt ${n})`);
  try {
    if (dc(['up', '-d', '--wait', '--build']).status !== 0) throw new Error('the stack did not come up healthy');
    const bootstrap = join(ROOT, 'implementations', impl, 'bootstrap.sh');
    if (existsSync(bootstrap)) {
      const r = spawnSync('sh', [bootstrap], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, COMPOSE: `docker compose -p ${project} --env-file pins/images.env ${files.map((f) => `-f ${f}`).join(' ')}` } });
      if (r.status !== 0) throw new Error(`${impl}/bootstrap.sh failed`);
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
      ...(deviations ? { CONFORMANCE_DEVIATIONS: `/suite/${deviations}` } : {}),
      ...(process.env.CONFORMANCE_CI_URL ? { CONFORMANCE_CI_URL: process.env.CONFORMANCE_CI_URL } : {}),
    };
    const suites = values.suites ? values.suites.split(',').map((s) => `suites/${s}`) : [];
    // Vitest exits non-zero whenever an assertion fails; that's a result, not a runner failure.
    dc(['exec', '-T', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'harness', 'node_modules/.bin/vitest', 'run', '--config', 'vitest.suite.config.ts', ...suites]);
  } finally {
    if (!values.keep) dc(['down', '-v'], { stdio: 'pipe' });
  }
  const out = join(ROOT, 'results-local', `${runId}.json`);
  if (!existsSync(out)) throw new Error(`no results file at ${out}: the reporter didn't run or failed validation`);
  const errors = JSON.parse(readFileSync(out, 'utf8')).results.filter((r: { status: string }) => r.status === 'error').length;
  return { runId, out, errors };
}

let run = attempt(1);
if (run.errors && !values['no-retry']) {
  console.log(`\n${run.errors} result(s) were error; rerunning once on a fresh stack`);
  run = attempt(2);
}
console.log(`\nresults: ${run.out}`);
const v = spawnSync(process.execPath, [join(ROOT, 'cli', 'verdict.ts'), run.out, ...(deviations ? ['--deviations', deviations] : [])], { stdio: 'inherit' });
process.exit(v.status ?? 1);
