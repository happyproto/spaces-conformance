// Run result files (design ch. 7.1). The reporter (phase 2) validates with
// this before writing; the site build validates every file it reads.

import type { Catalogue } from './catalogue.ts';
import type { Problem } from './problems.ts';
import { checkSchema } from './schema.ts';

export const EVIDENCE_LIMIT = 4096;

interface ResultFile {
  results: { id: string; status: string; evidence?: unknown }[];
  deviations_applied: { assertion: string }[];
  summary: { by_role: Record<string, { must_applicable: number; must_pass: number; should_applicable: number; should_pass: number }> };
}

export function validateResults(data: unknown, file: string, cat?: Catalogue): Problem[] {
  const problems = checkSchema('results', data, file);
  if (problems.length) return problems;
  const r = data as ResultFile;
  const ids = cat ? new Set(cat.assertions.map((a) => a.id)) : undefined;
  const seen = new Set<string>();
  for (const res of r.results) {
    const at = (message: string) => problems.push({ file, where: res.id, message });
    if (seen.has(res.id)) at('result listed twice');
    seen.add(res.id);
    if (ids && !ids.has(res.id)) at('assertion is not in the catalogue');
    if (res.evidence !== undefined && JSON.stringify(res.evidence).length > EVIDENCE_LIMIT) at(`evidence is over ${EVIDENCE_LIMIT} bytes`);
  }
  for (const d of r.deviations_applied) {
    if (!seen.has(d.assertion)) problems.push({ file, where: d.assertion, message: 'deviation applied to an assertion with no result' });
  }
  for (const [role, s] of Object.entries(r.summary.by_role)) {
    if (s.must_pass > s.must_applicable || s.should_pass > s.should_applicable)
      problems.push({ file, where: `summary.by_role.${role}`, message: 'more passes than applicable assertions' });
  }
  return problems;
}
