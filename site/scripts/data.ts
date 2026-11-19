// The site's data step (design ch. 8.2): read the results store, judge every
// run the way `conformance verdict` does (harness/judge.ts), and write one
// JSON file the Astro pages render from. Nothing else reads the store.
//
//   RESULTS_STORE=<checkout of the results branch> node site/scripts/data.ts
//   SEED=fixtures node site/scripts/data.ts      a store built from the committed pass-index runs
//
// It fails closed: if the store has any problem (a run that fails the results
// schema, a misfiled run, an index that isn't what runs/ rebuilds to), it
// exits 1 and writes nothing, so nothing deploys.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Assertion, loadCatalogue, resolveCatalogue } from '../../harness/catalogue.ts';
import { judgeFile, type ResultsFile } from '../../harness/judge.ts';
import { loadManifest, type Manifest, notApplicable } from '../../harness/manifest.ts';
import { formatProblem } from '../../harness/problems.ts';
import { ROOT } from '../../harness/schema.ts';
import { headings, loadRevisions, loadSpecText, plainText } from '../../harness/spec.ts';
import { addRuns, checkStore, type ImplIndex, type LatestIndex, readRuns } from '../../harness/store.ts';
import type { Display } from '../../harness/verdict.ts';

const OUT = join(ROOT, 'site', 'src', 'data', 'site.json');
const HISTORY_DAYS = 90;

function die(msg: string): never {
  console.error(`site data: ${msg}`);
  process.exit(1);
}

// ---- The store ---------------------------------------------------------------

function seedStore(): string {
  const dir = join(ROOT, 'site', '.seed-store');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'runs'), { recursive: true });
  const index = JSON.parse(readFileSync(join(ROOT, 'evidence', 'passes.json'), 'utf8')) as { sources: { file: string }[] };
  const cat = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
  const { problems } = addRuns(
    dir,
    index.sources.map((s) => ({ name: s.file, data: JSON.parse(readFileSync(join(ROOT, s.file), 'utf8')) })),
    cat,
  );
  if (problems.length) die(problems.map(formatProblem).join('\n'));
  return dir;
}

const store = process.env.RESULTS_STORE || (process.env.SEED === 'fixtures' ? seedStore() : die('set RESULTS_STORE to a checkout of the results branch, or SEED=fixtures'));
const problems = checkStore(store);
if (problems.length) die(`the results store fails its checks, so nothing is built:\n${problems.map(formatProblem).join('\n')}`);
const latest: LatestIndex = JSON.parse(readFileSync(join(store, 'index', 'latest.json'), 'utf8'));
const runs = new Map(readRuns(store).map(({ path, file }) => [path, file]));

// ---- The catalogue, manifests and spec ----------------------------------------

const catalogue = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
const revisions = loadRevisions();
const revisionKeys = Object.keys(revisions.revisions).sort();
const implDir = join(ROOT, 'implementations');
const manifests = new Map<string, Manifest>(
  readdirSync(implDir)
    .filter((d) => existsSync(join(implDir, d, 'manifest.yaml')))
    .map((d) => [d, loadManifest(join(implDir, d, 'manifest.yaml'))]),
);
const SUITES = [...new Set(catalogue.assertions.map((a) => a.suite))];
const SUITE_ORDER = ['addressing', 'records', 'digest', 'mac', 'oplog', 'export', 'lifecycle', 'credentials', 'scopes', 'writer-set', 'policy', 'deletion', 'migration'];
SUITES.sort((a, b) => (SUITE_ORDER.indexOf(a) + 1 || 99) - (SUITE_ORDER.indexOf(b) + 1 || 99));

const specUrl = (rev: string, anchor?: string) => {
  const r = revisions.revisions[rev];
  return `https://github.com/${r.repo}/blob/${r.commit}/${r.path}${anchor ?? ''}`;
};

// ---- Display states, as the site groups them ---------------------------------

/**
 * The site's tally groups. Display states come from harness/verdict.ts; the
 * site adds two the verdict folds into "not applicable": `pending` (a row the
 * harness couldn't judge yet, raw skip with a pending reason) and `untested`
 * (an applicable row with no test, so no result at all).
 */
type Group = 'pass' | 'deviation' | 'fail' | 'provisional' | 'error' | 'pending' | 'untested' | 'na';
const GROUP: Record<Display, Group> = {
  pass: 'pass',
  'pass (flaky)': 'pass',
  'fixed, still listed': 'pass',
  'known deviation': 'deviation',
  fail: 'fail',
  'deviation changed': 'fail',
  'fail (provisional)': 'provisional',
  error: 'error',
  'not applicable': 'na',
};

interface Row {
  id: string;
  suite: string;
  level: Assertion['level'] | 'retired';
  group: Group;
  display: string;
  message?: string;
  provisional?: string;
  changed?: string;
  ms?: number;
}

type Tally = Record<Group, number>;
const emptyTally = (): Tally => ({ pass: 0, deviation: 0, fail: 0, provisional: 0, error: 0, pending: 0, untested: 0, na: 0 });

