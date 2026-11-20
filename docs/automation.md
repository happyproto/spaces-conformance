# Automation: results, pins and deviations

How runs become published results (design ch. 6.2, 7.2). The workflows that call these commands are described under [Workflows](#workflows).

## The results store

Results are kept on `results`, an orphan branch of this repository. It holds two folders:

| Path | What |
|---|---|
| `runs/<impl>/<yyyy>/<mm>/<run-id>.json` | One results file per run (`schemas/results.schema.json`). A file is never rewritten. A wrong result is corrected by a new run. |
| `index/latest.json` | For each implementation and spec revision: its newest run that isn't a candidate, and a newer candidate run if there is one. It doesn't know the pins, which live on `main`: once a candidate's pin PR merges, that candidate run is the pin's result, but this file still lists it as a candidate. The site picks the run of the pinned image itself (`site/scripts/data.ts`). |
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
| `images` | Every image in the stack, by digest: the implementation's (a candidate's replaces the pin's), its partner's, and the helpers: PLC, Postgres, Caddy, the curl sidecar and the harness container's base. Every one is pinned in `pins/images.env`, so nothing moves under a tag between runs. |
| `revision` | The revision key, and its proposal and lexicon commits. |
| `slow` | Whether the slow checks ran. |
| `code` | The files a result can depend on: `harness/`, `suites/`, `spec/assertions.yaml`, `spec/revisions.json`, that revision's lexicons, `fixtures/`, the base stack, the implementation's folder and its partner's, `package.json`, `bun.lock` and `vitest.suite.config.ts`. |

Left out, because they change how a result is shown and never the result: deviation lists, `vectors/` (provisional status), `evidence/`, docs, the site and CI files.

`cli/run.ts` records the fingerprint as `run.fingerprint` in the results file, except for a run narrowed with `--suites`, which isn't the whole scenario. The store copies its digest into each index entry. A stored run with the same digest, no `error` result and no infrastructure failure on an earlier attempt means the scenario is already graded. A run that needed a retry after an infrastructure failure is no result (`cli/report.ts` decides `none`), so the nightly run grades it again.

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

| Workflow | Trigger | What it does |
|---|---|---|
| `run.yml` | `workflow_call` | One implementation on one image. It uploads the results file and the container logs as artifacts. It commits nothing, holds no secrets and runs on GitHub's ephemeral runner, so it is safe to call for an image built from a fork's pull request. |
| `candidate.yml` | `repository_dispatch` (`pds-test-image`, `happyview-image`), `workflow_dispatch` | Runs a new image as a candidate and publishes the result. Then it opens a pin PR, opens or updates the implementation's issue, or does neither on an error. |
| `nightly.yml` | daily at 04:17 UTC, `workflow_dispatch` (`force`, `implementations`) | Runs each implementation whose scenario fingerprint changed, at its pin with `--slow`, publishes, then opens a prune PR if any entry is fixed. `force` reruns everything given. |

The workflows share these rules:
- Only `publish` jobs write. Each runs under the `results-writer` concurrency group, so one job writes to the `results` branch at a time.
- A dispatch payload is untrusted text. It reaches a script only through `env`, and `cli/run.ts --image` accepts only `<the manifest's repository>@sha256:<digest>`.
- A target that no manifest's `image.dispatch_target` claims is skipped. So is an image an implementation already pins.
- Nothing is opened or posted on another project's repository.

### Re-runs by hand

Nothing reruns on a schedule. A scenario is graded again only when its fingerprint changes, or by hand:
- Anyone can ask with the "Request a re-run" issue template (`.github/ISSUE_TEMPLATE/rerun.yml`): the implementation, the run, and why.
- A maintainer then runs `nightly.yml` with `workflow_dispatch`, `force: true` and `implementations: <id>`.

Issue comments trigger nothing.

### The scripts they call

Each script is in `cli/ci/` and takes `PUBLISH_DRY_RUN=1`, which does the work locally and prints the push, PR or issue instead of making it.

| Script | Does |
|---|---|
| `plan.ts` | The nightly matrix: each implementation whose fingerprint has no stored run without an error. With no `results` branch yet, everything runs. Its summary says what's unchanged and since when. |
| `targets.ts` | The implementation list for a matrix, the implementation a dispatch target names, and an implementation's current pin. |
| `publish-results.sh` | Checks the `results` branch out into `.store/` (creating it as an orphan the first time), runs `store.ts add` and `check`, commits and pushes. It retries a push that lost a race. |
| `open-pin-pr.sh` | `pin/<impl>-<digest12>`: runs `cli/pin.ts`, runs `bun run validate`, then opens the PR. Does nothing while one from that branch is open. |
| `candidate-issue.sh` | One open issue per implementation, labelled `candidate:<impl>`. Each new candidate with unexpected results replaces its body. |
| `open-prune-pr.sh` | `prune/<date>`: runs `cli/prune.ts --write` and validates. Does nothing while a prune PR is open. |

### Settings and secrets

Without these, `run.yml`, the builds and publishing to the `results` branch still work. Pin PRs, prune PRs and dispatches need them:
- **"Allow GitHub Actions to create and approve pull requests"**, under the repository's Actions settings, so `GITHUB_TOKEN` can open pin and prune PRs.
- **`CONFORMANCE_BOT_TOKEN`** (optional secret): a token with contents, pull requests and issues write on this repository. GitHub doesn't start workflows for PRs opened with `GITHUB_TOKEN`, so without it a pin PR gets no CI until someone closes and reopens it.
- **pds-test**: this repository in `targets.json`'s `consumers`, and a `CONSUMER_DISPATCH_TOKEN` that can dispatch to it.
- **HappyView**: a `happyview-image` dispatch from its beta and main image jobs, with `client_payload.image` set to the image by digest.
