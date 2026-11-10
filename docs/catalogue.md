# Catalogue, manifest, deviation and result formats

Every file below has a JSON Schema in `schemas/`, and `bun run validate` checks the cross-references the schemas can't express. This page covers those rules. The design (HAP-408, ch. 3 and 4) explains why each one exists.

## Assertions (`spec/assertions.yaml`)

Each row ties one check to one sentence of Proposal 0016 at the revision `spec/revisions.json` pins, or to the lexicons pinned with it. The validator fetches the proposal by commit, checks its SHA-256, and caches it in `.cache/spec/`. The lexicons are vendored in `spec/lexicons/<commit>/` and checked against a digest in `revisions.json`.

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
| `since`, `until` | Revision keys from `spec/revisions.json`. |
| `provisional` | Set until two implementations with different lineage pass it. |
| `areas` | Required on every row. It lists the harness crypto areas the check runs through (`cbor`, `lthash`, `mac`, `httpsig`, `jwt`, `star`), or is `[]` to acknowledge it uses none, so no row can be left unfenced by omission. It can't be empty in the `digest`, `mac` and `export` suites. While any listed area has a pending vector cross-check (`vectors/README.md`), the assertion is provisional. |

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

## Manifests (`implementations/<id>/manifest.yaml`)

The schema follows design ch. 4.1. The validator also checks these:
- `id` matches the folder;
- `image.pin` has a line in `pins/images.env`;
- the `compose` fragment exists;
- `accounts.partner` names another implementation;
- a `bespoke-space-host` doesn't claim the `pds` role;
- a local `deviations` file exists.

**Capability paths.** `requires: [policies.managedspace]` holds when `capabilities.policies` is an array containing `managedspace`. `requires: [repo_host.foreign_authorities]` holds when that value is truthy. An assertion doesn't apply when the implementation lacks one of its roles, its profile is excluded, or a required capability isn't claimed. It then shows as *not applicable*.

## Deviations

A deviation file is a list of entries, each with `assertion`, `cause`, `reason`, `spec`, `tracking` and `since`. The validator rejects:
- an assertion id that isn't in the catalogue at this commit, so retired ids get pruned;
- an assertion listed twice;
- a `spec` value that isn't a heading anchor;
- a `since` date in the future.

`tracking` must name a real issue: `HAP-123`, `HAP-388 (PR 6)`, `owner/repo#12` or an https URL. `pending` is refused.

To check a list that lives in another repo, such as HappyView's:

```sh
node cli/validate.ts --deviations ../happyview/interop/conformance-deviations.yaml
```

## Results

One JSON file per run (design ch. 7.1). Statuses are raw: `pass`, `fail`, `error` or `skip`. Display states such as *known deviation* are derived from those statuses plus the embedded `deviations_applied`, and are never stored. Beyond the schema, the validator checks these:
- each assertion has at most one result;
- each id exists in the catalogue;
- `evidence` appears only on `fail` or `error`, and is at most 4 KiB;
- every applied deviation has a result. `deviations_applied` holds the list's entries for the assertions that ran, not the whole list, so a run of a few suites carries only the entries it used;
- no role has more passes than applicable assertions.

A rerun after an `error` (`cli/run.ts`) keeps the earlier attempt in `run.previous_attempts`, with its failed and errored ids. A result that passed only on the rerun carries `flaky`. `verdict` shows it as "pass (flaky)": it's scored as a pass but warns. When the stack or bootstrap failed first, `run.infrastructure` says where.
