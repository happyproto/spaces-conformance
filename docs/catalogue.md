# Catalogue, manifest, deviation and result formats

Every file below has a JSON Schema in `schemas/`, and `bun run validate` checks the cross-references the schemas can't express. This page covers those rules. The design (HAP-408, ch. 3 and 4) explains why each one exists.

## Assertions (`spec/assertions.yaml`)

Each row ties one check to one sentence of Proposal 0016 at a revision `spec/revisions.json` pins, or to the lexicons pinned with it. The validator fetches each revision's proposal by commit, checks its SHA-256, and caches it in `.cache/spec/`. The lexicons are vendored in `spec/lexicons/<commit>/` and checked against a digest in `revisions.json`.

| Field | Rule |
|---|---|
| `id` | Dotted and stable, never reused. `info.*` ids are level `info`. |
| `suite` | One of the 14 suites (design ch. 3.2). |
| `section` | A heading anchor in the pinned text, e.g. `#incremental-sync`. Only lexicon rows and `info` rows may omit it. |
| `quote` | Must appear verbatim in the pinned text, inside the section it cites (subsections included). "Verbatim" means after Markdown normalisation: both sides have links reduced to their text, code-span backticks and emphasis markers outside code spans removed, table pipes turned into spaces and whitespace collapsed. Every other character must match. |
| `level` | `must`, `should` or `info`, and must pass the level rule below. |
| `basis` | One or more of `keyword`, `definition`, `lexicon`, `host-honours-may` and `default`. Required for `must` and `should`. |
| `roles`, `profiles` | Which implementations the row applies to. `profiles` defaults to both. |
| `requires` | Capability paths resolved against a manifest's `capabilities` (see below). |
| `lexicon` | One NSID or a list, required when `basis` has `lexicon`. Each must exist in the revision's pinned lexicons (`spec/lexicons/<commit>/`). |
| `params` | Parameter or input-field names the row relies on. Every listed lexicon must define each one. |
| `error` | For `xrpc.error.<Name>` rows, the error name. It must equal `<Name>` and be declared by the listed lexicon. |
| `since`, `until` | Revision keys from `spec/revisions.json`: the first and last revision the row applies to, both inclusive. `since` defaults to the catalogue's base `revision`. |
| `variants` | Per revision key, the fields that read differently from that revision on: `section`, `quote`, `level`, `basis`, `lexicon`, `params`, `error`, `checks`, `areas`, `no_crypto`. See "Revisions" below. |
| `provisional` | Marks a row provisional by hand, whatever the evidence. The lineage rule below applies to every row regardless. |
| `areas` | Required on every row. It lists the harness crypto areas the check runs through (`cbor`, `lthash`, `mac`, `httpsig`, `jwt`, `star`), or is `[]` to acknowledge it uses none, so no row can be left unfenced by omission. It can't be empty in the `digest`, `mac` and `export` suites, unless the row's `no_crypto` says why it uses none. While any listed area has a pending vector cross-check (`vectors/README.md`), the assertion is provisional. After that, it stays provisional until the lineage rule below clears it. |

**Level rule.**

| Level | Allowed when |
|---|---|
| `must` | The quote has MUST, MUST NOT, REQUIRED, SHALL or a lowercase "must" and `basis` has `keyword`; or `basis` has `definition`, `lexicon` or `host-honours-may`. |
| `should` | The quote has SHOULD, RECOMMENDED or "should" and `basis` has `keyword`; or `basis` has `default` and the quote states a default. |
| `info` | Anything. Never scored. |

Each basis must also hold on its own:
- `keyword` needs a keyword of the row's level in the quote;
- `default` needs the word "default" and is valid only on `should`;
- `definition`, `lexicon` and `host-honours-may` make a row `must`.

## Revisions

`spec/revisions.json` pins each revision the suite grades: the proposal text by commit and SHA-256, and the lexicons by commit and digest.

