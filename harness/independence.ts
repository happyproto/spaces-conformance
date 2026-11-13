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
// Passes are kept per spec revision: a pass at one revision says nothing
// about another. A source that records per-assertion digests (HAP-432) counts
// a pass only while that row's digest still equals the current one.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Assertion, Catalogue } from './catalogue.ts';
import { assertionDigests } from './digests.ts';
import { loadManifest } from './manifest.ts';
import type { Problem } from './problems.ts';
import type { Area } from './provisional.ts';
import { validateResults } from './results.ts';
import { ROOT } from './schema.ts';
import { loadRevisions } from './spec.ts';

export const PASS_INDEX = join(ROOT, 'evidence', 'passes.json');

export interface PassSource {
  file: string;
  implementation: string;
  run: string;
  suite_commit: string;
  /** The catalogue digest the run used (results suite.assertions_digest). */
  assertions_digest: string;
  image: string;
  /** The spec revision the run graded. */
  revision: string;
  /** Passes refused because the row or its test changed since the run (its digest differs). */
  stale_passes?: string[];
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
  /** revision -> assertion id -> ids of the implementations it passed on, sorted. */
  passes: Record<string, Record<string, string[]>>;
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
  suite: { commit: string; assertions_digest: string; assertion_digests?: Record<string, string> };
  spec: { revision: string };
  implementation: { id: string; image: string };
  results: { id: string; status: string }[];
}

/**
 * Build the index from results files (already validated by the caller).
 * `current` gives the current per-assertion digests at a revision; a pass
 * from a source that recorded digests counts only where they still match.
 */
export function buildPassIndex(
  files: { path: string; file: ResultsFile }[],
  excluded: PassExclusion[] = [],
  current: (revision: string) => Record<string, string> = () => ({}),
): PassIndex {
  const passes = new Map<string, Map<string, Set<string>>>();
  const sources: PassSource[] = [];
  for (const { path, file } of files) {
    const revision = file.spec.revision;
    const digests = file.suite.assertion_digests;
    const now = digests ? current(revision) : {};
    const stale: string[] = [];
    if (!passes.has(revision)) passes.set(revision, new Map());
    const at = passes.get(revision)!;
    for (const r of file.results) {
      if (r.status !== 'pass') continue;
      if (digests && digests[r.id] !== now[r.id]) {
        stale.push(r.id);
        continue;
      }
      if (!at.has(r.id)) at.set(r.id, new Set());
      at.get(r.id)!.add(file.implementation.id);
    }
    sources.push({
      file: path,
      implementation: file.implementation.id,
      run: file.run.id,
      suite_commit: file.suite.commit,
      assertions_digest: file.suite.assertions_digest,
      image: file.implementation.image,
      revision,
      ...(stale.length ? { stale_passes: stale.sort() } : {}),
    });
  }
  const sorted = <T>(m: Map<string, T>) => [...m].sort(([a], [b]) => (a < b ? -1 : 1));
  return {
    sources,
    excluded,
    passes: Object.fromEntries(sorted(passes).map(([rev, ids]) => [rev, Object.fromEntries(sorted(ids).map(([id, s]) => [id, [...s].sort()]))])),
  };
}

/** The committed index's passes at `revision` (default: the catalogue's default), plus every passer's lineage. */
export function loadIndependence(revision = loadRevisions().default, indexPath = PASS_INDEX): Independence {
  const index: PassIndex = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { sources: [], excluded: [], passes: {} };
  const passes = index.passes[revision] ?? {};
  const lineage = new Map<string, Partial<Record<Area, string>>>();
  for (const id of new Set(Object.values(passes).flat())) {
    const m = join(ROOT, 'implementations', id, 'manifest.yaml');
    lineage.set(id, existsSync(m) ? ((loadManifest(m).lineage ?? {}) as Partial<Record<Area, string>>) : {});
  }
  return { passes: new Map(Object.entries(passes)), lineage };
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

/** implementation id -> the image its manifest pins now (pins/images.env). */
export function pinnedImages(): Map<string, string> {
  const values = new Map(
    readFileSync(join(ROOT, 'pins', 'images.env'), 'utf8')
      .split('\n')
      .map((l) => l.match(/^([A-Z0-9_]+)=(\S+)/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[1], m[2]] as const),
  );
  const out = new Map<string, string>();
  const dir = join(ROOT, 'implementations');
  for (const id of readdirSync(dir)) {
    const m = join(dir, id, 'manifest.yaml');
    const image = existsSync(m) ? values.get(loadManifest(m).image.pin) : undefined;
    if (image) out.set(id, image);
  }
  return out;
}

/**
 * The committed index must be exactly what its sources rebuild to, so a pass
 * can't be added by hand. Every source must validate, and every committed
 * results file must be either a source or excluded with a reason.
 * Every source must also have run the image its implementation pins now.
 */
export function validatePassIndex(cat: Catalogue, indexPath = PASS_INDEX, resultsDir = RESULTS_DIR, pinned: Map<string, string> = pinnedImages()): Problem[] {
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
  // S5 reads each passer's lineage from its current manifest, so a source must
  // have run the image that manifest pins: an older image's passes would be
  // credited with the new image's lineage.
  for (const src of index.sources) {
    const image = pinned.get(src.implementation);
    if (image && image !== src.image) coverage.push(at(src.file, `ran ${src.image}, but ${src.implementation} now pins ${image}: rerun it, or exclude it with a reason`));
  }
  const { files, problems } = readSources(index.sources.map((s) => s.file), cat);
  problems.unshift(...coverage);
  if (problems.length) return problems;
  const rebuilt = buildPassIndex(files, index.excluded ?? [], currentDigests(cat));
  if (JSON.stringify(rebuilt) !== JSON.stringify(index))
    problems.push({ file: 'evidence/passes.json', where: 'passes', message: 'does not match its sources: regenerate it with node cli/passes.ts' });
  return problems;
}

/** The current per-assertion digests at each revision, computed once per revision. */
export function currentDigests(cat: Catalogue): (revision: string) => Record<string, string> {
  const memo = new Map<string, Record<string, string>>();
  return (revision) => {
    if (!memo.has(revision)) memo.set(revision, assertionDigests(cat, revision));
    return memo.get(revision)!;
  };
}

/**
 * Sources from before per-assertion digests whose run used another catalogue
 * than the current one. They still count: most catalogue edits don't change
 * what a row checks. `bun run validate` names them, so whoever changes a
 * row's check knows to rerun. Sources with digests need no such note: their
 * changed rows are refused outright (stale_passes).
 */
export function staleSources(indexPath = PASS_INDEX): PassSource[] {
  if (!existsSync(indexPath)) return [];
  const index: PassIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
  const current = `sha256:${createHash('sha256').update(readFileSync(join(ROOT, 'spec', 'assertions.yaml'))).digest('hex')}`;
  return index.sources.filter((s) => s.assertions_digest !== current && !hasDigests(s.file));
}

function hasDigests(path: string): boolean {
  const abs = join(ROOT, path);
  return existsSync(abs) && !!JSON.parse(readFileSync(abs, 'utf8')).suite?.assertion_digests;
}