const daysBetween = (from: string, to: string) => Math.max(0, Math.floor((Date.parse(to) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));

function view(path: string, file: ResultsFile) {
  const manifest = manifests.get(file.implementation.id);
  const { judged, summary, rows: catRows, listed } = judgeFile(file);
  const byId = new Map(file.results.map((r) => [r.id, r]));
  const rows: Row[] = judged.map((j) => {
    const r = byId.get(j.id)!;
    const a = catRows.get(j.id);
    const pending = j.raw === 'skip' && /^pending\b/.test(r.skip_reason ?? '');
    return {
      id: j.id,
      suite: a?.suite ?? r.suite ?? 'retired',
      level: a?.level ?? 'retired',
      group: pending ? 'pending' : GROUP[j.display],
      display: pending ? 'pending' : j.display,
      ...(r.message || r.skip_reason ? { message: (r.message ?? r.skip_reason)!.replace(/^pending: /, '') } : {}),
      ...(j.provisional && j.display !== 'not applicable' ? { provisional: j.provisional } : {}),
      ...(j.changed ? { changed: j.changed } : {}),
      ...(r.ms !== undefined ? { ms: r.ms } : {}),
    };
  });
  // Applicable rows the run has no result for: no test exists yet.
  if (manifest)
    for (const a of catRows.values())
      if (!byId.has(a.id) && notApplicable(a, manifest) === null)
        rows.push({ id: a.id, suite: a.suite, level: a.level, group: 'untested', display: 'no test yet' });
  rows.sort((x, y) => SUITES.indexOf(x.suite) - SUITES.indexOf(y.suite) || (x.id < y.id ? -1 : 1));

  const bySuite: Record<string, Tally> = Object.fromEntries(SUITES.map((s) => [s, emptyTally()]));
  const total = emptyTally();
  for (const r of rows) {
    (bySuite[r.suite] ??= emptyTally())[r.group]++;
    total[r.group]++;
  }

  // Deviations by cause, each entry with its age on the day of the run.
  const causes = new Map<string, { assertion: string; reason: string; tracking: string; spec: string; since: string; age_days: number; display: string }[]>();
  for (const d of listed.values()) {
    const row = rows.find((r) => r.id === d.assertion);
    if (!causes.has(d.cause)) causes.set(d.cause, []);
    causes.get(d.cause)!.push({
      assertion: d.assertion,
      reason: d.reason,
      tracking: d.tracking,
      spec: d.spec,
      since: d.since,
      age_days: daysBetween(d.since, file.run.finished_at),
      display: row?.display ?? 'no result',
    });
  }

  return {
    id: file.run.id,
    path,
    kind: file.run.kind,
    started_at: file.run.started_at,
    finished_at: file.run.finished_at,
    slow: file.run.slow === true,
    ci_url: file.run.ci_url ?? null,
    logs_artifact: file.run.logs_artifact ?? null,
    attempt: file.run.attempt,
    previous_attempts: file.run.previous_attempts ?? [],
    image: file.implementation.image,
    source_revision: file.implementation.source_revision ?? null,
    setup_mode: file.implementation.setup_mode,
    write_auth: file.implementation.write_auth,
    peers: file.peers,
    revision: file.spec.revision,
    spec_commit: file.spec.commit,
    lexicons: file.spec.lexicons,
    suite_commit: file.suite.commit,
    summary: summary.by_role,
    unexpected: summary.unexpected,
    total,
    bySuite,
    rows,
    deviations: [...causes].map(([cause, entries]) => ({ cause, entries })).sort((a, b) => b.entries.length - a.entries.length || (a.cause < b.cause ? -1 : 1)),
  };
}
type RunView = ReturnType<typeof view>;

// ---- Implementations ---------------------------------------------------------

/** What an implementation's manifest rules out, said plainly. Shown, never hidden. */
function limits(m: Manifest): string[] {
  const out: string[] = [];
  const caps = m.capabilities as { repo_host?: { foreign_authorities?: boolean }; oauth?: { scripted?: boolean } };
  if (m.profile === 'bespoke-space-host')
    out.push('Spaces live on DIDs the host mints, and nobody signs in as them, so the assertions anchored on the authority being a signed-in account don’t apply.');
  if (!m.roles.includes('pds')) out.push('Doesn’t claim the PDS role, so the baseline every PDS must serve isn’t graded.');
  if (m.roles.includes('repo-host') && caps.repo_host?.foreign_authorities === false) out.push('Hosts repos only in its own spaces.');
  if (caps.oauth?.scripted === false) out.push('Its OAuth consent can’t be scripted, so the assertions that need a scripted grant don’t run.');
  return out;
}

const now = latest.updated_at ?? new Date(0).toISOString();
const views = new Map<string, RunView>();
const viewOf = (path: string) => {
  if (!views.has(path)) views.set(path, view(path, runs.get(path)!));
  return views.get(path)!;
};

const implementations = [...manifests.values()]
  .map((m) => {
    const indexPath = join(store, 'index', `${m.id}.json`);
    const history: ImplIndex['runs'] = existsSync(indexPath) ? (JSON.parse(readFileSync(indexPath, 'utf8')) as ImplIndex).runs : [];
    const cutoff = Date.parse(now) - HISTORY_DAYS * 86_400_000;
    const latestRuns = Object.fromEntries(Object.entries(latest.implementations[m.id] ?? {}).map(([rev, p]) => [rev, viewOf(p.path)]));
    const candidates = Object.fromEntries(Object.entries(latest.candidates[m.id] ?? {}).map(([rev, p]) => [rev, viewOf(p.path)]));
    return {
      id: m.id,
      name: m.name,
      homepage: (m.homepage as string | undefined) ?? null,
      source: (m.source as string | undefined) ?? null,
      roles: m.roles,
      profile: m.profile,
      spec_revisions: m.spec_revisions,
      limits: limits(m),
      latest: latestRuns,
      candidates,
      history: history
        .filter((r) => Date.parse(r.started_at) >= cutoff)
        .map((r) => {
          const v = viewOf(r.path);
          return {
            id: r.id,
            kind: r.kind,
            started_at: r.started_at,
            revision: r.revision,
            image: r.image,
            ci_url: r.ci_url ?? null,
            summary: v.summary,
            total: v.total,
          };
        }),
    };
  })
  .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));

