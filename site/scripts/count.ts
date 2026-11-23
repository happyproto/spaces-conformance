// The wisp.place cap (design ch. 8.1, 9.2): a site may hold at most 1000
// files. The build fails well before that, at 900, so a growing catalogue
// is noticed while there's room to change course.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 1000;
const MARGIN = 900;
const dist = join(import.meta.dirname, '..', 'dist');
const count = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(dir, e.name)) : 1), 0);
const n = count(dist);
if (n > MARGIN) {
  console.error(`site: dist/ has ${n} files; wisp.place allows ${LIMIT}, and this build stops at ${MARGIN}`);
  process.exit(1);
}
console.log(`site: dist/ has ${n} files (wisp.place allows ${LIMIT})`);