| Key | Proposal 0016 | Lexicons | Names |
|---|---|---|---|
| `2026-10-29` | `701ef9c6be` | atproto `98ef3a6b` | The Oct 29 names (`getSpaceCredential`, `putMember`, `notifyWrite`, `Atproto-Space-Want-Mac`) |
| `2026-11-12` | `2755e73a31` ("Release 11/12", #143) | atproto `d4def6e9` | The settled names (`authorizeSpaceSync`, `putMembers`, `notifyRepoUpdate`, RFC 9421 MACs) |

How rows span revisions:
- **One id across revisions.** A row keeps its id while it checks the same thing. Its own fields read as of its first revision: `since`, or the catalogue's base `revision`.
- **`variants` hold what a later revision reworded or renamed.** A variant applies from its revision on, over the row and any earlier variant. Its key must come after the row's first revision, and no later than `until`.
- **`until` ends a row.** Use it when a later revision drops what the row checks. A row whose G2 reading isn't written yet also carries `until` until its variant lands, so it's never graded against text it doesn't quote.
- **An `until` can't drop a row by accident.** If the row, as it reads at its `until`, still passes the quote, section and lexicon checks at every later pinned revision, the validator refuses the `until` unless the row has an `ended:` reason. `ended` is refused on a row whose citation changed.
- **The validator checks every row at every revision it applies to.** Each row is resolved there, and its quote, section, lexicon, params and error are checked against that revision's text and lexicons. So a reworded quote fails at the new revision until a variant or `until` handles it.

**A run grades one revision.** `cli/run.ts --revision <key>` picks it. The default is the first of the manifest's `spec_revisions`. A row that doesn't apply there is recorded as `skip` ("not in revision ..."). The results file's `spec.revision` names the revision, and `verdict` judges each row as it reads there.

## Manifests (`implementations/<id>/manifest.yaml`)

The schema follows design ch. 4.1, except that `spec_revisions` lists every revision the implementation claims, with the default first. The validator also checks these:
- `id` matches the folder;
- `image.pin` has a line in `pins/images.env`;
- the `compose` fragment exists;
- `accounts.partner` names another implementation;
- a `bespoke-space-host` doesn't claim the `pds` role;
- a local `deviations` file exists.

**Lineage.** `lineage` names, per crypto area (`cbor`, `lthash`, `mac`, `httpsig`, `jwt`, `star`), the library or codebase that implements it in the pinned image. Each value needs a comment citing the file at the image's revision that shows it. Leave out an area the image doesn't implement, or that can't be verified: a missing lineage is unknown.

**Capability paths.** `requires: [policies.managedspace]` holds when `capabilities.policies` is an array containing `managedspace`. `requires: [repo_host.foreign_authorities]` holds when that value is truthy. An assertion doesn't apply when the implementation lacks one of its roles, its profile is excluded, or a required capability isn't claimed. It then shows as *not applicable*.

## Deviations

A deviation file is a list of entries, each with `assertion`, `cause`, `reason`, `spec`, `tracking`, `since` and `expect`. The validator rejects:
- an assertion id that isn't in the catalogue at this commit, so retired ids get pruned;
- an assertion listed twice for the same revision;
- a `spec` value that isn't a heading anchor at each revision the entry covers;
- a `revisions` entry naming a revision the assertion doesn't apply at;
- a `since` date in the future;
- an entry without `expect`;
- a pattern that doesn't compile on its own (so an unbalanced paren can't escape the anchors);
- a pattern that matches the empty string or the sentinel `zz-sentinel-not-a-failure`, such as `.*` or `.+`, because it would cover any failure.

`run` and `verdict` apply the same checks to a list before they use it.

`tracking` must name a real issue: `HAP-123`, `HAP-388 (PR 6)`, `owner/repo#12` or an https URL. `pending` is refused.

**`revisions`** is optional. Without it, an entry covers every revision its assertion applies at. With it, it covers only those. An assertion may be listed once per revision, so one generation's failure and another's can each have their own `expect`. A run applies only the entries for the revision it grades.

**`expect`** states the failure the entry covers, so a known deviation can't hide a new failure on the same assertion:

```yaml
expect:
  message: following cursor with limit=2 returned p0 2 times, not once
  evidence:
    pages: \[2,2\]
```

