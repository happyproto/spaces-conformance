// Deviation lists (design ch. 4.3, 4.4). Validation only: deviations never
// change raw results, only display and CI gating, and nothing is scored yet.

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Catalogue } from './catalogue.ts';
import type { Problem } from './problems.ts';
import { checkSchema } from './schema.ts';

export interface Deviation {
  assertion: string;
  cause: string;
  reason: string;
  spec: string;
  tracking: string;
  since: string;
}

export function loadDeviations(path: string): Deviation[] {
  return parse(readFileSync(path, 'utf8')) ?? [];
}

/**
 * Validate a deviation list against the catalogue at this commit: every
 * assertion must exist (an entry for a retired id is an error, so lists get
 * pruned), may appear once, and its `spec` anchor must be a real heading.
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
  });
  return problems;
}
