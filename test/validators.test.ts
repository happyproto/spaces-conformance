import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Assertion, type Catalogue, levelProblems, loadCatalogue, validateCatalogue } from '../harness/catalogue.ts';
import { validateDeviations } from '../harness/deviations.ts';
import { claims, loadManifest, loadPins, type Manifest, notApplicable, validateManifest } from '../harness/manifest.ts';
import { validateResults } from '../harness/results.ts';
import { ROOT } from '../harness/schema.ts';
import { loadLexicons } from '../harness/lexicons.ts';
import { anchors, loadRevisions, loadSpecText, plainText, sectionText } from '../harness/spec.ts';

const revisions = loadRevisions();
const revKeys = Object.keys(revisions.revisions);
let spec = '';
let cat: Catalogue;
let specAnchors: Set<string>;

beforeAll(async () => {
  spec = await loadSpecText(revisions.revisions[revisions.default]);
  specAnchors = anchors(spec);
  cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
});

const row = (over: Partial<Assertion>): Assertion => ({
  id: 'test.row',
  suite: 'digest',
  section: '#commit-digest',
  quote: "The commit's `data` is `sha256(state)`, a 32-byte digest of the 2048-byte buffer.",
  level: 'must',
  basis: ['definition'],
  roles: ['repo-host'],
  areas: ['lthash'],
  checks: 'test',
  ...over,
});
const catalogueOf = (...rows: Assertion[]) => ({ revision: '2026-10-29', assertions: rows });

describe('spec text', () => {
  it('gives GitHub heading anchors, including code-span and parenthesised headings', () => {
    for (const a of ['#space-key-skey', '#personalspace', '#presenting-a-space-credential', '#the-sync-boundary-writer-set', '#xrpc-api', '#kem-key'])
      expect(specAnchors.has(a), a).toBe(true);
  });
  it('strips links, code spans and emphasis for quote matching', () => {
    expect(plainText('a **set hash** over [commit](#space-repos) `data`')).toBe('a set hash over commit data');
    expect(plainText('may *not* include `*` or `collection=*`, and _(none)_')).toBe('may not include * or collection=*, and (none)');
  });
});

