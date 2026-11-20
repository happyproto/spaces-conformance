// Which scenarios the nightly run grades (Trezy, Nov 19): only those whose
// inputs changed. A scenario is skipped when the store already has a run
// with its fingerprint (harness/fingerprint.ts), no error and no
// infrastructure failure on an earlier attempt; a candidate run
// counts, so once a pin PR merges, the next nightly doesn't regrade it.
//
//   node cli/ci/plan.ts [--store <dir>] [--force] [--only a,b]
//
// Prints `implementations=<JSON list>` for $GITHUB_OUTPUT on the first line,
// then a Markdown summary (what runs, what's unchanged and since when).
// With no store (no results branch yet), everything runs. --force runs
// everything given, unchanged or not. --only limits the list.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { scenarioFingerprint } from '../../harness/fingerprint.ts';
import type { ImplIndex } from '../../harness/store.ts';
import { ROOT } from '../../harness/schema.ts';

const { values } = parseArgs({ options: { store: { type: 'string' }, force: { type: 'boolean', default: false }, only: { type: 'string' } } });
const all = readdirSync(join(ROOT, 'implementations'))
  .filter((d) => existsSync(join(ROOT, 'implementations', d, 'manifest.yaml')))
  .sort();
const only = values.only ? values.only.split(',').map((s) => s.trim()).filter(Boolean) : all;
for (const id of only) if (!all.includes(id)) {
  console.error(`${id} is not an implementation`);
  process.exit(2);
}

const run: string[] = [];
const lines: string[] = [];
for (const id of only) {
  const fp = scenarioFingerprint(id, { slow: true });
  const index = values.store ? join(values.store, 'index', `${id}.json`) : '';
  const runs: ImplIndex['runs'] = index && existsSync(index) ? (JSON.parse(readFileSync(index, 'utf8')) as ImplIndex).runs : [];
  // A run with an error, or one rerun after an infrastructure failure, is no result.
  const same = runs.find((r) => r.fingerprint === fp.digest && r.counts.error === 0 && !r.infrastructure);
  if (same && !values.force) {
    lines.push(`- \`${id}\`: unchanged, last graded by \`${same.id}\` (${same.kind}) on ${same.started_at.slice(0, 10)}`);
  } else {
    run.push(id);
    lines.push(`- \`${id}\`: ${values.force ? 'forced' : runs.length ? 'inputs changed' : 'never graded'} (\`${fp.digest.slice(7, 19)}\`)`);
  }
}
console.log(`implementations=${JSON.stringify(run)}`);
console.log(`### Nightly plan\n\n${run.length} to run, ${only.length - run.length} unchanged.\n\n${lines.join('\n')}`);
