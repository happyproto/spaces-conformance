// `node cli/report.ts <results.json> [--deviations file] (--decision | --body pin|issue|summary)`:
// what the candidate workflow does with a run, and the text it posts
// (design ch. 6.2, 4.4 rule 7).
//
// --decision prints key=value lines for $GITHUB_OUTPUT:
//   decision=pin    no unexpected result and no error: open a pin PR
//   decision=issue  an unexpected result that isn't an error: open or update the issue
//   decision=none   an error (or an infrastructure note on the run): no result,
//                   so the pin doesn't move and no issue is opened
//   unexpected=<n> errors=<n> warnings=<n>
//
// --body prints Markdown for the pin PR, the issue, or a step summary. It
// carries only what the results file holds (the harness's own messages),
// and links the run's CI page when the file has one.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { type Deviation, loadCheckedDeviations } from '../harness/deviations.ts';
import { judgeFile, type ResultsFile } from '../harness/judge.ts';
import { formatProblem } from '../harness/problems.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { deviations: { type: 'string' }, decision: { type: 'boolean', default: false }, body: { type: 'string' }, 'old-image': { type: 'string' } },
});
if (!positionals[0] || (!values.decision && !['pin', 'issue', 'summary'].includes(values.body ?? ''))) {
  console.error('usage: node cli/report.ts <results.json> [--deviations file] (--decision | --body pin|issue|summary [--old-image image])');
  process.exit(2);
}
const file: ResultsFile = JSON.parse(readFileSync(positionals[0], 'utf8'));
let deviations: Deviation[] = file.deviations_applied;
if (values.deviations) {
  const checked = await loadCheckedDeviations(values.deviations);
  if (checked.problems.length) {
    console.error(checked.problems.map(formatProblem).join('\n'));
    process.exit(2);
  }
  deviations = checked.deviations;
}
const { judged, summary } = judgeFile(file, deviations);
const errors = judged.filter((j) => j.raw === 'error').length;
const unexpected = judged.filter((j) => j.gate === 'fail' && j.raw !== 'error').length;
const warnings = judged.filter((j) => j.gate === 'warn').length;

if (values.decision) {
  const decision = errors || file.run.infrastructure ? 'none' : unexpected ? 'issue' : 'pin';
  console.log(`decision=${decision}\nunexpected=${unexpected}\nerrors=${errors}\nwarnings=${warnings}`);
  process.exit(0);
}

const cell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').slice(0, 200);
const digest = (image: string) => image.split('@')[1] ?? image;
const run = file.run.ci_url ? `[${file.run.id}](${file.run.ci_url})` : `\`${file.run.id}\``;
const messages = new Map(file.results.map((r) => [r.id, r.message ?? r.skip_reason ?? '']));
const lines: string[] = [];
const head = [
  `- Implementation: \`${file.implementation.id}\``,
  `- Image: \`${file.implementation.image}\``,
  ...(file.implementation.source_revision ? [`- Source revision: \`${file.implementation.source_revision}\``] : []),
  `- Spec revision: ${file.spec.revision} (proposal ${file.spec.proposal} at \`${file.spec.commit.slice(0, 10)}\`)`,
  `- Suite commit: \`${file.suite.commit}\``,
  `- Run: ${run}`,
];
const roles = Object.entries(summary.by_role).map(([role, s]) => `| ${role} | ${s!.must_pass}/${s!.must_applicable} | ${s!.should_pass}/${s!.should_applicable} |`);
const scoreTable = ['| Role | must | should |', '|---|---|---|', ...roles];

if (values.body === 'pin') {
  lines.push(`Moves \`${file.implementation.id}\` to a candidate image that ran with no unexpected result.`, '');
  if (values['old-image']) lines.push(`- From: \`${digest(values['old-image'])}\``, `- To: \`${digest(file.implementation.image)}\``, '');
  lines.push(...head, '', ...scoreTable, '');
  lines.push(
    'This PR also makes the candidate run the pass-index source for this implementation, and excludes the old one (`cli/pin.ts`).',
    'Check the comment above the pin line in `pins/images.env` still describes the image.',
  );
  if (warnings) lines.push('', `${warnings} result(s) only warn (provisional, or a flaky pass). \`node cli/verdict.ts\` on the results file lists them.`);
} else if (values.body === 'issue') {
  lines.push(`The newest candidate image of \`${file.implementation.id}\` has results its deviation list doesn't expect, so its pin stays where it is.`, '');
  lines.push(...head, '', '| Assertion | Shown as | Message |', '|---|---|---|');
  for (const j of judged.filter((x) => x.gate === 'fail' && x.raw !== 'error'))
    lines.push(`| \`${j.id}\` | ${j.display} | ${cell(j.changed ? `${messages.get(j.id)} (expected otherwise: ${j.changed})` : (messages.get(j.id) ?? ''))} |`);
  lines.push('', 'Each candidate run updates this issue. Close it when a candidate passes, or when the results are listed as deviations with a tracking issue.');
} else {
  lines.push(`### ${file.implementation.id} at ${file.spec.revision}`, '', ...head, '', ...scoreTable, '', `${unexpected} unexpected, ${errors} error(s), ${warnings} warning(s)`);
}
console.log(lines.join('\n'));