describe('catalogue', () => {
  it('accepts the shipped catalogue', () => {
    expect(validateCatalogue(cat, 'assertions.yaml', spec, revKeys, loadLexicons(revisions.revisions[revisions.default]))).toEqual([]);
  });

  it.each([
    ['must with keyword basis but no MUST in the quote', row({ basis: ['keyword'] }), /no MUST keyword/],
    ['should with a definition basis', row({ level: 'should', basis: ['definition'] }), /makes a row must/],
    ['default basis without a stated default', row({ level: 'should', basis: ['default'] }), /does not state a default/],
    ['default basis on a must row', row({ basis: ['definition', 'default'], quote: 'short-lived (default 60 seconds)' }), /only supports level should/],
    ['lexicon basis without an NSID', row({ basis: ['lexicon'] }), /needs a lexicon NSID/],
    ['must with no basis', row({ basis: undefined }), /needs a basis/],
    ['must with no quote', row({ quote: undefined }), /needs a quote/],
    ['must with no section', row({ section: undefined }), /may omit section/],
  ])('rejects %s', (_name, a, message) => {
    expect(levelProblems(a).join('\n')).toMatch(message);
  });

  it('accepts a lowercase "must" as a keyword', () => {
    expect(levelProblems(row({ basis: ['keyword'], quote: 'then the response must also include the commit' }))).toEqual([]);
  });

  it('accepts a should row whose quote states the default', () => {
    const quote = 'The token is single-use, short-lived (default 60 seconds), and addressed (`aud`) to the space authority.';
    expect(levelProblems(row({ level: 'should', basis: ['default'], quote }))).toEqual([]);
  });

  it('rejects a quote that is not in the pinned revision', () => {
    const p = validateCatalogue(catalogueOf(row({ quote: 'The commit is signed with the instance key.' })), 'f', spec, revKeys);
    expect(p.map((x) => x.message)).toContain('quote not found verbatim in revision 2026-10-29');
  });

  it('rejects a quote that is in the revision but outside the section it cites', () => {
    const p = validateCatalogue(catalogueOf(row({ section: '#incremental-sync' })), 'f', spec, revKeys).map((x) => x.message);
    expect(p).toContain('quote is in revision 2026-10-29 but not under #incremental-sync');
  });

  it('treats a section as including its subsections', () => {
    const quote = 'On authorization, the space host uses `credentialKid` as the space credential\'s `cnf.kid`.';
    expect(validateCatalogue(catalogueOf(row({ section: '#space-credential', quote })), 'f', spec, revKeys)).toEqual([]);
    const p = validateCatalogue(catalogueOf(row({ section: '#access-control', quote })), 'f', spec, revKeys).map((x) => x.message);
    expect(p).toEqual([]);
    expect(sectionText(spec, '#requesting-a-space-credential')).toMatch(/^#### Requesting a space credential/);
    expect(sectionText(spec, '#requesting-a-space-credential')).not.toMatch(/Presenting a space credential/);
  });

  it('rejects an unknown section anchor, duplicate ids and unknown revisions', () => {
    const p = validateCatalogue(
      catalogueOf(row({ section: '#no-such-heading' }), row({ since: '2027-01-01' })),
      'f',
      spec,
      revKeys,
    ).map((x) => x.message);
    expect(p).toContain('section #no-such-heading is not a heading anchor in revision 2026-10-29');
    expect(p).toContain('duplicate id');
    expect(p).toContain('revision 2027-01-01 is not in spec/revisions.json');
  });

  it('checks lexicon NSIDs, params and error names against the pinned lexicons', () => {
    const lex = loadLexicons(revisions.revisions[revisions.default]);
    const lexRow = (over: Partial<Assertion>) => row({ basis: ['lexicon'], quote: undefined, section: undefined, ...over });
    const msgs = (a: Assertion) => validateCatalogue(catalogueOf(a), 'f', spec, revKeys, lex).map((x) => x.message);
    expect(msgs(lexRow({ lexicon: 'com.atproto.space.listRepoOps', params: ['space', 'repo', 'since'] }))).toEqual([]);
    expect(msgs(lexRow({ lexicon: 'com.atproto.space.nope' }))).toContain('lexicon com.atproto.space.nope is not in the pinned lexicons');
    expect(msgs(lexRow({ lexicon: 'com.atproto.space.listRepos', params: ['since'] }))).toContain(
      'lexicon com.atproto.space.listRepos defines no parameter or input field since',
    );
    expect(msgs(lexRow({ id: 'xrpc.error.Nope', lexicon: 'com.atproto.space.getSpace', error: 'Nope' }))).toContain(
      'lexicon com.atproto.space.getSpace declares no error Nope',
    );
    expect(levelProblems(lexRow({ id: 'xrpc.error.SpaceNotFound', lexicon: 'com.atproto.space.getSpace' }))).toContain(
      'xrpc.error.<Name> rows need error: <Name>',
    );
    expect(levelProblems(row({ params: ['space'] }))).toContain('params and error need a lexicon');
  });

  it('refuses a lexicon directory that no longer matches its pinned digest', () => {
    const rev = revisions.revisions[revisions.default];
    expect(() => loadLexicons({ ...rev, lexicons: { ...rev.lexicons, sha256: '0'.repeat(64) } })).toThrow(/digest/);
  });

  it('requires areas on every row, non-empty in the crypto suites', () => {
    const missing = validateCatalogue(catalogueOf({ ...row({}), areas: undefined as never }), 'f', spec, revKeys).map((x) => x.message);
    expect(missing.join()).toMatch(/must have required property 'areas'/);
    const empty = validateCatalogue(catalogueOf(row({ areas: [] })), 'f', spec, revKeys).map((x) => x.message);
    expect(empty).toContain("suite digest relies on harness crypto, so areas can't be empty without a no_crypto reason");
    expect(validateCatalogue(catalogueOf(row({ suite: 'records', areas: [] })), 'f', spec, revKeys)).toEqual([]);
  });

  it('lets a crypto-suite row use no crypto only with a reason, and only with areas: []', () => {
    const why = 'reads a DID document and runs no harness crypto';
    expect(validateCatalogue(catalogueOf(row({ areas: [], no_crypto: why })), 'f', spec, revKeys)).toEqual([]);
    const both = validateCatalogue(catalogueOf(row({ areas: ['lthash'], no_crypto: why })), 'f', spec, revKeys).map((x) => x.message);
    expect(both).toContain('no_crypto is only for a row with areas: []');
  });

  it('rejects schema violations before the level rule', () => {
    const p = validateCatalogue(catalogueOf({ ...row({}), level: 'may' as never }), 'f', spec, revKeys);
    expect(p[0].message).toMatch(/must be equal to one of the allowed values/);
  });
});

describe('manifests', () => {
  const pins = loadPins(join(ROOT, 'pins', 'images.env'));
  const ids = new Set(['happyview', 'pdsjs', 'zds']);
  const file = (id: string) => join(ROOT, 'implementations', id, 'manifest.yaml');

  it.each([...ids])('accepts %s', (id) => {
    expect(validateManifest(loadManifest(file(id)), file(id), { revisions: revKeys, pins, ids })).toEqual([]);
  });

  it('rejects a bespoke space host that claims the pds role, an unknown pin and an unknown partner', () => {
    const m = loadManifest(file('happyview'));
    const bad = { ...m, roles: [...m.roles, 'pds'], image: { ...m.image, pin: 'NOPE_IMAGE' }, accounts: { ...m.accounts, partner: 'nope' } };
    const p = validateManifest(bad, file('happyview'), { revisions: revKeys, pins, ids }).map((x) => x.message);
    expect(p).toContain('a bespoke-space-host does not claim the pds role');
    expect(p).toContain('image.pin NOPE_IMAGE has no line in pins/images.env');
    expect(p).toContain('accounts.partner nope is not an implementation');
  });

  it('requires a partner for external accounts', () => {
    const m = loadManifest(file('happyview'));
    const p = validateManifest({ ...m, accounts: { mode: 'external', write_auth: 'oauth-dpop' } }, file('happyview'), { revisions: revKeys, pins, ids });
    expect(p.map((x) => x.message).join()).toMatch(/partner/);
  });

  it('reserves the harness capability namespace', () => {
    const m = loadManifest(file('zds'));
    const p = validateManifest({ ...m, capabilities: { ...m.capabilities, harness: { credential_reads: true } } }, file('zds'), { revisions: revKeys, pins, ids });
    expect(p.map((x) => x.message).join()).toMatch(/property name/);
  });

  it('resolves capability paths through objects and arrays', () => {
    const caps = { policies: ['memberspace', 'managedspace'], repo_host: { foreign_authorities: false }, oauth: { scripted: true } };
    expect(claims(caps, 'policies.managedspace')).toBe(true);
    expect(claims(caps, 'policies.personalspace')).toBe(false);
    expect(claims(caps, 'policies')).toBe(true);
    expect(claims(caps, 'repo_host.foreign_authorities')).toBe(false);
    expect(claims(caps, 'oauth.scripted')).toBe(true);
    expect(claims(caps, 'space-type-resolution')).toBe(false);
  });

  it('says why an assertion does not apply', () => {
    const hv = loadManifest(file('happyview')) as Manifest;
    expect(notApplicable(row({ roles: ['pds'] }), hv)).toMatch(/role pds/);
    expect(notApplicable(row({ roles: ['space-host'], profiles: ['pds'] }), hv)).toMatch(/profile bespoke-space-host/);
    expect(notApplicable(row({ requires: ['repo_host.foreign_authorities'] }), hv)).toMatch(/capability repo_host.foreign_authorities/);
    expect(notApplicable(row({ requires: ['policies.managedspace'] }), hv)).toBeNull();
  });
});

describe('deviations', () => {
  const entry = {
    assertion: 'records.params-repo',
    cause: 'repo-host-pre-0016',
    reason: 'getLatestCommit takes did, not repo.',
    spec: '#xrpc-api',
    tracking: 'HAP-388 (PR 6)',
    since: '2026-11-08',
  };

  it('accepts a well-formed list', () => {
    expect(validateDeviations([entry, { ...entry, assertion: 'oplog.entry-shape', tracking: 'HAP-409' }], 'd', cat, specAnchors, '2026-11-09')).toEqual([]);
  });

  it.each([
    ['tracking: pending', { tracking: 'pending' }, /must match pattern/],
    ['an unknown assertion', { assertion: 'nope.nope' }, /not in the catalogue/],
    ['an unknown anchor', { spec: '#nope' }, /not a heading anchor/],
    ['a future date', { since: '2026-12-01' }, /in the future/],
    ['a missing reason', { reason: undefined }, /must have required property 'reason'/],
  ])('rejects %s', (_name, over, message) => {
    const p = validateDeviations([{ ...entry, ...over }], 'd', cat, specAnchors, '2026-11-09');
    expect(p.map((x) => x.message).join('\n')).toMatch(message);
  });

  it('rejects an assertion listed twice', () => {
    expect(validateDeviations([entry, entry], 'd', cat, specAnchors, '2026-11-09').map((x) => x.message)).toContain('assertion listed twice');
  });
});

describe('results', () => {
  const example = () => JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'results', 'example-happyview.json'), 'utf8'));

  it('accepts the example result file', () => {
    expect(validateResults(example(), 'r', cat)).toEqual([]);
  });

  it('rejects a skip without a reason and evidence on a pass', () => {
    const r = example();
    delete r.results[2].skip_reason;
    r.results[1].evidence = { x: 1 };
    expect(validateResults(r, 'r', cat).length).toBeGreaterThanOrEqual(2);
  });

  it('rejects oversized evidence, unknown ids and deviations with no result', () => {
    const r = example();
    r.results[0].evidence = { body: 'x'.repeat(5000) };
    r.results[1].id = 'nope.nope';
    r.deviations_applied.push({ ...r.deviations_applied[0], assertion: 'oplog.entry-shape' });
    const p = validateResults(r, 'r', cat).map((x) => x.message);
    expect(p).toContain('evidence is over 4096 bytes');
    expect(p).toContain('assertion is not in the catalogue');
    expect(p).toContain('deviation applied to an assertion with no result');
  });

  it('rejects an image without a digest and a summary with more passes than assertions', () => {
    const r = example();
    r.implementation.image = 'ghcr.io/x/y:latest';
    expect(validateResults(r, 'r').length).toBeGreaterThan(0);
    const s = example();
    s.summary.by_role['repo-host'].must_pass = 9;
    expect(validateResults(s, 'r').map((x) => x.message)).toContain('more passes than applicable assertions');
  });
});
