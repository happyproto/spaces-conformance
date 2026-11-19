// Scenario fingerprints: what a run's raw results can depend on, hashed, so
// the nightly run grades only scenarios whose inputs changed (Trezy, Nov 19).
//
// A scenario is one implementation graded at one revision, with or without
// --slow. Its fingerprint covers:
//   images    every image in the stack: the implementation's (a candidate's
//             digest replaces the pin's), its partner's, PLC's
//   revision  the revision key and its proposal and lexicon commits
//   slow      whether the slow checks ran
//   code      every file that can change a raw result: harness/, suites/,
//             the catalogue and spec pins, that revision's lexicons, the
//             record fixtures, the base stack, the implementation's folder
//             and its partner's, the dependency lock, the suite config
//
// Left out on purpose, because they change how a result is shown, never the
// result: deviation lists, vectors/ (provisional status), evidence/, docs,
// the site and CI files.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadManifest } from './manifest.ts';
import { ROOT } from './schema.ts';
import { loadRevisions } from './spec.ts';

export interface Fingerprint {
  /** sha256 over the canonical JSON of the other fields. */
  digest: string;
  /** sha256 over the sorted (path, sha256) pairs of the code inputs. */
  code: string;
  /** Implementation or peer id -> image by digest. */
  images: Record<string, string>;
  revision: { key: string; proposal: string; lexicons: string };
  slow: boolean;
}

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' ? [] : files(join(path, e.name))));
}

/** The code inputs of one scenario, relative to the repository root, sorted. */
export function codeInputs(ids: string[], lexiconsCommit: string, root = ROOT): string[] {
  const roots = [
    'harness',
    'suites',
    'spec/assertions.yaml',
    'spec/revisions.json',
    `spec/lexicons/${lexiconsCommit.slice(0, 8)}`,
    'fixtures',
    'implementations/base',
    'implementations/base.compose.yml',
    ...ids.map((id) => `implementations/${id}`),
    'package.json',
    'bun.lock',
    'vitest.suite.config.ts',
  ];
  return roots
    .flatMap((r) => files(join(root, r)))
    .map((p) => relative(root, p))
    .filter((p) => !/(^|\/)deviations\.yaml$/.test(p))
    .sort();
}

export function fingerprint(opts: { ids: string[]; images: Record<string, string>; revision: string; slow: boolean }, root = ROOT): Fingerprint {
  const rev = loadRevisions().revisions[opts.revision];
  if (!rev) throw new Error(`revision ${opts.revision} is not in spec/revisions.json`);
  const listing = codeInputs(opts.ids, rev.lexicons.commit, root)
    .map((p) => `${p}\0${sha(readFileSync(join(root, p)))}\n`)
    .join('');
  const images = Object.fromEntries(Object.entries(opts.images).sort(([a], [b]) => (a < b ? -1 : 1)));
  const body = {
    code: `sha256:${sha(listing)}`,
    images,
    revision: { key: opts.revision, proposal: rev.commit, lexicons: rev.lexicons.commit },
    slow: opts.slow,
  };
  return { digest: `sha256:${sha(JSON.stringify(body))}`, ...body };
}

/**
 * One implementation's scenario as `cli/run.ts` runs it: the implementation,
 * its partner, PLC, at the pinned images unless `image` replaces the
 * implementation's, at `revision` (default: the manifest's first).
 */
export function scenarioFingerprint(impl: string, opts: { image?: string; revision?: string; slow: boolean }, root = ROOT): Fingerprint {
  const manifest = loadManifest(join(root, 'implementations', impl, 'manifest.yaml'));
  const pins = new Map(
    readFileSync(join(root, 'pins', 'images.env'), 'utf8')
      .split('\n')
      .map((l) => /^([A-Z][A-Z0-9_]*)=(\S+)/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1], m[2]] as const),
  );
  const imageOf = (id: string) => pins.get(loadManifest(join(root, 'implementations', id, 'manifest.yaml')).image.pin)!;
  const partner = manifest.accounts.partner;
  const images: Record<string, string> = {
    [impl]: opts.image ?? imageOf(impl),
    ...(partner ? { [partner]: imageOf(partner) } : {}),
    plc: pins.get('PLC_IMAGE')!,
  };
  return fingerprint({ ids: [impl, ...(partner ? [partner] : [])], images, revision: opts.revision ?? manifest.spec_revisions[0], slow: opts.slow }, root);
}
