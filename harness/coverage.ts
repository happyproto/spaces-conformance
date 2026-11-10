// Which assertions the suites declare, read from the source, not from a
// test run. A file that fails to import still declares its ids here, so its
// missing results become errors rather than vanishing.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './schema.ts';

const DECL = /\bassertion\(\s*['"]([^'"]+)['"]/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.test.ts') ? [p] : [];
  });
}

/** id -> declaring file (relative to the repo), for the given suite folders or all of suites/. */
export function declaredAssertions(suites?: string[]): Map<string, string> {
  const roots = suites?.length ? suites.map((s) => join(ROOT, 'suites', s)) : [join(ROOT, 'suites')];
  const out = new Map<string, string>();
  for (const root of roots)
    for (const file of walk(root)) for (const m of readFileSync(file, 'utf8').matchAll(DECL)) out.set(m[1], relative(ROOT, file));
  return out;
}
