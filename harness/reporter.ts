// The Vitest reporter: at the end of a run, assembles the raw results the
// assertion() helper recorded into one results file (design ch. 7.1),
// validates it against schemas/results.schema.json and writes it.
//
// Run metadata comes from the environment cli/run.ts sets: CONFORMANCE_IMPL,
// CONFORMANCE_RUN_ID, CONFORMANCE_RUN_KIND, CONFORMANCE_STARTED_AT,
// CONFORMANCE_ATTEMPT, SUITE_COMMIT, CONFORMANCE_IMAGES (JSON: id -> image),
// CONFORMANCE_PEERS (JSON list), CONFORMANCE_DEVIATIONS (a file path).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Reporter } from 'vitest/node';
import type { SetupMode } from './adapter.ts';
import type { RawResult } from './assert.ts';
import { rawDir } from './assert.ts';
import { loadCatalogue } from './catalogue.ts';
import { type Deviation, loadDeviations } from './deviations.ts';
import { loadManifest } from './manifest.ts';
import { formatProblem } from './problems.ts';
import { vectorStatus } from './provisional.ts';
import { validateResults } from './results.ts';
import { ROOT } from './schema.ts';
import { loadRevisions } from './spec.ts';
import { judgeAll } from './verdict.ts';

export function readRaw(dir = rawDir()): RawResult[] {
  if (!existsSync(dir)) return [];
  const byId = new Map<string, RawResult>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl')))
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)) {
      const r: RawResult = JSON.parse(line);
      byId.set(r.id, r); // a retried test keeps its last result
    }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function assemble(env: NodeJS.ProcessEnv, setupMode: SetupMode, raw = readRaw()) {
  const implId = env.CONFORMANCE_IMPL!;
  const manifest = loadManifest(join(ROOT, 'implementations', implId, 'manifest.yaml'));
  const catalogue = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
  const revs = loadRevisions();
  const rev = revs.revisions[catalogue.revision];
  const images: Record<string, string> = JSON.parse(env.CONFORMANCE_IMAGES ?? '{}');
  const deviations: Deviation[] = env.CONFORMANCE_DEVIATIONS ? loadDeviations(env.CONFORMANCE_DEVIATIONS) : [];
  const ran = new Set(raw.map((r) => r.id));
  const applied = deviations.filter((d) => ran.has(d.assertion));
  const { summary } = judgeAll(
    raw,
    new Map(catalogue.assertions.map((a) => [a.id, a])),
    new Set(applied.map((d) => d.assertion)),
    vectorStatus(),
    manifest.roles,
  );
  return {
    schema: 1,
    run: {
      id: env.CONFORMANCE_RUN_ID!,
      kind: (env.CONFORMANCE_RUN_KIND ?? 'local') as 'local',
      started_at: env.CONFORMANCE_STARTED_AT ?? new Date().toISOString(),
      finished_at: new Date().toISOString(),
      attempt: Number(env.CONFORMANCE_ATTEMPT ?? 1),
      ...(env.CONFORMANCE_CI_URL ? { ci_url: env.CONFORMANCE_CI_URL } : {}),
    },
    suite: {
      commit: env.SUITE_COMMIT ?? '0000000',
      assertions_digest: `sha256:${createHash('sha256').update(readFileSync(join(ROOT, 'spec', 'assertions.yaml'))).digest('hex')}`,
    },
    spec: { proposal: rev.proposal, revision: catalogue.revision, commit: rev.commit.slice(0, 10), lexicons: `atproto@${rev.lexicons.commit.slice(0, 8)}` },
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
  async onTestRunEnd() {
    const env = process.env;
    if (!env.CONFORMANCE_IMPL || !env.CONFORMANCE_RUN_ID) return;
    const manifest = loadManifest(join(ROOT, 'implementations', env.CONFORMANCE_IMPL, 'manifest.yaml'));
    const { adapter } = await import(join(ROOT, 'implementations', env.CONFORMANCE_IMPL, manifest.setup!));
    const file = assemble(env, adapter.setupMode);
    const problems = validateResults(file, 'results', loadCatalogue(join(ROOT, 'spec', 'assertions.yaml')));
    const outDir = env.CONFORMANCE_OUT_DIR ?? join(ROOT, 'results-local');
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, `${env.CONFORMANCE_RUN_ID}.json`);
    writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
    if (problems.length) {
      for (const p of problems) console.error(formatProblem(p));
      throw new Error(`results file ${out} failed validation (${problems.length} problems)`);
    }
    console.log(`conformance: wrote ${out} (${file.results.length} results)`);
  }
}
