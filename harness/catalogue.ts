// The assertion catalogue (spec/assertions.yaml) and its validator.
//
// Beyond the schema, every row must satisfy the level rule (design ch. 3.1):
//
//   must    the quote has MUST / MUST NOT / REQUIRED / SHALL or a lowercase
//           "must"; or basis includes definition, lexicon or host-honours-may.
//   should  the quote has SHOULD / RECOMMENDED / "should"; or basis includes
//           default and the quote states the value as a default.
//   info    anything.
//
// and each declared basis must hold on its own: `keyword` needs a keyword of
// the row's level in the quote, `default` needs the word "default", and
// `lexicon` needs a lexicon NSID. Quotes must appear in the pinned revision,
// inside the section they cite (subsections included), and sections must be
// anchors in it.

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Lexicons } from './lexicons.ts';
import type { Problem } from './problems.ts';
import { checkSchema } from './schema.ts';
import { anchors, plainText, sectionText } from './spec.ts';

export type Level = 'must' | 'should' | 'info';
export type Basis = 'keyword' | 'definition' | 'lexicon' | 'host-honours-may' | 'default';
export type Role = 'repo-host' | 'space-host' | 'pds';
export type Profile = 'pds' | 'bespoke-space-host';

export interface Assertion {
  id: string;
  suite: string;
  section?: string;
  quote?: string;
  level: Level;
  basis?: Basis[];
  roles: Role[];
  profiles?: Profile[];
  requires?: string[];
  lexicon?: string | string[];
  params?: string[];
  error?: string;
  checks: string;
  since?: string;
  until?: string;
  provisional?: boolean;
  areas: ('cbor' | 'lthash' | 'mac' | 'httpsig' | 'jwt' | 'star')[];
  /** Why a row in a crypto suite uses no harness crypto (areas: []). */
  no_crypto?: string;
}

export interface Catalogue {
  revision: string;
  assertions: Assertion[];
}

export function loadCatalogue(path: string): Catalogue {
  return parse(readFileSync(path, 'utf8'));
}

/** Suites whose every check runs through harness crypto, so each row must say which areas. */
const CRYPTO_SUITES = new Set(['digest', 'mac', 'export']);

const MUST_KEYWORD = /\b(MUST|REQUIRED|SHALL)\b|\bmust\b/;
const SHOULD_KEYWORD = /\b(SHOULD|RECOMMENDED)\b|\bshould\b/;
const DEFAULT_WORD = /\bdefaults?\b/i;

/** The level-rule problems for one row, as messages. Exported for tests. */
export function levelProblems(a: Assertion): string[] {
  const out: string[] = [];
  const quote = a.quote ? plainText(a.quote) : '';
  const basis = new Set(a.basis ?? []);

  if (a.level !== 'info' && basis.size === 0) out.push(`level ${a.level} needs a basis`);
  if (a.level !== 'info' && !a.quote && !basis.has('lexicon')) out.push(`level ${a.level} needs a quote`);

  if (a.level === 'must') {
    const ok =
      (basis.has('keyword') && MUST_KEYWORD.test(quote)) ||
      basis.has('definition') ||
      basis.has('lexicon') ||
      basis.has('host-honours-may');
    if (!ok && basis.size > 0) out.push('level must needs a MUST/REQUIRED keyword in the quote, or a definition, lexicon or host-honours-may basis');
    if (basis.has('default')) out.push('basis default only supports level should');
  }
  if (a.level === 'should') {
    const ok = (basis.has('keyword') && SHOULD_KEYWORD.test(quote)) || (basis.has('default') && DEFAULT_WORD.test(quote));
    if (!ok && basis.size > 0) out.push('level should needs a SHOULD keyword in the quote, or a default basis whose quote states the default');
    for (const b of ['definition', 'lexicon', 'host-honours-may'] as const) {
      if (basis.has(b)) out.push(`basis ${b} makes a row must, not should`);
    }
  }

  if (basis.has('keyword')) {
    const kw = a.level === 'should' ? SHOULD_KEYWORD : MUST_KEYWORD;
    if (!kw.test(quote)) out.push(`basis keyword, but the quote has no ${a.level === 'should' ? 'SHOULD' : 'MUST'} keyword`);
  }
  if (basis.has('default') && !DEFAULT_WORD.test(quote)) out.push('basis default, but the quote does not state a default');
  if (basis.has('lexicon') && !a.lexicon) out.push('basis lexicon needs a lexicon NSID');
  if (a.lexicon && !basis.has('lexicon')) out.push('lexicon is set but basis does not include lexicon');
  if ((a.params || a.error) && !a.lexicon) out.push('params and error need a lexicon');
  if (a.id.startsWith('xrpc.error.') && a.error !== a.id.slice('xrpc.error.'.length)) out.push('xrpc.error.<Name> rows need error: <Name>');
  if (!a.section && !basis.has('lexicon') && a.level !== 'info') out.push('only lexicon and info rows may omit section');
  return out;
}

