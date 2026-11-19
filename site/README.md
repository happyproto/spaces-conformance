# The results site

Static Astro, built from the `results` branch (design ch. 8). It follows the HappyProto design system (`@happyview/design-system`): the system sans and the mono, its tokens, and its frame, window, callout and table components.

```sh
bun install                                   # in the repository root and in site/
SEED=fixtures bun run build                   # from the committed pass-index runs
RESULTS_STORE=../path/to/results bun run build  # from a checkout of the results branch
./node_modules/.bin/astro preview
```

How a build works:
- `scripts/data.ts` checks the store with `cli/store.ts check` rules. If anything fails, it exits 1 and writes nothing, so nothing deploys.
- It then judges every run with `harness/judge.ts`, the same code `conformance verdict` uses, and writes `src/data/site.json`. The pages render only from that file.
- `scripts/count.ts` fails the build at 900 files. wisp.place allows 1000 per site.

| Page | Shows |
|---|---|
| `/` | The grid: each implementation's newest run per revision, by suite, with a legend. Then the pairing grid, empty until the harness runs pairings. |
| `/impl/<id>/` | What its manifest rules out, the score per role, the run (image digest, source revision, CI link), deviations by cause with each entry's age, every row by suite, and 90 days of history. |
| `/assertion/<id>/` | The quoted sentence per revision, with a link to the pinned anchor, its level and basis, and each implementation's result or why it doesn't apply. |
| `/spec/` | Every section of each pinned revision, and the assertions that cite it. |
| `/about/` | How it runs, who runs it, scoring, profiles, adding an implementation, disputing a result. |

`.github/workflows/site.yml` builds it on every PR and push, and deploys it once `vars.WISP_SITE` is set.
