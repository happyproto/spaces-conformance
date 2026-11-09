// The pinned proposal text: fetched by commit, verified by SHA-256, cached.
// Quotes and section anchors in the catalogue are checked against it.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './schema.ts';

export const USER_AGENT = 'spaces-conformance (+https://github.com/happyproto/spaces-conformance)';

export interface Revision {
  proposal: string;
  repo: string;
  commit: string;
  path: string;
  sha256: string;
  lexicons: { repo: string; ref: string; commit: string };
}

export interface Revisions {
  default: string;
  revisions: Record<string, Revision>;
}

export function loadRevisions(): Revisions {
  return JSON.parse(readFileSync(join(ROOT, 'spec', 'revisions.json'), 'utf8'));
}

export function rawUrl(rev: Revision): string {
  return `https://raw.githubusercontent.com/${rev.repo}/${rev.commit}/${rev.path}`;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The pinned proposal's Markdown. Reads `.cache/spec/<commit>.md` (or
 * `SPEC_CACHE_DIR`) and fetches it on a miss. A body whose hash doesn't
 * match revisions.json is refused, so a moved or edited pin can't slip in.
 */
export async function loadSpecText(rev: Revision): Promise<string> {
  const dir = process.env.SPEC_CACHE_DIR ?? join(ROOT, '.cache', 'spec');
  const file = join(dir, `${rev.commit}.md`);
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    if (sha256(text) === rev.sha256) return text;
  }
  const res = await fetch(rawUrl(rev), { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`fetching ${rawUrl(rev)}: HTTP ${res.status}`);
  const text = await res.text();
  const got = sha256(text);
  if (got !== rev.sha256) throw new Error(`${rawUrl(rev)} has sha256 ${got}, revisions.json pins ${rev.sha256}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text);
  return text;
}

/**
 * Markdown reduced to comparable prose: links become their text, code spans
 * and emphasis markers go, table pipes become spaces, whitespace collapses.
 */
export function plainText(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/(^|[\s(])\*(\S[^*]*?)\*(?=[\s).,;:]|$)/g, '$1$2')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** GitHub's heading anchors, with -1, -2 suffixes for repeats. */
export function anchors(md: string): Set<string> {
  const out = new Set<string>();
  const counts = new Map<string, number>();
  let fenced = false;
  for (const line of md.split('\n')) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = plainText(m[1])
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    out.add(`#${n === 0 ? base : `${base}-${n}`}`);
  }
  return out;
}
