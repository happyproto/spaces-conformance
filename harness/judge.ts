// Judge one results file as `conformance verdict` does: each row as it read
// at the revision the run graded, against the deviation list the run applied
// (or another list), with the vector and lineage fences in force at this
// suite commit. cli/verdict.ts, cli/report.ts, cli/prune.ts and the site all
// call this, so the display states they show can't drift apart.

import { join } from 'node:path';
import { type Assertion, loadCatalogue, resolveCatalogue } from './catalogue.ts';
import { type Deviation, deviationsAt } from './deviations.ts';
import { loadIndependence } from './independence.ts';
import { vectorStatus } from './provisional.ts';
import { ROOT } from './schema.ts';
import { type Judged, judgeAll, type Raw, type Summary } from './verdict.ts';

/** The fields of a results file (schemas/results.schema.json) that judging and the reports read. */
export interface ResultsFile {
  schema: 1;
  run: {
    id: string;
    kind: 'nightly' | 'candidate' | 'release' | 'local';
    started_at: string;
    finished_at: string;
    attempt: number;
    slow?: boolean;
    ci_url?: string;
    logs_artifact?: string;
    previous_attempts?: { id: string; failed: string[]; errored: string[] }[];
    infrastructure?: string;
    fingerprint?: { digest: string; code: string; images: Record<string, string>; revision: { key: string; proposal: string; lexicons: string }; slow: boolean };
  };
  suite: { commit: string; assertions_digest: string; assertion_digests?: Record<string, string> };
  spec: { proposal: string; revision: string; commit: string; lexicons: string };
  implementation: {
    id: string;
    image: string;
    source_revision?: string;
    upstream_ref?: string;
    roles: Assertion['roles'];
    profile: string;
    write_auth: string;
    setup_mode: { accounts: string; spaces: string; bootstrap?: string };
  };
  peers: { id: string; as?: string; image: string }[];
  deviations_applied: Deviation[];
  results: {
    id: string;
    suite?: string;
    status: Raw;
    ms?: number;
    message?: string;
    skip_reason?: string;
    evidence?: Record<string, unknown>;
    flaky?: unknown;
  }[];
  summary: Summary;
}

export interface JudgedFile {
  judged: Judged[];
  summary: Summary;
  /** The catalogue rows as they read at the graded revision, by id. */
  rows: Map<string, Assertion>;
  /** The deviation entries in force at the graded revision, by assertion id. */
  listed: Map<string, Deviation>;
}

export function judgeFile(file: ResultsFile, deviations: Deviation[] = file.deviations_applied): JudgedFile {
  const catalogue = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
  const revision = file.spec.revision;
  const rows = new Map(resolveCatalogue(catalogue, revision).map((a) => [a.id, a]));
  const listed = new Map(deviationsAt(deviations, revision).map((d) => [d.assertion, d]));
  const { judged, summary } = judgeAll(file.results, rows, listed, vectorStatus(), file.implementation.roles, loadIndependence(revision));
  return { judged, summary, rows, listed };
}
