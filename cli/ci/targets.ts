// CI helper: which implementations exist, and which one a dispatch names.
//
//   node cli/ci/targets.ts matrix              JSON list of implementation ids, for a job matrix
//   node cli/ci/targets.ts resolve <target>    the id whose image.dispatch_target is <target>, or nothing
//   node cli/ci/targets.ts pin <impl>          the image <impl> pins now
//
// A pds-test dispatch names its target (e.g. pds-spaces-alpha); the manifest
// that claims it decides which implementation runs. A target no manifest
// claims (an image the suite doesn't test) prints nothing and exits 0.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pinnedImages } from '../../harness/independence.ts';
import { loadManifest } from '../../harness/manifest.ts';
import { ROOT } from '../../harness/schema.ts';

const dir = join(ROOT, 'implementations');
const manifests = readdirSync(dir)
  .filter((d) => existsSync(join(dir, d, 'manifest.yaml')))
  .sort()
  .map((d) => loadManifest(join(dir, d, 'manifest.yaml')));
const [command, arg] = process.argv.slice(2);

if (command === 'matrix') console.log(JSON.stringify(manifests.map((m) => m.id)));
else if (command === 'resolve' && arg) {
  const hit = manifests.filter((m) => (m.image as { dispatch_target?: string }).dispatch_target === arg);
  if (hit.length > 1) {
    console.error(`${hit.map((m) => m.id).join(', ')} all claim dispatch target ${arg}`);
    process.exit(1);
  }
  if (hit.length) console.log(hit[0].id);
} else if (command === 'pin' && arg) {
  const image = pinnedImages().get(arg);
  if (!image) {
    console.error(`${arg} has no pin`);
    process.exit(1);
  }
  console.log(image);
} else {
  console.error('usage: node cli/ci/targets.ts matrix | resolve <target> | pin <impl>');
  process.exit(2);
}