/**
 * Validate a parsed catalogue. `specText` is the pinned revision's Markdown;
 * `revisions` the known revision keys (for since/until).
 */
export function validateCatalogue(cat: unknown, file: string, specText: string, revisions: string[], lex?: Lexicons): Problem[] {
  const problems = checkSchema('assertions', cat, file);
  if (problems.length) return problems;
  const c = cat as Catalogue;
  if (!revisions.includes(c.revision)) problems.push({ file, message: `revision ${c.revision} is not in spec/revisions.json` });

  const specPlain = plainText(specText);
  const specAnchors = anchors(specText);
  const seen = new Set<string>();

  for (const a of c.assertions) {
    const at = (message: string) => problems.push({ file, where: a.id, message });
    if (seen.has(a.id)) at('duplicate id');
    seen.add(a.id);
    for (const m of levelProblems(a)) at(m);
    if (a.section && !specAnchors.has(a.section)) at(`section ${a.section} is not a heading anchor in revision ${c.revision}`);
    if (a.quote && !specPlain.includes(plainText(a.quote))) at(`quote not found verbatim in revision ${c.revision}`);
    else if (a.quote && a.section && specAnchors.has(a.section)) {
      const section = sectionText(specText, a.section) ?? '';
      if (!plainText(section).includes(plainText(a.quote))) at(`quote is in revision ${c.revision} but not under ${a.section}`);
    }
    for (const r of [a.since, a.until]) if (r && !revisions.includes(r)) at(`revision ${r} is not in spec/revisions.json`);
    if (a.id.startsWith('info.') && a.level !== 'info') at('info.* ids must be level info');
    if (CRYPTO_SUITES.has(a.suite) && !a.areas?.length && !a.no_crypto)
      at(`suite ${a.suite} relies on harness crypto, so areas can't be empty without a no_crypto reason`);
    if (a.no_crypto && a.areas?.length) at('no_crypto is only for a row with areas: []');
    if (lex && a.lexicon) {
      for (const nsid of lexiconsOf(a)) {
        if (!lex.has(nsid)) {
          at(`lexicon ${nsid} is not in the pinned lexicons`);
          continue;
        }
        const fields = lex.fields(nsid);
        for (const p of a.params ?? []) if (!fields.has(p)) at(`lexicon ${nsid} defines no parameter or input field ${p}`);
        if (a.error && !lex.errors(nsid).has(a.error)) at(`lexicon ${nsid} declares no error ${a.error}`);
      }
    }
  }
  return problems;
}

export function lexiconsOf(a: Assertion): string[] {
  return a.lexicon === undefined ? [] : Array.isArray(a.lexicon) ? a.lexicon : [a.lexicon];
}

/** Which profiles an assertion applies to (default: all). */
export function profilesOf(a: Assertion): Profile[] {
  return a.profiles ?? ['pds', 'bespoke-space-host'];
}
