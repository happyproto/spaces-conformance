// Display states, scoring and CI gating (design ch. 4.4). The same module
// serves `conformance verdict`, the reporter's summary and, later, the site.
//
// | Raw   | Listed | Provisional | Shown as             | Scored as   | Gated CI  |
// | pass  | no     | either      | pass                 | pass        | ok        |
// | fail  | no     | no          | fail                 | fail        | fails     |
// | fail  | no     | yes         | fail (provisional)   | excluded    | warns     |
// | fail  | yes    | either      | known deviation      | not passing | ok        |
// | pass  | yes    | no          | fixed, still listed  | pass        | fails     |
// | pass  | yes    | yes         | fixed, still listed  | pass        | warns     |
// | error | either | either      | error                | excluded    | fails     |
// | skip  | n/a    | n/a         | not applicable       | excluded    | ok        |

import type { Assertion, Role } from './catalogue.ts';
import type { Area, AreaStatus } from './provisional.ts';
import { provisionalReason } from './provisional.ts';

export type Raw = 'pass' | 'fail' | 'error' | 'skip';
export type Display = 'pass' | 'fail' | 'fail (provisional)' | 'known deviation' | 'fixed, still listed' | 'error' | 'not applicable';
export type Gate = 'ok' | 'warn' | 'fail';

export interface Judged {
  id: string;
  raw: Raw;
  display: Display;
  gate: Gate;
  /** Counted toward the score, and whether it counts as passing. */
  scored: boolean;
  passing: boolean;
  provisional: string | null;
}

export function judge(raw: Raw, listed: boolean, provisional: boolean): Omit<Judged, 'id' | 'raw' | 'provisional'> {
  if (raw === 'skip') return { display: 'not applicable', gate: 'ok', scored: false, passing: false };
  if (raw === 'error') return { display: 'error', gate: 'fail', scored: false, passing: false };
  if (raw === 'pass') {
    if (!listed) return { display: 'pass', gate: 'ok', scored: !provisional, passing: true };
    return { display: 'fixed, still listed', gate: provisional ? 'warn' : 'fail', scored: !provisional, passing: true };
  }
  if (listed) return { display: 'known deviation', gate: 'ok', scored: !provisional, passing: false };
  return provisional
    ? { display: 'fail (provisional)', gate: 'warn', scored: false, passing: false }
    : { display: 'fail', gate: 'fail', scored: true, passing: false };
}

export interface Summary {
  by_role: Partial<Record<Role, { must_applicable: number; must_pass: number; should_applicable: number; should_pass: number }>>;
  unexpected: number;
}

export function judgeAll(
  results: { id: string; status: Raw }[],
  byId: Map<string, Assertion>,
  listed: Set<string>,
  areas: Map<Area, AreaStatus>,
  roles: Role[],
): { judged: Judged[]; summary: Summary } {
  const judged: Judged[] = [];
  const by_role: Summary['by_role'] = Object.fromEntries(
    roles.map((r) => [r, { must_applicable: 0, must_pass: 0, should_applicable: 0, should_pass: 0 }]),
  );
  for (const r of results) {
    const a = byId.get(r.id);
    const provisional = a ? provisionalReason(a, areas) : 'not in the catalogue';
    const j = { id: r.id, raw: r.status, provisional, ...judge(r.status, listed.has(r.id), provisional !== null) };
    judged.push(j);
    if (!a || !j.scored || a.level === 'info') continue;
    for (const role of a.roles.filter((x) => roles.includes(x))) {
      const s = by_role[role]!;
      if (a.level === 'must') {
        s.must_applicable++;
        if (j.passing) s.must_pass++;
      } else {
        s.should_applicable++;
        if (j.passing) s.should_pass++;
      }
    }
  }
  return { judged, summary: { by_role, unexpected: judged.filter((j) => j.gate === 'fail').length } };
}
