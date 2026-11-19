// `node cli/store.ts <command> --store <dir>`: the results store (design ch.
// 7.2, harness/store.ts). <dir> is a checkout of the orphan `results` branch.
//
//   add <results.json>...   validate each file (schema and catalogue), copy it
//                           to runs/<impl>/<yyyy>/<mm>/<run-id>.json, rebuild the index
//   rebuild                 regenerate index/ from runs/
//   check                   every run valid and at its path, index/ up to date
//   init                    make <dir> an empty store (runs/ and index/latest.json)
//
// Exits 1 on any problem, and then writes nothing.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCatalogue } from '../harness/catalogue.ts';
import { formatProblem } from '../harness/problems.ts';
import { ROOT } from '../harness/schema.ts';
import { addRuns, checkStore, rebuildIndex } from '../harness/store.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { store: { type: 'string' } } });
const [command, ...files] = positionals;
if (!command || !values.store || !['add', 'rebuild', 'check', 'init'].includes(command)) {
  console.error('usage: node cli/store.ts add|rebuild|check|init --store <dir> [results.json...]');
  process.exit(2);
}
const root = values.store;

if (command === 'init') {
  mkdirSync(join(root, 'runs'), { recursive: true });
  writeFileSync(join(root, 'runs', '.keep'), '');
  rebuildIndex(root);
  console.log(`initialised an empty store at ${root}`);
} else if (command === 'rebuild') {
  for (const p of rebuildIndex(root)) console.log(`wrote ${p}`);
} else if (command === 'check') {
  const problems = checkStore(root);
  for (const p of problems) console.error(formatProblem(p));
  console.log(`${problems.length ? 'FAIL' : 'ok'}: ${problems.length} problem(s)`);
  process.exit(problems.length ? 1 : 0);
} else {
  if (!files.length) {
    console.error('add needs at least one results file');
    process.exit(2);
  }
  const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
  const { added, unchanged, problems } = addRuns(root, files.map((name) => ({ name, data: JSON.parse(readFileSync(name, 'utf8')) })), cat);
  for (const p of problems) console.error(formatProblem(p));
  if (problems.length) process.exit(1);
  for (const p of added) console.log(`added ${p}`);
  for (const p of unchanged) console.log(`already stored ${p}`);
}
