// Deviation lists (design ch. 4.3, 4.4). Validation only: deviations never
// change raw results, only display and CI gating, and nothing is scored yet.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { type Catalogue, loadCatalogue } from './catalogue.ts';
import type { Problem } from './problems.ts';
import { checkSchema, ROOT } from './schema.ts';
import { anchors, loadRevisions, loadSpecText } from './spec.ts';

/** The failure a deviation covers (Trezy, Nov 13). Each pattern must match the whole value. */
export interface Expect {
  message: string;
  evidence?: Record<string, string>;
}

export interface Deviation {
  assertion: string;
  cause: string;
  reason: string;
  spec: string;
  tracking: string;
  since: string;
  /** Required in a list. Only result files from before it existed embed entries without it. */
  expect?: Expect;
}

/**
 * A pattern from `expect`, anchored on both ends, so it has to match the whole value.
 * The raw pattern is compiled on its own first: one with an unbalanced paren,
 * like `x)|(.*`, would otherwise close the wrapper and escape the anchors.
 */
export function wholeMatch(pattern: string): RegExp {
  new RegExp(pattern, 'su');
  return new RegExp(`^(?:${pattern})$`, 'su');
}

/** Values no real failure produces. A pattern that whole-matches one would cover any failure. */
export const MATCH_ANYTHING_PROBES = ['', 'zz-sentinel-not-a-failure'];

/**
 * Why a fail doesn't match its deviation's `expect`, or null when it does.
 * An entry without `expect` (an old result file) matches anything.
 */
export function expectMismatch(expect: Expect | undefined, result: { message?: string; evidence?: Record<string, unknown> }): string | null {
  if (!expect) return null;
  const message = result.message ?? '';
  if (!wholeMatch(expect.message).test(message)) return `message ${JSON.stringify(message.slice(0, 200))} doesn't match /${expect.message}/`;
  for (const [key, pattern] of Object.entries(expect.evidence ?? {})) {
    const value = result.evidence?.[key];
    if (value === undefined) return `evidence has no ${key}`;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!wholeMatch(pattern).test(text)) return `evidence ${key} doesn't match /${pattern}/`;
  }
  return null;
}

export function loadDeviations(path: string): Deviation[] {
  return parse(readFileSync(path, 'utf8')) ?? [];
}

/**
 * Validate a deviation list against the catalogue at this commit: every
 * assertion must exist (an entry for a retired id is an error, so lists get
 * pruned), may appear once, its `spec` anchor must be a real heading, and its
 * `expect` patterns must compile on their own and must not match anything
 * (the empty string or a sentinel).
 * `today` bounds `since` so an entry can't be dated in the future.
 */
export function validateDeviations(
  data: unknown,
  file: string,
  cat: Catalogue,
  specAnchors: Set<string>,
  today = new Date().toISOString().slice(0, 10),
): Problem[] {
  const problems = checkSchema('deviations', data, file);
  if (problems.length) return problems;
  const ids = new Set(cat.assertions.map((a) => a.id));
  const seen = new Set<string>();
  (data as Deviation[]).forEach((d, i) => {
    const at = (message: string) => problems.push({ file, where: `${i}:${d.assertion}`, message });
    if (!ids.has(d.assertion)) at('assertion is not in the catalogue');
    if (seen.has(d.assertion)) at('assertion listed twice');
    seen.add(d.assertion);
    if (!specAnchors.has(d.spec)) at(`spec ${d.spec} is not a heading anchor in the pinned revision`);
    if (d.since > today) at(`since ${d.since} is in the future`);
    for (const [where, pattern] of [['message', d.expect?.message], ...Object.entries(d.expect?.evidence ?? {}).map(([k, v]) => [`evidence.${k}`, v])]) {
      if (pattern === undefined) continue;
      let re: RegExp;
      try {
        re = wholeMatch(pattern);
      } catch (e) {
        at(`expect ${where} is not a valid regular expression: ${(e as Error).message}`);
        continue;
      }
      const probe = MATCH_ANYTHING_PROBES.find((v) => re.test(v));
      if (probe !== undefined) at(`expect ${where} matches ${JSON.stringify(probe)}, so it would cover any failure`);
    }
  });
  return problems;
}

/**
 * Load a deviation list and run the full validation on it, against the
 * shipped catalogue and its pinned revision. The CLIs call this before they
 * use a list, so a bad pattern stops a run before the stack starts.
 */
export async function loadCheckedDeviations(path: string, file = path): Promise<{ deviations: Deviation[]; problems: Problem[] }> {
  const deviations = loadDeviations(path);
  const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
  const revisions = loadRevisions();
  const rev = revisions.revisions[cat.revision] ?? revisions.revisions[revisions.default];
  const specAnchors = anchors(await loadSpecText(rev));
  return { deviations, problems: validateDeviations(deviations, file, cat, specAnchors) };
}
