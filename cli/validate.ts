// `bun run validate`: check every data file the suite ships against its
// schema and cross-references. Exits 1 on any problem. Nothing is scored.
//
//   spec/assertions.yaml               schema, level rule, quotes, anchors, lexicons
//   implementations/*/manifest.yaml    schema, pins, compose, partners
//   implementations/*/deviations.yaml  schema, ids exist, anchors
//   test/fixtures/results/*.json       results schema (examples of the format)
//   evidence/passes.json               matches what its source results files rebuild to (design S5)
//
// Pass more deviation or results files as arguments, e.g. HappyView's list:
//   node cli/validate.ts --deviations ../happyview/interop/conformance-deviations.yaml

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCatalogue, validateCatalogue } from '../harness/catalogue.ts';
import { loadDeviations, validateDeviations } from '../harness/deviations.ts';
import { loadLexicons } from '../harness/lexicons.ts';
import { loadManifest, loadPins, validateManifest } from '../harness/manifest.ts';
import { formatProblem, type Problem } from '../harness/problems.ts';
import { staleSources, validatePassIndex } from '../harness/independence.ts';
import { validateResults } from '../harness/results.ts';
import { ROOT } from '../harness/schema.ts';
import { anchors, loadRevisions, loadSpecText } from '../harness/spec.ts';

const { values } = parseArgs({
  options: {
    deviations: { type: 'string', multiple: true, default: [] },
    results: { type: 'string', multiple: true, default: [] },
  },
});

const rel = (p: string) => relative(ROOT, p) || p;
const problems: Problem[] = [];
const counts: string[] = [];

const revisions = loadRevisions();
const revisionKeys = Object.keys(revisions.revisions);

const catPath = join(ROOT, 'spec', 'assertions.yaml');
let cat: ReturnType<typeof loadCatalogue>;
try {
  cat = loadCatalogue(catPath);
} catch (e) {
  console.error(`${rel(catPath)}: ${(e as Error).message}`);
  process.exit(1);
}
const rev = revisions.revisions[cat.revision] ?? revisions.revisions[revisions.default];
const specText = await loadSpecText(rev);
const specAnchors = anchors(specText);
problems.push(...validateCatalogue(cat, rel(catPath), specText, revisionKeys, loadLexicons(rev)));
counts.push(`${cat.assertions?.length ?? 0} assertions`);
const byLevel = new Map<string, number>();
for (const a of cat.assertions ?? []) byLevel.set(a.level, (byLevel.get(a.level) ?? 0) + 1);
console.log(`catalogue: ${[...byLevel].map(([l, n]) => `${n} ${l}`).join(', ')}`);

const implDir = join(ROOT, 'implementations');
const ids = new Set(readdirSync(implDir).filter((d) => existsSync(join(implDir, d, 'manifest.yaml'))));
const pins = loadPins(join(ROOT, 'pins', 'images.env'));
const deviationFiles: string[] = [...values.deviations];
for (const id of ids) {
  const file = join(implDir, id, 'manifest.yaml');
  const m = loadManifest(file);
  problems.push(...validateManifest(m, rel(file), { revisions: revisionKeys, pins, ids }));
  if (typeof m.deviations === 'string') deviationFiles.push(join(implDir, id, m.deviations));
}
counts.push(`${ids.size} manifests`);

for (const file of deviationFiles) problems.push(...validateDeviations(loadDeviations(file), rel(file), cat, specAnchors));
counts.push(`${deviationFiles.length} deviation lists`);

const resultsDir = join(ROOT, 'test', 'fixtures', 'results');
const resultFiles = [
  ...(existsSync(resultsDir) ? readdirSync(resultsDir).filter((f) => f.endsWith('.json')).map((f) => join(resultsDir, f)) : []),
  ...values.results,
];
for (const file of resultFiles) problems.push(...validateResults(JSON.parse(readFileSync(file, 'utf8')), rel(file), cat));
counts.push(`${resultFiles.length} result files`);

problems.push(...validatePassIndex(cat));
counts.push('the pass index');
const stale = staleSources();
if (stale.length)
  console.log(`note: ${stale.length} pass-index source(s) ran against an older catalogue (${stale.map((s) => s.implementation).join(', ')}); rerun them if a row's check changed since`);

for (const p of problems) console.error(formatProblem(p));
console.log(`${problems.length ? 'FAIL' : 'ok'}: ${counts.join(', ')}, ${problems.length} problem(s)`);
process.exit(problems.length ? 1 : 0);
