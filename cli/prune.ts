// `node cli/prune.ts <results.json>... [--write]`: find deviation entries a
// run shows as "fixed, still listed" and, with --write, take them out of the
// implementation's deviations.yaml (design ch. 4.4 rule 6). The nightly run
// opens a prune PR with the change, and fails nothing.
//
// Only lists kept in this repo are pruned. A list in an implementation's own
// repo (HappyView's) is that repo's to edit: its CI fails on a fixed entry.
//
// An entry is removed once every revision it covers has a given run showing
// it fixed. When only some of them do, the entry's `revisions` is narrowed to
// the rest. The file is edited as text, so comments, wrapping and the other
// entries stay exactly as they were.
//
// Prints one line per change and, last, `pruned=<n>`.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { isSeq, parse, parseDocument } from 'yaml';
import { appliesAt, loadCatalogue } from '../harness/catalogue.ts';
import { type Deviation, loadDeviations } from '../harness/deviations.ts';
import { judgeFile, type ResultsFile } from '../harness/judge.ts';
import { loadManifest } from '../harness/manifest.ts';
import { ROOT } from '../harness/schema.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { write: { type: 'boolean', default: false } } });
if (!positionals.length) {
  console.error('usage: node cli/prune.ts <results.json>... [--write]');
  process.exit(2);
}

const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
const byId = new Map(cat.assertions.map((a) => [a.id, a]));
/** impl -> assertion id -> revisions a run showed it fixed at. */
const fixed = new Map<string, Map<string, Set<string>>>();
for (const path of positionals) {
  const file: ResultsFile = JSON.parse(readFileSync(path, 'utf8'));
  const manifest = loadManifest(join(ROOT, 'implementations', file.implementation.id, 'manifest.yaml'));
  if (typeof manifest.deviations !== 'string') continue;
  // Judge against the list as it is in this checkout, not the copy the run embedded.
  const list = loadDeviations(join(ROOT, 'implementations', manifest.id, manifest.deviations));
  const { judged } = judgeFile(file, list);
  for (const j of judged) {
    if (j.display !== 'fixed, still listed') continue;
    if (!fixed.has(manifest.id)) fixed.set(manifest.id, new Map());
    const m = fixed.get(manifest.id)!;
    if (!m.has(j.id)) m.set(j.id, new Set());
    m.get(j.id)!.add(file.spec.revision);
  }
}

let pruned = 0;
for (const [impl, ids] of [...fixed].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const manifest = loadManifest(join(ROOT, 'implementations', impl, 'manifest.yaml'));
  const path = join(ROOT, 'implementations', impl, manifest.deviations as string);
  let text = readFileSync(path, 'utf8');
  const seq = parseDocument(text).contents;
  if (!isSeq(seq)) continue;
  const lineStart = (offset: number) => text.lastIndexOf('\n', offset - 1) + 1;
  // Each item's own lines: from its "- " line up to the next item's, less the
  // blank and comment lines just above the next item, which belong to it.
  const spans = seq.items.map((item, i) => {
    const start = lineStart((item as { range: [number, number, number] }).range[0]);
    const next = seq.items[i + 1] as { range: [number, number, number] } | undefined;
    let end = next ? lineStart(next.range[0]) : text.length;
    const lines = text.slice(start, end).split('\n');
    while (lines.length > 1 && /^\s*(#.*)?$/.test(lines[lines.length - 1]) && /^\s*(#.*)?$/.test(lines[lines.length - 2])) lines.pop();
    end = start + lines.join('\n').length;
    return { start, end };
  });
  const entries = loadDeviations(path);
  // Walk backwards so an edit doesn't shift the spans still to visit.
  for (let i = entries.length - 1; i >= 0; i--) {
    const d: Deviation = entries[i];
    const at = ids.get(d.assertion);
    const a = byId.get(d.assertion);
    if (!at || !a) continue;
    const covers = (d.revisions ?? manifest.spec_revisions).filter((r) => appliesAt(a, r, cat.revision));
    const left = covers.filter((r) => !at.has(r));
    if (left.length === covers.length) continue;
    const where = `${relative(ROOT, path)}: ${d.assertion}`;
    const { start, end } = spans[i];
    if (!left.length) {
      // Drop the blank line that separated it from the entry before, too.
      const from = start >= 2 && text.slice(start - 2, start) === '\n\n' ? start - 1 : start;
      text = text.slice(0, from) + text.slice(end);
      console.log(`${where}: removed (fixed at ${[...at].sort().join(', ')})`);
    } else {
      const item = text.slice(start, end);
      const line = `  revisions: [${left.map((r) => JSON.stringify(r)).join(', ')}]`;
      const edited = /^  revisions:.*$/m.test(item) ? item.replace(/^  revisions:.*$/m, line) : item.replace(/^(- assertion:.*)$/m, `$1\n${line}`);
      text = text.slice(0, start) + edited + text.slice(end);
      console.log(`${where}: revisions narrowed to ${left.join(', ')} (fixed at ${[...at].sort().join(', ')})`);
    }
    pruned++;
  }
  // The edited text must parse to the same entries, less the removed ones.
  const removed = new Set(entries.filter((d) => ids.has(d.assertion)).map((d) => d.assertion));
  const after = (parse(text) ?? []) as Deviation[];
  const kept = entries.filter((d) => !removed.has(d.assertion) || after.some((x) => x.assertion === d.assertion));
  if (JSON.stringify(after.map((d) => d.assertion)) !== JSON.stringify(kept.map((d) => d.assertion))) {
    console.error(`${relative(ROOT, path)}: the text edit didn't give the expected entries; not writing it`);
    process.exit(1);
  }
  if (values.write) writeFileSync(path, text);
}
console.log(`pruned=${pruned}`);
