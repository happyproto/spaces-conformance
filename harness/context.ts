// The run context inside the harness container: which implementation is under
// test, its manifest and adapter, the catalogue and the PLC directory.

import { join } from 'node:path';
import { Plc } from './actors/plc.ts';
import type { Adapter, StackCtx } from './adapter.ts';
import { type Assertion, type Catalogue, loadCatalogue, resolveCatalogue } from './catalogue.ts';
import { loadManifest, type Manifest } from './manifest.ts';
import { ROOT } from './schema.ts';

export interface RunContext extends StackCtx {
  catalogue: Catalogue;
  /** The revision this run grades (CONFORMANCE_REVISION, else the manifest's first). */
  revision: string;
  /** Every row that applies at `revision`, as it reads there. */
  byId: Map<string, Assertion>;
  adapter: Adapter;
}

let cached: Promise<RunContext> | undefined;

export function runContext(): Promise<RunContext> {
  cached ??= (async () => {
    const id = process.env.CONFORMANCE_IMPL;
    if (!id) throw new Error('CONFORMANCE_IMPL is not set: run suites through cli/run.ts');
    const manifest: Manifest = loadManifest(join(ROOT, 'implementations', id, 'manifest.yaml'));
    if (!manifest.setup) throw new Error(`${id} has no setup adapter`);
    const mod = await import(join(ROOT, 'implementations', id, manifest.setup));
    const adapter: Adapter = mod.adapter;
    if (!adapter) throw new Error(`implementations/${id}/${manifest.setup} exports no adapter`);
    const catalogue = loadCatalogue(join(ROOT, 'spec', 'assertions.yaml'));
    const revision = process.env.CONFORMANCE_REVISION ?? manifest.spec_revisions[0];
    return {
      manifest,
      baseUrl: String(manifest.base_url).replace(/\/$/, ''),
      plc: new Plc(process.env.PLC_URL ?? 'http://plc:2582'),
      catalogue,
      revision,
      byId: new Map(resolveCatalogue(catalogue, revision).map((a) => [a.id, a])),
      adapter,
    };
  })();
  return cached;
}
