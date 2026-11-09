// The lexicons pinned beside a revision (spec/lexicons/<short commit>/), used
// to check lexicon-basis assertions: the NSID exists, each named parameter or
// input field is defined, and each named error is declared.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Revision } from './spec.ts';
import { ROOT } from './schema.ts';

interface LexDoc {
  id: string;
  defs: Record<string, LexDef>;
}
interface LexDef {
  type: string;
  parameters?: { properties?: Record<string, unknown> };
  input?: { schema?: { properties?: Record<string, unknown> } };
  errors?: { name: string }[];
}

export interface Lexicons {
  has(nsid: string): boolean;
  /** Query parameters and procedure input fields of the main def. */
  fields(nsid: string): Set<string>;
  errors(nsid: string): Set<string>;
}

export function lexiconDir(rev: Revision): string {
  return join(ROOT, 'spec', 'lexicons', rev.lexicons.commit.slice(0, 8));
}

/** SHA-256 over every vendored file's name and contents, in name order. */
export function lexiconDigest(dir: string): string {
  const h = createHash('sha256');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    h.update(f).update('\0').update(readFileSync(join(dir, f))).update('\0');
  }
  return h.digest('hex');
}

export function loadLexicons(rev: Revision): Lexicons {
  const dir = lexiconDir(rev);
  const got = lexiconDigest(dir);
  if (got !== rev.lexicons.sha256) throw new Error(`${dir} has digest ${got}, revisions.json pins ${rev.lexicons.sha256}`);
  const docs = new Map<string, LexDoc>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const doc: LexDoc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (`${doc.id}.json` !== f) throw new Error(`${f} holds lexicon ${doc.id}`);
    docs.set(doc.id, doc);
  }
  const main = (nsid: string) => docs.get(nsid)?.defs.main;
  return {
    has: (nsid) => docs.has(nsid),
    fields: (nsid) => {
      const m = main(nsid);
      return new Set([...Object.keys(m?.parameters?.properties ?? {}), ...Object.keys(m?.input?.schema?.properties ?? {})]);
    },
    errors: (nsid) => new Set((main(nsid)?.errors ?? []).map((e) => e.name)),
  };
}