- `message` is a JavaScript regular expression. It must match the whole result message: the harness anchors it at both ends.
- `evidence` is optional. Each key names an evidence field, and its pattern must match that field's whole value. A string is matched as it is, anything else as its JSON. A key missing from the evidence is a mismatch.
- A listed `fail` that matches is a *known deviation*. One that doesn't is *deviation changed*: it fails the gate, or only warns while the assertion is provisional. `verdict` prints how it differs.
- An `error` stays an `error`, whatever the entry expects.
- Write the patterns from a real run's result, and keep them as tight as the failure is stable. A count or a fixture name belongs in the pattern. A DID, a CID or a timestamp doesn't.

Result files written before `expect` existed embed entries without it. `verdict` judges those as it did then.

To check a list that lives in another repo, such as HappyView's:

```sh
node cli/validate.ts --deviations ../happyview/interop/conformance-deviations.yaml
```

`verdict --deviations <file>` refuses a list that fails the schema.

## Independence: the lineage rule

A row with harness crypto (`areas` not empty) is provisional until all of these hold:
- every area it lists has its vectors cross-checked;
- it has passed on two implementations;
- those two declare a lineage for every area the row lists;
- for each such area, their two lineages differ.

Equal lineage strings count as one, so two hosts built on the same `@atproto/*` package don't clear a row, and an unknown lineage never does. The harness's own vectors don't count as a pass. A row with `areas: []` uses no harness crypto, so this rule doesn't apply to it. A provisional fail shows as "fail (provisional)", isn't scored, and only warns in gated CI. A provisional pass isn't scored either.

The passes come from `evidence/passes.json`. Per revision, it maps each assertion to the implementations it passed on, and it lists the results files it was built from. A pass at one revision says nothing about another, so each revision's rows clear on that revision's passes only.
- Rebuild it with `node cli/passes.ts <results.json>...`. With no arguments, it rebuilds from the index's current sources.
- Every source must be a committed results file of a real run, and must validate. Today the sources are `test/fixtures/results/parity-*`.
- Every source must have run the image its implementation's manifest pins now. The lineage rule reads lineage from the current manifest, so an older image's passes would be credited with the new image's lineage. After a pin bump, rerun the source or exclude it with a reason.
- `bun run validate` rebuilds the index from its sources and refuses any difference, so a pass can't be added by hand.
- Every file in `test/fixtures/results/` must be either a source or listed under `excluded`, with a reason. `cli/passes.ts` keeps the exclusions.
- **Per-assertion digests (HAP-432).** A run records, for each row that applies at its revision, a digest of the row as it reads there, the suite file that declares its test, the revision's text and lexicon commits, and the vector files of each area the row lists (`suite.assertion_digests`, `harness/digests.ts`).
  - A pass counts only while that digest equals the current one. When a row, its test file, its pins or its vectors change, the index refuses its old passes, and lists them under the source's `stale_passes`. Rerun to count them again.
  - Shared helpers (`suites/repo.ts`, `suites/fixtures.ts`, `harness/`) aren't in the digest. Rerun by hand after changing what one of them checks.
- **Sources from before per-assertion digests** record only the whole-catalogue `assertions_digest`. When it differs from the current catalogue, `bun run validate` names the source. It still counts, because most catalogue edits don't change what a row checks. Rerun the source after changing a row's check.

`harness/independence.ts` implements the rule, and both the reporter and `verdict` apply it.

## Results

One JSON file per run (design ch. 7.1). Statuses are raw: `pass`, `fail`, `error` or `skip`. Display states such as *known deviation* are derived from those statuses plus the embedded `deviations_applied`, and are never stored. Beyond the schema, the validator checks these:
- each assertion has at most one result;
- each id exists in the catalogue;
- `evidence` appears only on `fail` or `error`, and is at most 4 KiB;
- every applied deviation has a result. `deviations_applied` holds the list's entries for the assertions that ran, not the whole list, so a run of a few suites carries only the entries it used;
- no role has more passes than applicable assertions.

A rerun after an `error` (`cli/run.ts`) keeps the earlier attempt in `run.previous_attempts`, with its failed and errored ids. A result that passed only on the rerun carries `flaky`. `verdict` shows it as "pass (flaky)": it's scored as a pass but warns. When the stack or bootstrap failed first, `run.infrastructure` says where.
