// `conformance verdict <results.json> [--deviations file]`: display states and
// the CI gate (design ch. 4.4). Exits 1 on any unexpected result: an
// unlisted non-provisional fail, a non-provisional pass that's still
// listed, or an error. Provisional results and deviations only warn.
//
// --deviations replaces the list embedded in the results file, so a PR's own
// deviation list can be judged against a run (design ch. 6.4).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCatalogue } from '../harness/catalogue.ts';
import { loadDeviations } from '../harness/deviations.ts';
import { vectorStatus } from '../harness/provisional.ts';
import { ROOT } from '../harness/schema.ts';
import { judgeAll } from '../harness/verdict.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { deviations: { type: 'string' }, json: { type: 'boolean', default: false } } });
if (!positionals[0]) {
  console.error('usage: node cli/verdict.ts <results.json> [--deviations file] [--json]');
  process.exit(2);
}
const file = JSON.parse(readFileSync(positionals[0], 'utf8'));
const catalogue = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
const byId = new Map(catalogue.assertions.map((a) => [a.id, a]));
const deviations: { assertion: string; cause: string; tracking: string }[] = values.deviations ? loadDeviations(values.deviations) : file.deviations_applied;
const listed = new Set(deviations.map((d) => d.assertion));
const { judged, summary } = judgeAll(file.results, byId, listed, vectorStatus(), file.implementation.roles);

if (values.json) {
  console.log(JSON.stringify({ judged, summary }, null, 2));
} else {
  const messages = new Map<string, string>(file.results.map((r: { id: string; message?: string; skip_reason?: string }) => [r.id, r.message ?? r.skip_reason ?? '']));
  const mark = { ok: ' ', warn: '!', fail: '✗' } as const;
  console.log(`\n${file.implementation.id} @ ${file.implementation.image}`);
  console.log(`spec ${file.spec.proposal} ${file.spec.revision} (${file.spec.commit}), suite ${file.suite.commit}, setup ${JSON.stringify(file.implementation.setup_mode)}\n`);
  for (const j of judged) {
    const why = j.provisional && j.display !== 'not applicable' ? ` [provisional: ${j.provisional}]` : '';
    console.log(`${mark[j.gate]} ${j.display.padEnd(20)} ${j.id.padEnd(40)} ${(messages.get(j.id) ?? '').slice(0, 100)}${why}`);
  }
  console.log('');
  for (const [role, s] of Object.entries(summary.by_role)) {
    const pct = (p: number, n: number) => (n ? `${Math.round((100 * p) / n)}%` : 'n/a');
    console.log(`${role}: must ${s!.must_pass}/${s!.must_applicable} (${pct(s!.must_pass, s!.must_applicable)}), should ${s!.should_pass}/${s!.should_applicable}`);
  }
  const warns = judged.filter((j) => j.gate === 'warn').length;
  console.log(`\n${summary.unexpected} unexpected, ${warns} warning(s)`);
}
process.exit(summary.unexpected ? 1 : 0);
