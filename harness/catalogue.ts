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
  /** Why the row stops at `until` although its citation still reads the same later. */
  ended?: string;
  provisional?: boolean;
  areas: ('cbor' | 'lthash' | 'mac' | 'httpsig' | 'jwt' | 'star')[];
  /** Why a row in a crypto suite uses no harness crypto (areas: []). */
  no_crypto?: string;
  /** Per revision key, the fields that read differently from that revision on. */
  variants?: Record<string, Variant>;
}

/** What a later revision may change about a row: its spec citation, what it checks, and the crypto that check uses. */
export type Variant = Partial<Pick<Assertion, 'section' | 'quote' | 'level' | 'basis' | 'lexicon' | 'params' | 'error' | 'checks' | 'areas' | 'no_crypto'>>;

export interface Catalogue {
  /** The base revision: every row's fields read as of this one, unless the row's since is later. */
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

/** The pinned text (and lexicons, when checked) of one revision. */
export interface RevisionText {
  text: string;
  lex?: Lexicons;
}

/**
 * Validate a parsed catalogue against every revision it's given. `specText`
 * is either the base revision's Markdown (and `lex` its lexicons), or a map
 * from revision key to that revision's text and lexicons. `revisions` are the
 * known revision keys, for since, until and variant keys.
 *
 * Each row is resolved at each revision it applies to (resolveAt), and its
 * quote, section and lexicons are checked against that revision. So a quote
 * the spec reworded fails at the new revision until a variant gives the new
 * wording, or until ends the row before it.
 */
export function validateCatalogue(
  cat: unknown,
  file: string,
  specText: string | Map<string, RevisionText>,
  revisions: string[],
  lex?: Lexicons,
): Problem[] {
  const problems = checkSchema('assertions', cat, file);
  if (problems.length) return problems;
  const c = cat as Catalogue;
  if (!revisions.includes(c.revision)) problems.push({ file, message: `revision ${c.revision} is not in spec/revisions.json` });
  const texts = typeof specText === 'string' ? new Map([[c.revision, { text: specText, lex }]]) : specText;

  const seen = new Set<string>();
  for (const a of c.assertions) {
    const at = (message: string) => problems.push({ file, where: a.id, message });
    if (seen.has(a.id)) at('duplicate id');
    seen.add(a.id);
    for (const r of [a.since, a.until]) if (r && !revisions.includes(r)) at(`revision ${r} is not in spec/revisions.json`);
    const since = a.since ?? c.revision;
    if (a.until && a.until < since) at(`until ${a.until} is before since ${since}`);
    for (const k of Object.keys(a.variants ?? {})) {
      if (!revisions.includes(k)) at(`variant ${k} is not in spec/revisions.json`);
      else if (k <= since) at(`variant ${k} is not after the row's first revision ${since}: put those fields on the row`);
      else if (a.until && k > a.until) at(`variant ${k} is after until ${a.until}`);
    }
  }

  for (const [rev, { text, lex: revLex }] of texts) {
    const specPlain = plainText(text);
    const specAnchors = anchors(text);
    for (const a of resolveCatalogue(c, rev)) {
      const at = (message: string) => problems.push({ file, where: texts.size > 1 ? `${a.id}@${rev}` : a.id, message });
      for (const m of levelProblems(a)) at(m);
      for (const m of citationProblems(a, rev, text, specPlain, specAnchors)) at(m);
      if (a.id.startsWith('info.') && a.level !== 'info') at('info.* ids must be level info');
      if (CRYPTO_SUITES.has(a.suite) && !a.areas?.length && !a.no_crypto)
        at(`suite ${a.suite} relies on harness crypto, so areas can't be empty without a no_crypto reason`);
      if (a.no_crypto && a.areas?.length) at('no_crypto is only for a row with areas: []');
      for (const m of lexiconProblems(a, rev, revLex)) at(m);
    }
  }

  // An until must not quietly drop a row that still applies: if the row, as
  // it reads at its until, passes every citation check at each later pinned
  // revision, the spec didn't change it, so the until needs an ended reason.
  for (const a of c.assertions) {
    if (!a.until) continue;
    const later = [...texts.keys()].filter((r) => r > a.until!).sort();
    if (!later.length) continue;
    const last = resolveAt(a, a.until, c.revision);
    if (!last) continue;
    const stillReads = later.every((rev) => {
      const { text, lex: revLex } = texts.get(rev)!;
      return !citationProblems(last, rev, text, plainText(text), anchors(text)).length && !lexiconProblems(last, rev, revLex).length;
    });
    if (stillReads && !a.ended)
      problems.push({ file, where: a.id, message: `until ${a.until}, but its quote, section and lexicons still hold at ${later.join(', ')}: give it a variant, or an ended reason` });
    if (!stillReads && a.ended) problems.push({ file, where: a.id, message: 'ended is only for an until whose citation still holds at a later revision' });
  }
  return problems;
}

function citationProblems(a: Assertion, rev: string, text: string, specPlain: string, specAnchors: Set<string>): string[] {
  const out: string[] = [];
  if (a.section && !specAnchors.has(a.section)) out.push(`section ${a.section} is not a heading anchor in revision ${rev}`);
  if (a.quote && !specPlain.includes(plainText(a.quote))) out.push(`quote not found verbatim in revision ${rev}`);
  else if (a.quote && a.section && specAnchors.has(a.section)) {
    const section = sectionText(text, a.section) ?? '';
    if (!plainText(section).includes(plainText(a.quote))) out.push(`quote is in revision ${rev} but not under ${a.section}`);
  }
  return out;
}

function lexiconProblems(a: Assertion, rev: string, revLex: Lexicons | undefined): string[] {
  const out: string[] = [];
  if (!revLex || !a.lexicon) return out;
  for (const nsid of lexiconsOf(a)) {
    if (!revLex.has(nsid)) {
      out.push(`lexicon ${nsid} is not in the lexicons pinned for ${rev}`);
      continue;
    }
    const fields = revLex.fields(nsid);
    for (const p of a.params ?? []) if (!fields.has(p)) out.push(`lexicon ${nsid} defines no parameter or input field ${p}`);
    if (a.error && !revLex.errors(nsid).has(a.error)) out.push(`lexicon ${nsid} declares no error ${a.error}`);
  }
  return out;
}

/** Whether a row applies at revision `rev`: since (default the catalogue's base revision) to until, both inclusive. */
export function appliesAt(a: Assertion, rev: string, base: string): boolean {
  return (a.since ?? base) <= rev && (!a.until || rev <= a.until);
}

/**
 * A row as it reads at revision `rev`, or null when it doesn't apply there.
 * Variants apply from their revision on, each over the ones before it.
 * Revision keys are ISO dates, so they order as strings.
 */
export function resolveAt(a: Assertion, rev: string, base: string): Assertion | null {
  if (!appliesAt(a, rev, base)) return null;
  const { variants, ...row } = a;
  let out: Assertion = row;
  for (const k of Object.keys(variants ?? {}).filter((k) => k <= rev).sort()) out = { ...out, ...variants![k] };
  return out;
}

/** Every row that applies at `rev`, resolved there. */
export function resolveCatalogue(c: Catalogue, rev: string): Assertion[] {
  return c.assertions.map((a) => resolveAt(a, rev, c.revision)).filter((a): a is Assertion => a !== null);
}

export function lexiconsOf(a: Assertion): string[] {
  return a.lexicon === undefined ? [] : Array.isArray(a.lexicon) ? a.lexicon : [a.lexicon];
}

/** Which profiles an assertion applies to (default: all). */
export function profilesOf(a: Assertion): Profile[] {
  return a.profiles ?? ['pds', 'bespoke-space-host'];
}
