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
  lexicons: { repo: string; ref: string; commit: string; sha256: string };
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
  // Emphasis is stripped only outside code spans, so `collection=*` keeps its star.
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 1
        ? part.slice(1, -1)
        : part.replace(/\*\*|__/g, '').replace(/(^|[\s(])[*_](\S[^*_]*?)[*_](?=[\s).,;:]|$)/g, '$1$2'),
    )
    .join('')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Heading {
  anchor: string;
  level: number;
  line: number;
}

/** Every heading with its GitHub anchor (-1, -2 suffixes for repeats), skipping fenced code. */
function headings(md: string): Heading[] {
  const out: Heading[] = [];
  const counts = new Map<string, number>();
  let fenced = false;
  md.split('\n').forEach((line, i) => {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) return;
    const base = plainText(m[2])
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    out.push({ anchor: `#${n === 0 ? base : `${base}-${n}`}`, level: m[1].length, line: i });
  });
  return out;
}

/** GitHub's heading anchors. */
export function anchors(md: string): Set<string> {
  return new Set(headings(md).map((h) => h.anchor));
}

/**
 * The Markdown of one section: from its heading up to the next heading of the
 * same or a higher level, so it includes its subsections. Undefined for an
 * unknown anchor.
 */
export function sectionText(md: string, anchor: string): string | undefined {
  const hs = headings(md);
  const k = hs.findIndex((h) => h.anchor === anchor);
  if (k < 0) return undefined;
  const end = hs.slice(k + 1).find((h) => h.level <= hs[k].level);
  return md.split('\n').slice(hs[k].line, end?.line).join('\n');
}
