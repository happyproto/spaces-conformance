// Per-assertion digests (HAP-432). A results file records, for each row at the
// revision it graded, a digest of what that row checked: the row as it reads
// at that revision, plus the suite file that declares its test, the revision's
// pins (its text and lexicon commits) and the vector files of each area the
// row's check runs through. The pass index
// counts a pass only while its digest still equals the current one, so a
// changed row or test refuses its old passes until it's rerun.
//
// Shared helpers (suites/repo.ts, suites/fixtures.ts, harness/) aren't in the
// digest: a change there is meant to keep every check's meaning, and folding
// them in would make every edit restart every row.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Assertion, type Catalogue, resolveCatalogue } from './catalogue.ts';
import { declaredAssertions } from './coverage.ts';
import { vectorFilesByArea } from './provisional.ts';
import { ROOT } from './schema.ts';
import { loadRevisions } from './spec.ts';

/** JSON with object keys sorted, so key order in the YAML doesn't matter. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** `context` is what the row reads beyond its own fields and test: the pins and vectors (rowContext). */
export function assertionDigest(row: Assertion, testSource: string, context = ''): string {
  return `sha256:${createHash('sha256').update(canonical(row)).update('\0').update(testSource).update('\0').update(context).digest('hex')}`;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** id -> digest, for every row that applies at `revision`. A row with no test yet digests with an empty source. */
export function assertionDigests(cat: Catalogue, revision: string, declared = declaredAssertions()): Record<string, string> {
  const sources = new Map<string, string>();
  const source = (file: string | undefined) => {
    if (!file) return '';
    if (!sources.has(file)) sources.set(file, readFileSync(join(ROOT, file), 'utf8'));
    return sources.get(file)!;
  };
  const rev = loadRevisions().revisions[revision];
  const pin = rev ? `pin ${rev.commit} lexicons ${rev.lexicons.commit}` : `pin ${revision}`;
  const byArea = vectorFilesByArea();
  // STAR's own interop fixtures carry no cross_check, but they test the STAR harness, so they count for star rows.
  byArea.set('star', [...(byArea.get('star') ?? []), ...readdirSync(join(ROOT, 'vectors', 'star-interop')).filter((f) => f.endsWith('.json')).sort().map((f) => `star-interop/${f}`)]);
  const vectors = new Map<string, string>();
  const vectorHash = (f: string) => {
    if (!vectors.has(f)) vectors.set(f, sha(readFileSync(join(ROOT, 'vectors', f), 'utf8')));
    return vectors.get(f)!;
  };
  const context = (a: Assertion) =>
    [pin, ...[...(a.areas ?? [])].sort().map((area) => `${area}: ${(byArea.get(area) ?? []).map((f) => `${f} ${vectorHash(f)}`).join(', ')}`)].join('\n');
  return Object.fromEntries(
    resolveCatalogue(cat, revision)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((a) => [a.id, assertionDigest(a, source(declared.get(a.id)), context(a))]),
  );
}
