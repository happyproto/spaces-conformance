# Automation: results, pins and deviations

How runs become published results (design ch. 6.2, 7.2). The workflows that call these commands are described under [Workflows](#workflows).

## The results store

Results are kept on `results`, an orphan branch of this repository. It holds two folders:

| Path | What |
|---|---|
| `runs/<impl>/<yyyy>/<mm>/<run-id>.json` | One results file per run (`schemas/results.schema.json`). A file is never rewritten. A wrong result is corrected by a new run. |
| `index/latest.json` | For each implementation and spec revision: its newest run that isn't a candidate, and a newer candidate run if there is one. |
| `index/<impl>.json` | Every run of one implementation, newest first, with raw status counts. |

The index files are derived from `runs/` and contain no wall-clock time, so they can be checked. `schemas/index.schema.json` describes them.

```sh
node cli/store.ts init    --store <dir>                    # an empty store
node cli/store.ts add     --store <dir> <results.json>...  # validate, file, rebuild the index
node cli/store.ts check   --store <dir>                    # what the site build runs first
node cli/store.ts rebuild --store <dir>
```

The rules:
- `add` validates each file against the results schema and the catalogue at this suite commit. If any file fails, nothing is written.
- Adding a run that is already stored with the same bytes does nothing. Adding one with different bytes is refused.
- `check` validates every stored run against the schema only. A row retired from the catalogue later doesn't break the history it was graded in.
- `check` fails when a run sits at the wrong path, or when the index doesn't equal what `runs/` rebuilds to.

## Scenario fingerprints

The nightly run grades only scenarios whose inputs changed. A scenario is one implementation graded at one revision, with `--slow`. `harness/fingerprint.ts` hashes everything that can change its raw results:

| Part | What |
|---|---|
| `images` | Every image in the stack, by digest: the implementation's (a candidate's replaces the pin's), its partner's, PLC's. |
| `revision` | The revision key, and its proposal and lexicon commits. |
| `slow` | Whether the slow checks ran. |
| `code` | The files a result can depend on: `harness/`, `suites/`, `spec/assertions.yaml`, `spec/revisions.json`, that revision's lexicons, `fixtures/`, the base stack, the implementation's folder and its partner's, `package.json`, `bun.lock` and `vitest.suite.config.ts`. |

Left out, because they change how a result is shown and never the result: deviation lists, `vectors/` (provisional status), `evidence/`, docs, the site and CI files.

`cli/run.ts` records the fingerprint as `run.fingerprint` in the results file, except for a run narrowed with `--suites`, which isn't the whole scenario. The store copies its digest into each index entry. A stored run with the same digest and no `error` result means the scenario is already graded.

## What a run decides

```sh
node cli/report.ts <results.json> [--deviations file] --decision
```

It judges the file as `verdict` does (`harness/judge.ts`) and prints:

| `decision` | When | What CI does |
|---|---|---|
| `pin` | No unexpected result and no error | Opens a pin PR |
| `issue` | An unexpected result, and no error | Opens the implementation's candidate issue, or updates it |
| `none` | Any `error`, or an infrastructure failure on an earlier attempt | Nothing: an error is no result (design ch. 4.4 rule 7) |

It also prints `unexpected`, `errors` and `warnings` counts. `--body pin|issue|summary` prints the Markdown for the pin PR, the issue and the step summary. That text holds only what the results file holds.

## Moving a pin

```sh
node cli/pin.ts <impl> <image@sha256:...> --results <candidate-results.json>
```

This makes one self-consistent change for the pin PR:
- `pins/images.env`: the implementation's line moves to the new digest;
- `test/fixtures/results/<impl>-<date>.json`: the candidate run, which becomes the implementation's pass-index source;
- `evidence/passes.json`: the old source moves to `excluded`, with a reason, and the index is rebuilt.

The pass index takes only runs of the pinned image, so all three have to move together. `pin` refuses:
- an image outside the manifest's `image.repository`;
- a results file of another image or implementation;
- a run without `--slow`;
- a run at a different revision from the source it replaces.

## Pruning fixed deviations

```sh
node cli/prune.ts <results.json>... [--write]
```

It finds entries that a run shows as "fixed, still listed" and, with `--write`, removes them from the implementation's `deviations.yaml`:
- An entry goes once every revision it covers has a run showing it fixed. Otherwise its `revisions` narrows to the rest.
- The file is edited as text, so comments and wrapping stay as they were.
- Only lists in this repository are pruned. HappyView's list lives in its own repository, and its own CI fails on a fixed entry.

## Workflows

Added with the workflows.
