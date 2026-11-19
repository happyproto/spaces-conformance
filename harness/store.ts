// The results store (design ch. 7.2): the orphan `results` branch, checked
// out as a plain folder.
//
//   runs/<impl>/<yyyy>/<mm>/<run-id>.json   one results file per run, never rewritten
//   index/latest.json                       the newest non-candidate run per implementation and revision
//   index/<impl>.json                       every run of one implementation, newest first
//
// The index files are derived: rebuildIndex() regenerates them from runs/
// alone, with no clock, so checkStore() can say whether a checkout's index
// is the one its runs produce. Every runs/ file must pass the results
// schema; a file is also checked against the catalogue when it's added,
// but not afterwards, so retiring an assertion later doesn't break the
// history it was graded in.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Catalogue } from './catalogue.ts';
import type { ResultsFile } from './judge.ts';
import type { Problem } from './problems.ts';
import { validateResults } from './results.ts';
import { checkSchema } from './schema.ts';

export interface RunEntry {
  id: string;
  /** Relative to the store root. */
  path: string;
  kind: ResultsFile['run']['kind'];
  started_at: string;
  finished_at: string;
  revision: string;
  image: string;
  source_revision?: string;
  suite_commit: string;
  slow: boolean;
  ci_url?: string;
  /** Raw statuses, counted. Display states are derived at read time, never stored. */
  counts: { pass: number; fail: number; error: number; skip: number };
}

export interface ImplIndex {
  schema: 1;
  implementation: string;
  runs: RunEntry[];
}

export interface LatestIndex {
  schema: 1;
  /** The newest finished_at among the runs; there's no wall clock in the index. */
  updated_at: string | null;
  /** implementation -> revision -> its newest run that isn't a candidate. */
  implementations: Record<string, Record<string, { run: string; path: string }>>;
  /** implementation -> revision -> its newest candidate run, when newer than the latest above. */
  candidates: Record<string, Record<string, { run: string; path: string }>>;
}

/** Where a run's file lives in the store. */
export function runPath(file: Pick<ResultsFile, 'run' | 'implementation'>): string {
  const [yyyy, mm] = file.run.started_at.slice(0, 7).split('-');
  return join('runs', file.implementation.id, yyyy, mm, `${file.run.id}.json`);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.json') ? [join(dir, e.name)] : []));
}

export function readRuns(root: string): { path: string; file: ResultsFile }[] {
  return walk(join(root, 'runs'))
    .map((p) => ({ path: relative(root, p), file: JSON.parse(readFileSync(p, 'utf8')) as ResultsFile }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function entry(path: string, f: ResultsFile): RunEntry {
  const counts = { pass: 0, fail: 0, error: 0, skip: 0 };
  for (const r of f.results) counts[r.status]++;
  return {
    id: f.run.id,
    path,
    kind: f.run.kind,
    started_at: f.run.started_at,
    finished_at: f.run.finished_at,
    revision: f.spec.revision,
    image: f.implementation.image,
    ...(f.implementation.source_revision ? { source_revision: f.implementation.source_revision } : {}),
    suite_commit: f.suite.commit,
    slow: f.run.slow === true,
    ...(f.run.ci_url ? { ci_url: f.run.ci_url } : {}),
    counts,
  };
}

const newestFirst = (a: RunEntry, b: RunEntry) => (a.started_at === b.started_at ? (a.id < b.id ? 1 : -1) : a.started_at < b.started_at ? 1 : -1);

/** The index files runs/ produces, by path relative to the store root. */
export function buildIndex(runs: { path: string; file: ResultsFile }[]): Map<string, ImplIndex | LatestIndex> {
  const byImpl = new Map<string, RunEntry[]>();
  for (const { path, file } of runs) {
    const id = file.implementation.id;
    if (!byImpl.has(id)) byImpl.set(id, []);
    byImpl.get(id)!.push(entry(path, file));
  }
  const out = new Map<string, ImplIndex | LatestIndex>();
  const latest: LatestIndex = { schema: 1, updated_at: null, implementations: {}, candidates: {} };
  for (const id of [...byImpl.keys()].sort()) {
    const list = byImpl.get(id)!.sort(newestFirst);
    out.set(join('index', `${id}.json`), { schema: 1, implementation: id, runs: list });
    for (const r of list) {
      if (!latest.updated_at || r.finished_at > latest.updated_at) latest.updated_at = r.finished_at;
      const slot = r.kind === 'candidate' ? latest.candidates : latest.implementations;
      slot[id] ??= {};
      slot[id][r.revision] ??= { run: r.id, path: r.path };
    }
  }
  // A candidate is shown only while it's newer than what's pinned.
  for (const [id, revs] of Object.entries(latest.candidates)) {
    for (const [rev, c] of Object.entries(revs)) {
      const pinned = latest.implementations[id]?.[rev];
      const started = (p: string) => byImpl.get(id)!.find((r) => r.path === p)!.started_at;
      if (pinned && started(pinned.path) >= started(c.path)) delete revs[rev];
    }
    if (!Object.keys(revs).length) delete latest.candidates[id];
  }
  out.set(join('index', 'latest.json'), latest);
  return out;
}

const serialise = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Rewrite every index file from runs/. Returns the paths written. */
export function rebuildIndex(root: string): string[] {
  const files = buildIndex(readRuns(root));
  for (const [p, v] of files) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), serialise(v));
  }
  return [...files.keys()];
}