// ---- Assertions --------------------------------------------------------------

const assertions = catalogue.assertions.map((base) => {
  const at = revisionKeys
    .map((rev) => ({ rev, a: resolveCatalogue(catalogue, rev).find((x) => x.id === base.id) }))
    .filter((x): x is { rev: string; a: Assertion } => !!x.a);
  const results = implementations.flatMap((impl) =>
    Object.entries(impl.latest).map(([rev, v]) => {
      const row = v.rows.find((r) => r.id === base.id);
      const m = manifests.get(impl.id)!;
      const a = at.find((x) => x.rev === rev)?.a;
      const na = a ? notApplicable(a, m) : `not in revision ${rev}`;
      return {
        implementation: impl.id,
        name: impl.name,
        revision: rev,
        run: v.id,
        ci_url: v.ci_url,
        group: row?.group ?? 'na',
        display: row?.display ?? 'not applicable',
        message: row?.message ?? (row ? undefined : (na ?? undefined)),
        provisional: row?.provisional,
      };
    }),
  );
  return {
    id: base.id,
    suite: base.suite,
    checks: base.checks,
    roles: base.roles,
    profiles: base.profiles ?? ['pds', 'bespoke-space-host'],
    requires: base.requires ?? [],
    areas: base.areas,
    provisional: base.provisional === true,
    needs_slow: base.needs_slow === true,
    revisions: at.map(({ rev, a }) => ({
      revision: rev,
      level: a.level,
      basis: a.basis ?? [],
      section: a.section ?? null,
      section_url: a.section ? specUrl(rev, a.section) : null,
      // Quotes are copied from the Markdown; the page shows them as prose.
      // A quoted table row keeps its cells apart.
      quote: a.quote
        ? /^\s*\|/.test(a.quote)
          ? a.quote.split('|').map((c) => plainText(c)).filter(Boolean).join(' \u00b7 ')
          : plainText(a.quote)
        : null,
      lexicon: a.lexicon ?? null,
      checks: a.checks,
    })),
    results,
  };
});

// ---- Spec coverage -----------------------------------------------------------

const coverage = [];
for (const rev of revisionKeys) {
  const text = await loadSpecText(revisions.revisions[rev]);
  const rows = resolveCatalogue(catalogue, rev);
  const counts = new Map<string, { must: number; should: number; info: number; ids: string[] }>();
  for (const a of rows) {
    if (!a.section) continue;
    const c = counts.get(a.section) ?? { must: 0, should: 0, info: 0, ids: [] };
    c[a.level]++;
    c.ids.push(a.id);
    counts.set(a.section, c);
  }
  const hs = headings(text).filter((h) => h.level >= 2);
  coverage.push({
    revision: rev,
    commit: revisions.revisions[rev].commit,
    url: specUrl(rev),
    lexicon_only: rows.filter((a) => !a.section).map((a) => a.id),
    sections: hs.map((h) => ({ anchor: h.anchor, title: h.title, level: h.level, url: specUrl(rev, h.anchor), ...(counts.get(h.anchor) ?? { must: 0, should: 0, info: 0, ids: [] }) })),
  });
}

// ---- Out ---------------------------------------------------------------------

const site = {
  generated: {
    store_updated_at: latest.updated_at,
    suite_commits: [...new Set([...views.values()].map((v) => v.suite_commit))],
    revisions: revisionKeys.map((k) => ({ key: k, commit: revisions.revisions[k].commit, lexicons: revisions.revisions[k].lexicons.commit, url: specUrl(k) })),
  },
  suites: SUITES,
  implementations,
  assertions,
  coverage,
};
mkdirSync(join(OUT, '..'), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(site)}\n`);
console.log(`site data: ${implementations.length} implementations, ${views.size} runs, ${assertions.length} assertions -> ${OUT.slice(ROOT.length + 1)}`);

/** The shape of src/data/site.json, for the pages. */
export type SiteData = typeof site;
