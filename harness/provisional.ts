// Fencing a harness that hasn't been cross-checked (design ch. 3.4). An
// assertion is provisional, so it's shown as "fail (provisional)", isn't
// scored and only warns in CI, while it's flagged provisional in the
// catalogue, or while any vector area it depends on still has a pending
// cross-check. An area with no vectors at all counts as pending.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Assertion } from './catalogue.ts';
import { ROOT } from './schema.ts';

export const AREAS = ['cbor', 'lthash', 'mac', 'httpsig', 'jwt', 'star'] as const;
export type Area = (typeof AREAS)[number];

export interface CrossCheck {
  area: Area;
  status: 'pending' | 'cross-checked';
  against: string[];
}

export interface AreaStatus {
  area: Area;
  pending: boolean;
  /** Names of the vectors still pending, for the report. */
  pendingVectors: string[];
}

/** Every cross_check in a parsed vector file, with the name of the entry that holds it. */
function crossChecks(v: unknown, name = ''): { name: string; cc: CrossCheck }[] {
  if (Array.isArray(v)) return v.flatMap((x) => crossChecks(x, name));
  if (v === null || typeof v !== 'object') return [];
  const o = v as Record<string, unknown>;
  const here = typeof o.name === 'string' ? o.name : name;
  const out = o.cross_check ? [{ name: here, cc: o.cross_check as CrossCheck }] : [];
  for (const [k, x] of Object.entries(o)) if (k !== 'cross_check') out.push(...crossChecks(x, here));
  return out;
}

export function vectorStatus(dir = join(ROOT, 'vectors')): Map<Area, AreaStatus> {
  const status = new Map<Area, AreaStatus>(AREAS.map((a) => [a, { area: a, pending: true, pendingVectors: ['(no vectors)'] }]));
  const seen = new Set<Area>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    for (const { name, cc } of crossChecks(JSON.parse(readFileSync(join(dir, f), 'utf8')))) {
      if (!AREAS.includes(cc.area)) throw new Error(`${f}: unknown cross_check area ${cc.area}`);
      const s = status.get(cc.area)!;
      if (!seen.has(cc.area)) {
        seen.add(cc.area);
        s.pending = false;
        s.pendingVectors = [];
      }
      if (cc.status !== 'cross-checked') {
        s.pending = true;
        s.pendingVectors.push(`${f}: ${name}`);
      }
    }
  }
  return status;
}

/** Why an assertion is provisional, or null if it isn't. */
export function provisionalReason(a: Assertion, status: Map<Area, AreaStatus>): string | null {
  if (a.provisional) return 'flagged provisional in the catalogue';
  const pending = (a.areas ?? []).filter((x) => status.get(x)?.pending);
  return pending.length ? `harness ${pending.join(', ')} not yet cross-checked` : null;
}
