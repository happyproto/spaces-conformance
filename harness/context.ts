// The run context inside the harness container: which implementation is under
// test, its manifest and adapter, the catalogue and the PLC directory.

import { join } from 'node:path';
import { Plc } from './actors/plc.ts';
import type { Adapter, StackCtx } from './adapter.ts';
import { type Assertion, type Catalogue, loadCatalogue } from './catalogue.ts';
import { loadManifest, type Manifest } from './manifest.ts';
import { ROOT } from './schema.ts';

export interface RunContext extends StackCtx {
  catalogue: Catalogue;
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
    return {
      manifest,
      baseUrl: String(manifest.base_url).replace(/\/$/, ''),
      plc: new Plc(process.env.PLC_URL ?? 'http://plc:2582'),
      catalogue,
      byId: new Map(catalogue.assertions.map((a) => [a.id, a])),
      adapter,
    };
  })();
  return cached;
}
