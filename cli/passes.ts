// `node cli/passes.ts <results.json>...`: rebuild evidence/passes.json, the
// index of which implementations each assertion has passed on (design S5,
// harness/independence.ts). Each file must be a committed, validated results
// file of a real run. With no arguments it rebuilds from the index's current
// sources. `bun run validate` checks the index still matches them.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { loadCatalogue } from '../harness/catalogue.ts';
import { buildPassIndex, PASS_INDEX, type PassIndex, readSources } from '../harness/independence.ts';
import { formatProblem } from '../harness/problems.ts';
import { ROOT } from '../harness/schema.ts';

const args = process.argv.slice(2).map((p) => relative(ROOT, isAbsolute(p) ? p : join(process.cwd(), p)));
const paths = args.length
  ? args
  : existsSync(PASS_INDEX)
    ? (JSON.parse(readFileSync(PASS_INDEX, 'utf8')) as PassIndex).sources.map((s) => s.file)
    : [];
if (!paths.length) {
  console.error('usage: node cli/passes.ts <results.json>...');
  process.exit(2);
}
const { files, problems } = readSources(paths, loadCatalogue(join(ROOT, 'spec', 'assertions.yaml')));
if (problems.length) {
  console.error(problems.map(formatProblem).join('\n'));
  process.exit(1);
}
const index = buildPassIndex(files);
mkdirSync(dirname(PASS_INDEX), { recursive: true });
writeFileSync(PASS_INDEX, `${JSON.stringify(index, null, 2)}\n`);
console.log(`wrote ${relative(ROOT, PASS_INDEX)}: ${Object.keys(index.passes).length} assertions passed, from ${files.length} results files`);
