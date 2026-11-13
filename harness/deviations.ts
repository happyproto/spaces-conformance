// Deviation lists (design ch. 4.3, 4.4). Validation only: deviations never
// change raw results, only display and CI gating, and nothing is scored yet.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { appliesAt, type Catalogue, loadCatalogue } from './catalogue.ts';
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
  /** The revisions the entry covers. Without it, every revision the assertion applies at. */
  revisions?: string[];
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

/** The entries of a list in force at revision `rev`: those without `revisions`, and those that name it. */
export function deviationsAt(list: Deviation[], rev: string): Deviation[] {
  return list.filter((d) => !d.revisions || d.revisions.includes(rev));
}

/**
 * Validate a deviation list against the catalogue at this commit: every
 * assertion must exist (an entry for a retired id is an error, so lists get
 * pruned), may appear once per revision, its `spec` anchor must be a real
 * heading, and its `expect` patterns must compile on their own and must not
 * match anything (the empty string or a sentinel).
 *
 * `anchors` is either one revision's heading anchors, or every revision's by
 * key. Given every revision's, an entry is checked at each revision it covers
 * (its `revisions`, or every revision the assertion applies at): the assertion
 * must apply there, and the anchor must exist there.
 * `today` bounds `since` so an entry can't be dated in the future.
 */
export function validateDeviations(
  data: unknown,
  file: string,
  cat: Catalogue,
  anchors: Set<string> | Map<string, Set<string>>,
  today = new Date().toISOString().slice(0, 10),
): Problem[] {
  const problems = checkSchema('deviations', data, file);
  if (problems.length) return problems;
  const byId = new Map(cat.assertions.map((a) => [a.id, a]));
  const byRev = anchors instanceof Map ? anchors : new Map([[cat.revision, anchors]]);
  const seen = new Set<string>();
  (data as Deviation[]).forEach((d, i) => {
    const at = (message: string) => problems.push({ file, where: `${i}:${d.assertion}`, message });
    const a = byId.get(d.assertion);
    if (!a) at('assertion is not in the catalogue');
    for (const r of d.revisions ?? []) if (!byRev.has(r)) at(`revision ${r} is not in spec/revisions.json`);
    const covers = (d.revisions ?? [...byRev.keys()]).filter((r) => byRev.has(r) && (!a || appliesAt(a, r, cat.revision)));
    if (a && d.revisions) for (const r of d.revisions) if (byRev.has(r) && !appliesAt(a, r, cat.revision)) at(`assertion does not apply at revision ${r}`);
    if (a && !covers.length) at('assertion applies at none of the revisions this entry covers');
    for (const r of covers) {
      if (seen.has(`${d.assertion}@${r}`)) at(byRev.size > 1 ? `assertion listed twice for revision ${r}` : 'assertion listed twice');
      seen.add(`${d.assertion}@${r}`);
      if (!byRev.get(r)!.has(d.spec)) at(`spec ${d.spec} is not a heading anchor in revision ${r}`);
    }
    if (d.since > today) at(`since ${d.since} is in the future`);
    const patterns: [string, string | undefined][] = [
      ['message', d.expect?.message],
      ...Object.entries(d.expect?.evidence ?? {}).map(([k, v]): [string, string] => [`evidence.${k}`, v]),
    ];
    for (const [where, pattern] of patterns) {
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
 * shipped catalogue at every pinned revision, as `bun run validate` does.
 * The CLIs call this before they use a list, so a bad pattern stops a run
 * before the stack starts.
 */
export async function loadCheckedDeviations(path: string, file = path): Promise<{ deviations: Deviation[]; problems: Problem[] }> {
  const deviations = loadDeviations(path);
  const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
  const anchorsByRev = new Map<string, Set<string>>();
  for (const [key, rev] of Object.entries(loadRevisions().revisions)) anchorsByRev.set(key, anchors(await loadSpecText(rev)));
  return { deviations, problems: validateDeviations(deviations, file, cat, anchorsByRev) };
}
