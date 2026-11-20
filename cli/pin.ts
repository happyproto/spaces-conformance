// `node cli/pin.ts <impl> <image> --results <file> [--date YYYY-MM-DD]`: move
// one implementation's pin to a candidate image that passed (design ch. 6.2),
// as one self-consistent change for a pin PR:
//
//   - pins/images.env: the implementation's line gets the new digest;
//   - test/fixtures/results/<impl>-<date>.json: the candidate's results file,
//     which becomes the implementation's pass-index source (the index takes
//     only runs of the pinned image, harness/independence.ts);
//   - evidence/passes.json: the implementation's old source moves to
//     `excluded`, with the reason, and the index is rebuilt.
//
// The image must be `<the manifest's image.repository>@sha256:<64 hex>`, and
// the results file must be a validated, --slow run of exactly that image at
// the revision the old source graded. Nothing is written unless all of that holds.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCatalogue } from '../harness/catalogue.ts';
import { buildPassIndex, currentDigests, PASS_INDEX, type PassIndex, readSources, RESULTS_DIR, slowRows } from '../harness/independence.ts';
import { loadManifest } from '../harness/manifest.ts';
import { formatProblem } from '../harness/problems.ts';
import { validateResults } from '../harness/results.ts';
import { ROOT } from '../harness/schema.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { results: { type: 'string' }, date: { type: 'string' } } });
const [impl, image] = positionals;
if (!impl || !image || !values.results) {
  console.error('usage: node cli/pin.ts <impl> <image@sha256:...> --results <results.json> [--date YYYY-MM-DD]');
  process.exit(2);
}
const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const manifestPath = join(ROOT, 'implementations', impl, 'manifest.yaml');
if (!existsSync(manifestPath)) die(`${impl} is not an implementation`);
const manifest = loadManifest(manifestPath);
const digestOk = new RegExp(`^${manifest.image.repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@sha256:[0-9a-f]{64}$`);
if (!digestOk.test(image)) die(`${image} is not ${manifest.image.repository}@sha256:<64 hex>`);

const pinsPath = join(ROOT, 'pins', 'images.env');
const pins = readFileSync(pinsPath, 'utf8');
const line = new RegExp(`^${manifest.image.pin}=(\\S+)$`, 'm');
const old = line.exec(pins)?.[1] ?? die(`pins/images.env has no ${manifest.image.pin} line`);
if (old === image) die(`${impl} already pins ${image}`);

const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
const results = JSON.parse(readFileSync(values.results, 'utf8'));
const problems = validateResults(results, values.results, cat);
if (problems.length) die(problems.map(formatProblem).join('\n'));
if (results.implementation.id !== impl) die(`${values.results} is a run of ${results.implementation.id}, not ${impl}`);
if (results.implementation.image !== image) die(`${values.results} ran ${results.implementation.image}, not ${image}`);
if (results.run.slow !== true) die(`${values.results} ran without --slow, so it can't be a pass-index source`);

const index: PassIndex = JSON.parse(readFileSync(PASS_INDEX, 'utf8'));
const previous = index.sources.filter((s) => s.implementation === impl);
for (const s of previous)
  if (s.revision !== results.spec.revision) die(`${impl}'s source ${s.file} graded ${s.revision}, but the candidate graded ${results.spec.revision}`);

const date = values.date ?? results.run.started_at.slice(0, 10);
const fixture = relative(ROOT, join(RESULTS_DIR, `${impl}-${date}.json`));
if (existsSync(join(ROOT, fixture))) die(`${fixture} already exists`);

const sources = [...index.sources.filter((s) => s.implementation !== impl).map((s) => s.file), fixture];
const excluded = [
  ...index.excluded,
  ...previous.map((s) => ({ file: s.file, reason: `Ran ${impl} at ${s.image.split('@')[1].slice(0, 19)}, the pin before ${image.split('@')[1].slice(0, 19)}; superseded by ${fixture}.` })),
];

writeFileSync(join(ROOT, fixture), `${JSON.stringify(results, null, 2)}\n`);
const read = readSources(sources, cat);
if (read.problems.length) die(read.problems.map(formatProblem).join('\n'));
const rebuilt = buildPassIndex(read.files, excluded, currentDigests(cat), slowRows(cat));
writeFileSync(PASS_INDEX, `${JSON.stringify(rebuilt, null, 2)}\n`);
writeFileSync(pinsPath, pins.replace(line, `${manifest.image.pin}=${image}`));
console.log(`${manifest.image.pin}: ${old} -> ${image}`);
console.log(`source: ${previous.map((s) => s.file).join(', ') || 'none'} -> ${fixture}`);