/**
 * Add results files to the store, then rebuild the index. Each file must
 * pass the results schema and the catalogue at this suite commit; nothing
 * is written unless every file does. A run already in the store with the
 * same bytes is a no-op; with different bytes it's refused, because a
 * published result is corrected by a visible new run, not an edit.
 */
export function addRuns(root: string, inputs: { name: string; data: unknown }[], cat: Catalogue): { added: string[]; unchanged: string[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const planned: { path: string; text: string }[] = [];
  const unchanged: string[] = [];
  for (const { name, data } of inputs) {
    const p = validateResults(data, name, cat);
    if (p.length) {
      problems.push(...p);
      continue;
    }
    const f = data as ResultsFile;
    const path = runPath(f);
    const text = serialise(f);
    const abs = join(root, path);
    if (existsSync(abs)) {
      if (readFileSync(abs, 'utf8') === text) unchanged.push(path);
      else problems.push({ file: name, where: f.run.id, message: `${path} is already in the store with different content` });
      continue;
    }
    if (planned.some((x) => x.path === path)) {
      problems.push({ file: name, where: f.run.id, message: `run ${f.run.id} is given twice` });
      continue;
    }
    planned.push({ path, text });
  }
  if (problems.length) return { added: [], unchanged, problems };
  for (const { path, text } of planned) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  rebuildIndex(root);
  return { added: planned.map((x) => x.path), unchanged, problems };
}

/**
 * Check a store checkout: every run passes the results schema and sits at
 * its own path, the index files pass theirs, and they equal what runs/
 * rebuilds to. The site build refuses to render a store with any problem.
 */
export function checkStore(root: string): Problem[] {
  const problems: Problem[] = [];
  if (!existsSync(join(root, 'runs'))) return [{ file: root, where: 'runs', message: 'no runs/ folder: this is not a results store' }];
  const runs = readRuns(root);
  const seen = new Map<string, string>();
  for (const { path, file } of runs) {
    const p = checkSchema('results', file, path);
    if (p.length) {
      problems.push(...p);
      continue;
    }
    if (runPath(file) !== path) problems.push({ file: path, where: file.run.id, message: `belongs at ${runPath(file)}` });
    if (seen.has(file.run.id)) problems.push({ file: path, where: file.run.id, message: `run id is also used by ${seen.get(file.run.id)}` });
    seen.set(file.run.id, path);
  }
  if (problems.length) return problems;
  const expected = buildIndex(runs);
  const present = walk(join(root, 'index')).map((p) => relative(root, p));
  for (const p of present) if (!expected.has(p)) problems.push({ file: p, where: '/', message: 'index file for an implementation with no runs' });
  for (const [p, v] of expected) {
    const abs = join(root, p);
    if (!existsSync(abs)) {
      problems.push({ file: p, where: '/', message: 'missing; run `node cli/store.ts rebuild`' });
      continue;
    }
    const data = JSON.parse(readFileSync(abs, 'utf8'));
    const schemaProblems = checkSchema('index', data, p);
    if (schemaProblems.length) problems.push(...schemaProblems);
    else if (readFileSync(abs, 'utf8') !== serialise(v)) problems.push({ file: p, where: '/', message: "doesn't match what runs/ rebuilds to; run `node cli/store.ts rebuild`" });
  }
  return problems;
}
