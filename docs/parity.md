# Parity with HappyView's interop tests

At the same image pins, every difference between the suite's results and HappyView's interop results has a named cause. Most come from the suite being deliberately stricter: it holds hosts to 0016's own commit format, KEM key and policy methods, and to the lexicon's `cursor`, with no workarounds. The rest are rows the harness can't judge yet. Two findings came out of the comparison:
- On every image, the old commit's `hash` equals the digest the harness computes over the records. So the set hash itself agrees across all four implementations and the harness.
- pds.js's typed-record CIDs and its `cursor` handling are real deviations, tracked upstream.

This page explains each difference, test by test. The per-test tables map each HappyView test to the assertions that replace it. Every suite status comes from these results files, validated by `bun run validate`:
- [zds](../test/fixtures/results/parity-zds-2026-11-12.json)
- [pds.js](../test/fixtures/results/parity-pdsjs-2026-11-12.json)
- [atproto-pds](../test/fixtures/results/parity-atproto-pds-2026-11-12.json)
- [reference](../test/fixtures/results/parity-reference-2026-11-12.json)

## What was compared

| | HappyView | This suite |
|---|---|---|
| Run | [interop.yml run 42557152439](https://github.com/gamesgamesgamesgamesgames/happyview/actions/runs/42557152439), a push to `beta` at `9f084f5c` | `node cli/run.ts <id>` for each implementation, at the commit that adds this page |
| Result | 42 interop tests and the migration end-to-end test, all passed | per row below |
| Setup | `simplespace.createSpace`, password sessions | the same: `setup_mode.spaces: simplespace`, `write_auth: password-session` |

Both used these images, the digests in `pins/images.env`:

| Implementation | Image |
|---|---|
| ZDS | `pds-test/zds@sha256:809bfa102527…` |
| pds.js | `pds-test/pdsjs@sha256:1725c1f8d2ce…` |
| atproto-pds | `pds-test/atproto-pds@sha256:19a0f54acd6d…` |
| reference (`pds-spaces-alpha`) | `pds-test/pds-spaces-alpha@sha256:1cf9349e9f0e…` |
| PLC | `pds-test/plc@sha256:be4b9b844e46…` |

HappyView's `beta` moved its ZDS pin on Nov 9, 2026, so later HappyView runs aren't comparable for ZDS. Every image here predates 0016's Oct 29 commit and policy shapes. Moving the pins is tracked in HAP-427, and is a separate change, so this comparison stays like for like.

## Why the suite fails where HappyView passes

Every difference has one of these causes. The per-test tables below name the cause by its letter.

**A. 0016's commit format.** HappyView's `verify_remote_commit` accepts the older signed commit (`hash`, `ikm`, `mac`, `sig`) as well as the 0016 commit (`ver`, `repo`, `space`, `rev`, `data`). It checks the old one's signature against the author's `#atproto` key. The suite accepts only the 0016 commit, because that's what 0016 defines (`#space-repos`). All four images serve the old commit, so every row that reads a commit fails:
- `records.commit-fields`, `records.commit-bytes-encoding`, `records.commit-repo-space-match`;
- `digest.matches-record-set`, `digest.covers-overwrite-and-delete`, `digest.multi-batch`, `oplog.fold-matches-commit`.

The digest itself agrees. In each digest fail, the evidence compares the old commit's `hash` with the digest the harness expects, and on all four images they're equal.

**B. The KEM key.** 0016 has every account with space repos publish a P-256 `#atproto_kem` key (`#kem-key`). HappyView's tests ask for a MAC only when the author's document has one. Otherwise they verify the old commit's signature. Only pds.js publishes the key. ZDS and the reference publish only `#atproto`, and atproto-pds publishes `#atproto` and `#atproto_space`. So `mac.kem-key-published` fails on three images, and that's the one row that grades the missing key. Without the key the harness can't request a MAC, so on those three `mac.commit-header-present` and `mac.commit-valid` record `skip` ("pending: no #atproto_kem key to request a MAC with"). They're judged on their own once the key exists.

**C. MAC rows the harness can't judge yet.** 0016 requires a MAC only "when called with a space credential" (`#authenticity-headers`). The harness reads with a password session, as HappyView's tests do, and has no credential path yet:
- When a session read gets no `Atproto-Space-Mac`, `mac.commit-header-present` and `mac.commit-valid` record `skip` with a "pending" reason, not a fail. That's what pds.js does.
- `mac.commit-bound-to-repo` needs a reader who isn't the author. It requires the `harness.credential_reads` capability, so it's not applicable everywhere for now.

Part of HappyView's `a_commit_from_another_repo_does_not_verify_as_ours` checks a 0016 MAC against another account's KEM key. The host never sees that key, so that part can't fail, and the suite doesn't grade it. The test's other half presents Alice's commit as Bob's, a real repo-binding check. That half maps to `records.commit-repo-space-match`. At these pins it checks Bob's signing key against the old signed commit.

**D. 0016's policy methods.** The policy rows grade the Oct 29 methods: `space.getSpace` returning the `policy` object, and `memberspace.putMember`, `listMembers` and `removeMember`. HappyView's tests use the Oct 22 `simplespace.*` methods on these images (on ZDS, its test picks whichever the image serves). None of the four images serves `memberspace.*` or an Oct 29 `getSpace`:
- `policy.create-get-roundtrip` fails on all four;
- `policy.member-methods` and `policy.put-member-upsert` fail on all four.

Every PDS must serve the three baseline policies (`#baseline-policies`), so all four manifests claim them, the reference included, and all four are graded on them.

**E. The lexicon's `cursor`.** The `listRepoOps` lexicon says `cursor` takes precedence over `since`. HappyView's client sends `since` as well as `cursor`, to work around pds.js. The suite follows `cursor` alone. It never retries a request in an implementation's own shape, because that would hide the behaviour under test. pds.js ignores `cursor`, so following it repeats the first page:
- `oplog.pagination-complete` and `oplog.pagination-batch-boundary` fail on pds.js;
- both are listed deviations, tracked by [pds.js#5](https://tangled.org/chadtmiller.com/pds.js/issues/5).

HappyView's `pdsjs_drops_ops_when_a_page_ends_inside_a_batch` pins the same bug from the other side.

**F. pds.js's typed-record CIDs.** `digest.cid-drisl-typed` fails on pds.js: all four typed fixture records (a `$link`, a `$bytes`, and integers past 32 bits) get CIDs that differ from DRISL. HappyView's `pdsjs_encodes_large_integers_differently_from_the_reference` pins the same divergence. It's a listed deviation, tracked by [pds.js#4](https://tangled.org/chadtmiller.com/pds.js/issues/4).

## Per test

"Pass", "fail" and "skip" are the suite's results. "Skip (pending)" is a row the suite can't judge at these pins. HappyView passed every test listed here. HappyView-only tests are listed at the end.

### ZDS

| HappyView test | Assertions | Suite | Cause |
|---|---|---|---|
| `zds_advertises_put_member_under_its_current_name` | `policy.member-methods` | fail | D |
| `our_policy_and_app_access_unions_round_trip_through_zds` | `policy.create-get-roundtrip` | fail | D |
| `our_member_shape_round_trips_through_put_member_and_list_members` | `policy.put-member-upsert` | fail | D |
| `a_commit_written_by_zds_verifies_and_agrees_with_our_set_hash` | `digest.matches-record-set` / `mac.commit-valid` / `records.commit-fields` | fail / skip (pending) / fail | A / B / A |
| `replaying_the_zds_oplog_across_pages_reproduces_its_commit` | `oplog.pagination-complete` / `oplog.fold-matches-commit` / `oplog.entry-shape` | pass / fail / pass | - / A / - |
| `zds_encodes_commit_bytes_as_lexicon_bytes_not_bare_strings` | `records.commit-bytes-encoding` | fail | A |
| `the_migration_replay_lands_on_zds_with_the_hash_it_expects` | `digest.multi-batch` / `digest.cid-drisl-typed` | fail / pass | A / - |

### pds.js

| HappyView test | Assertions | Suite | Cause |
|---|---|---|---|
| `the_probe_tier_would_reach_the_same_answers_for_pdsjs` | `info.unknown-method-status` | 501, as HappyView expects | - |
| `a_commit_written_by_pdsjs_verifies_and_agrees_with_our_set_hash` | `digest.covers-overwrite-and-delete` / `mac.commit-valid` | fail / skip (pending) | A / C |
| `replaying_the_pdsjs_oplog_across_pages_reproduces_its_commit` | `oplog.pagination-complete` / `oplog.since-exclusive` / `oplog.fold-matches-commit` | known deviation / pass / fail | E / - / A |
| `the_migration_replay_lands_on_pdsjs_with_the_hash_it_expects` | `digest.multi-batch` | fail | A |
| `pdsjs_encodes_large_integers_differently_from_the_reference` | `digest.cid-drisl-typed` | known deviation | F |
| `pdsjs_drops_ops_when_a_page_ends_inside_a_batch` | `oplog.pagination-batch-boundary` | known deviation | E |

### atproto-pds

| HappyView test | Assertions | Suite | Cause |
|---|---|---|---|
| `a_commit_written_by_atproto_pds_verifies_and_agrees_with_our_set_hash` | `digest.covers-overwrite-and-delete` / `mac.commit-valid` | fail / skip (pending) | A / B |
| `a_commit_from_another_repo_does_not_verify_as_ours` | `mac.commit-bound-to-repo` / `records.commit-repo-space-match` | not applicable / fail | C / A |
| `replaying_the_atproto_pds_oplog_across_pages_reproduces_its_commit` | `oplog.pagination-complete` / `oplog.fold-matches-commit` | pass / fail | - / A |
| `a_page_ending_inside_a_batch_loses_nothing` | `oplog.pagination-batch-boundary` | pass | - |
| `the_migration_replay_lands_on_atproto_pds_with_the_hash_it_expects` | `digest.multi-batch` / `digest.cid-drisl-typed` | fail / pass | A / - |

### Reference (`pds-spaces-alpha`)

| HappyView test | Assertions | Suite | Cause |
|---|---|---|---|
| `unauthenticated_space_method_proves_the_route_exists` | `records.read-requires-auth` / `info.read-auth-status` | pass / 401, as HappyView expects | - |
| `control_probe_distinguishes_a_missing_route` | `info.unknown-method-status` | 400, as HappyView expects | - |
| `a_commit_written_by_the_reference_pds_verifies_and_agrees_with_our_set_hash` | `digest.covers-overwrite-and-delete` / `mac.commit-valid` | fail / skip (pending) | A / B |
| `a_commit_from_another_repo_does_not_verify_as_ours` | `mac.commit-bound-to-repo` / `records.commit-repo-space-match` | not applicable / fail | C / A |
| `the_migration_replay_lands_on_the_reference_pds_with_the_hash_it_expects` | `digest.multi-batch` / `digest.cid-drisl-typed` | fail / pass | A / - |
| `replaying_the_oplog_reproduces_the_hosts_commit` | `oplog.fold-matches-commit` / `oplog.stale-values-omitted` / `oplog.entry-shape` | fail / pass / pass | A / - / - |
| `a_repo_longer_than_one_page_is_collected_in_full` | `oplog.pagination-complete` | pass | - |
| `syncing_from_a_cursor_returns_only_later_ops` | `oplog.since-exclusive` | pass | - |
| `our_policy_and_app_access_unions_round_trip_through_the_reference_pds` | `policy.create-get-roundtrip` | fail | D |
| `our_member_shape_round_trips_through_put_member_and_list_members` | `policy.put-member-upsert` | fail | D |

### Rows with no single HappyView test

These "today" rows check things HappyView's tests do along the way, and the migration map gives them no test of their own. They pass on all four images:
- `records.crud-roundtrip`
- `records.apply-writes-atomic`
- `lifecycle.implicit-create`
- `digest.cid-drisl-plain`

### Not ported

These HappyView tests check HappyView's own behaviour as a client, not the spec, so they stay in HappyView:
- capability detection: 7 tests;
- the probe heuristics: 3 tests;
- the typed-values handoff refusal: 1 test;
- the migration end-to-end test.

Four tests of Oct 22 shapes are retired:
- `pdsjs_serves_both_member_method_spellings`;
- `pdsjs_answers_the_single_policy_field_from_the_read_policy_alone`;
- `atproto_pds_serves_only_the_canonical_member_method`;
- `atproto_pds_stores_split_read_and_write_policies`.

## Setup modes

Every adapter can create spaces through the Oct 29 `space.createSpace`, the Oct 22 `simplespace.createSpace`, or `auto`, which tries Oct 29 first (`node cli/run.ts <id> --setup-mode`). None of the pinned images serves the Oct 29 method. A probe on Nov 11, 2026 got:

| Implementation | `com.atproto.space.createSpace` |
|---|---|
| ZDS | 404 `UnknownMethod` |
| pds.js | 501 `MethodNotImplemented` |
| atproto-pds | 501 `MethodNotImplemented` |
| reference | 400 "No service configured for com.atproto.space.createSpace" |

So the results above use `simplespace`, as HappyView's tests do. An `oct29` run against these pins records `error` (setup) on every row that needs a space, and never `fail`. An `auto` run resolves to `simplespace` and records it.

## Spec gaps found along the way

- **STAR framing.** The pinned 0016 text (`701ef9c6be`, `#repo-serialization`) draws the archive without the `0x01` and `0x00` control bytes, but also says "Framing and parsing follow STAR's rules". STAR's own interop fixtures, the reference implementation and HappyView all use the control bytes, so the harness does too (`vectors/README.md`). Later revisions of the proposal draw them.
- **The MAC on reads without a space credential.** 0016 requires the MAC only on space-credential reads. It says nothing about a read without one (OAuth or a password session) that sends `Atproto-Space-Want-Mac`. pds.js answers such a password-session read with no MAC.
