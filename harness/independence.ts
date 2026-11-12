// Independence (design S5). An assertion that runs through harness crypto
// stops being provisional only once it has passed on two implementations
// whose declared lineage differs, in every area the assertion uses:
//
//   - each manifest declares `lineage` per area (cbor, lthash, mac, httpsig,
//     jwt, star): the library or codebase that implements it;
//   - equal lineage strings count as one, so two hosts built on the same
//     `@atproto/*` package don't clear anything;
//   - a missing lineage is unknown, and unknown never clears;
//   - the harness doesn't count: only implementations' passes do.
//
// The passes come from evidence/passes.json, a committed index regenerated
// from validated results files by `node cli/passes.ts` (docs/catalogue.md).

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Assertion, Catalogue } from './catalogue.ts';
import { loadManifest } from './manifest.ts';
import type { Problem } from './problems.ts';
import type { Area } from './provisional.ts';
import { validateResults } from './results.ts';
import { ROOT } from './schema.ts';

export const PASS_INDEX = join(ROOT, 'evidence', 'passes.json');

export interface PassSource {
  file: string;
  implementation: string;
  run: string;
  suite_commit: string;
  /** The catalogue digest the run used (results suite.assertions_digest). */
  assertions_digest: string;
  image: string;
}

/** A committed results file that deliberately doesn't feed the index. */
export interface PassExclusion {
  file: string;
  reason: string;
}

export interface PassIndex {
  /** The results files the index was built from, in order. */
  sources: PassSource[];
  /** Committed results files left out on purpose, each with why. */
  excluded: PassExclusion[];
  /** assertion id -> ids of the implementations it passed on, sorted. */
  passes: Record<string, string[]>;
}

/** Where committed results files live: each must be a source or excluded. */
export const RESULTS_DIR = join(ROOT, 'test', 'fixtures', 'results');

export interface Independence {
  /** assertion id -> implementations it passed on. */
  passes: Map<string, string[]>;
  /** implementation id -> its declared lineage per area. */
  lineage: Map<string, Partial<Record<Area, string>>>;
}

interface ResultsFile {
  run: { id: string };
  suite: { commit: string; assertions_digest: string };
  implementation: { id: string; image: string };
  results: { id: string; status: string }[];
}

/** Build the index from results files (already validated by the caller). */
export function buildPassIndex(files: { path: string; file: ResultsFile }[], excluded: PassExclusion[] = []): PassIndex {
  const passes = new Map<string, Set<string>>();
  for (const { file } of files)
    for (const r of file.results) {
      if (r.status !== 'pass') continue;
      if (!passes.has(r.id)) passes.set(r.id, new Set());
      passes.get(r.id)!.add(file.implementation.id);
    }
  return {
    sources: files.map(({ path, file }) => ({
      file: path,
      implementation: file.implementation.id,
      run: file.run.id,
      suite_commit: file.suite.commit,
      assertions_digest: file.suite.assertions_digest,
      image: file.implementation.image,
    })),
    excluded,
    passes: Object.fromEntries([...passes].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, s]) => [id, [...s].sort()])),
  };
}

/** The committed index plus every manifest's lineage. */
export function loadIndependence(indexPath = PASS_INDEX): Independence {
  const index: PassIndex = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { sources: [], excluded: [], passes: {} };
  const lineage = new Map<string, Partial<Record<Area, string>>>();
  for (const id of new Set(Object.values(index.passes).flat())) {
    const m = join(ROOT, 'implementations', id, 'manifest.yaml');
    lineage.set(id, existsSync(m) ? ((loadManifest(m).lineage ?? {}) as Partial<Record<Area, string>>) : {});
  }
  return { passes: new Map(Object.entries(index.passes)), lineage };
}

/** Two implementations count as independent for these areas when each area's lineage is known for both and differs. */
export function independent(x: Partial<Record<Area, string>>, y: Partial<Record<Area, string>>, areas: Area[]): boolean {
  return areas.every((area) => !!x[area] && !!y[area] && x[area] !== y[area]);
}

/**
 * Why an assertion still lacks independent passes, or null once two
 * implementations of differing lineage have passed it. Rows that use no
 * harness crypto (`areas: []`) have nothing to be independent about.
 */
export function independenceReason(a: Assertion, ind: Independence): string | null {
  const areas = (a.areas ?? []) as Area[];
  if (!areas.length) return null;
  const passers = ind.passes.get(a.id) ?? [];
  for (let i = 0; i < passers.length; i++)
    for (let j = i + 1; j < passers.length; j++)
      if (independent(ind.lineage.get(passers[i]) ?? {}, ind.lineage.get(passers[j]) ?? {}, areas)) return null;
  const on = passers.length ? `passed only on ${passers.join(', ')}` : 'not yet passed anywhere';
  return `not yet passed on two implementations of independent ${areas.join(', ')} lineage (${on})`;
}

/** Read and validate results files for the index. Problems name the file. */
export function readSources(paths: string[], cat: Catalogue): { files: { path: string; file: ResultsFile }[]; problems: Problem[] } {
  const files: { path: string; file: ResultsFile }[] = [];
  const problems: Problem[] = [];
  for (const path of paths) {
    const abs = join(ROOT, path);
    if (!existsSync(abs)) {
      problems.push({ file: 'evidence/passes.json', where: path, message: 'source results file does not exist' });
      continue;
    }
    const file = JSON.parse(readFileSync(abs, 'utf8'));
    const p = validateResults(file, path, cat);
    problems.push(...p);
    if (!p.length) files.push({ path, file });
  }
  return { files, problems };
}

/**
 * The committed index must be exactly what its sources rebuild to, so a pass
 * can't be added by hand. Every source must validate, and every committed
 * results file must be either a source or excluded with a reason.
 */
export function validatePassIndex(cat: Catalogue, indexPath = PASS_INDEX, resultsDir = RESULTS_DIR): Problem[] {
  if (!existsSync(indexPath)) return [];
  const index: PassIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
  const at = (where: string, message: string) => ({ file: 'evidence/passes.json', where, message });
  const listed = new Set([...index.sources.map((s) => s.file), ...(index.excluded ?? []).map((e) => e.file)]);
  const coverage: Problem[] = [];
  if (existsSync(resultsDir))
    for (const f of readdirSync(resultsDir).filter((f) => f.endsWith('.json'))) {
      const path = relative(ROOT, join(resultsDir, f));
      if (!listed.has(path)) coverage.push(at(path, 'committed results file is neither a source nor excluded with a reason'));
    }
  for (const e of index.excluded ?? []) if (!existsSync(join(ROOT, e.file))) coverage.push(at(e.file, 'excluded file does not exist'));
  const { files, problems } = readSources(index.sources.map((s) => s.file), cat);
  problems.unshift(...coverage);
  if (problems.length) return problems;
  const rebuilt = buildPassIndex(files, index.excluded ?? []);
  if (JSON.stringify(rebuilt) !== JSON.stringify(index))
    problems.push({ file: 'evidence/passes.json', where: 'passes', message: 'does not match its sources: regenerate it with node cli/passes.ts' });
  return problems;
}

/**
 * Sources whose run used another catalogue than the current one. They still
 * count: most catalogue edits don't change what a row checks. `bun run
 * validate` names them, so whoever changes a row's check knows to rerun.
 */
export function staleSources(indexPath = PASS_INDEX): PassSource[] {
  if (!existsSync(indexPath)) return [];
  const index: PassIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
  const current = `sha256:${createHash('sha256').update(readFileSync(join(ROOT, 'spec', 'assertions.yaml'))).digest('hex')}`;
  return index.sources.filter((s) => s.assertions_digest !== current);
}
