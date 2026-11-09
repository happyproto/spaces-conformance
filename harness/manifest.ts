// Implementation manifests (implementations/<id>/manifest.yaml).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import type { Assertion, Profile, Role } from './catalogue.ts';
import { profilesOf } from './catalogue.ts';
import type { Problem } from './problems.ts';
import { checkSchema } from './schema.ts';

export interface Manifest {
  id: string;
  name: string;
  roles: Role[];
  profile: Profile;
  spec_revision: string;
  capabilities: Record<string, unknown>;
  lineage?: Record<string, string>;
  compose: string;
  setup?: string;
  bootstrap?: string;
  image: { repository: string; pin: string };
  accounts: { mode: string; partner?: string; write_auth: string };
  deviations?: string | { repo: string; path: string };
  [key: string]: unknown;
}

export function loadManifest(path: string): Manifest {
  return parse(readFileSync(path, 'utf8'));
}

/**
 * Whether `caps` claims the dotted `path`. Objects are walked by key; at an
 * array the next segment must be one of its members; the end must be truthy.
 * `policies.managedspace` against `{policies: [memberspace, managedspace]}`
 * is true, and `repo_host.foreign_authorities` against `{repo_host:
 * {foreign_authorities: false}}` is false.
 */
export function claims(caps: unknown, path: string): boolean {
  let cur: unknown = caps;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (Array.isArray(cur)) return i === parts.length - 1 && cur.includes(seg);
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) return false;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return Array.isArray(cur) ? cur.length > 0 : Boolean(cur);
}

/** Why an assertion doesn't apply to an implementation, or null if it does. */
export function notApplicable(a: Assertion, m: Manifest): string | null {
  if (!a.roles.some((r) => m.roles.includes(r))) return `role ${a.roles.join('/')} not claimed`;
  if (!profilesOf(a).includes(m.profile)) return `profile ${m.profile} excluded`;
  const missing = (a.requires ?? []).filter((p) => !claims(m.capabilities, p));
  if (missing.length) return `capability ${missing.join(', ')} not claimed`;
  return null;
}

export function validateManifest(data: unknown, file: string, opts: { revisions: string[]; pins: Set<string>; ids: Set<string> }): Problem[] {
  const problems = checkSchema('manifest', data, file);
  if (problems.length) return problems;
  const m = data as Manifest;
  const at = (message: string) => problems.push({ file, where: m.id, message });
  const dir = dirname(file);
  if (!file.endsWith(join(m.id, 'manifest.yaml'))) at(`id ${m.id} doesn't match its folder`);
  if (!opts.revisions.includes(m.spec_revision)) at(`spec_revision ${m.spec_revision} is not in spec/revisions.json`);
  if (!opts.pins.has(m.image.pin)) at(`image.pin ${m.image.pin} has no line in pins/images.env`);
  if (!existsSync(join(dir, m.compose))) at(`compose file ${m.compose} doesn't exist`);
  if (m.accounts.partner && !opts.ids.has(m.accounts.partner)) at(`accounts.partner ${m.accounts.partner} is not an implementation`);
  if (m.profile === 'bespoke-space-host' && m.roles.includes('pds')) at('a bespoke-space-host does not claim the pds role');
  if (typeof m.deviations === 'string' && !existsSync(join(dir, m.deviations))) at(`deviations file ${m.deviations} doesn't exist`);
  return problems;
}

/** Variable names in pins/images.env. */
export function loadPins(path: string): Set<string> {
  const names = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=\S+/.exec(line.trim());
    if (m) names.add(m[1]);
  }
  return names;
}
