# spaces-conformance

An over-the-wire conformance suite for atproto spaces ([Proposal 0016](https://github.com/bluesky-social/proposals/tree/701ef9c6be5a99c2d3e87e107fe2531459d1c984/0016-permissioned-data), October 29 revision). It grades space hosts and repo hosts against the spec text, talking to each implementation only over HTTP.

**Status: phase 0.** The formats and their validators exist, and nothing runs against an implementation or gets scored yet.

## Layout

| Path | What |
|---|---|
| `spec/revisions.json` | Pinned proposal and lexicon commits. The proposal text is fetched by commit and checked by SHA-256. |
| `spec/assertions.yaml` | The assertion catalogue. Each row cites a sentence of the pinned text. |
| `schemas/` | JSON Schemas for assertions, manifests, deviations and results. |
| `harness/` | Loaders and validators. The client, crypto and actors land here in phase 2. |
| `implementations/` | `base.compose.yml`, plus one folder per implementation with a manifest, a compose fragment and, if it has any, known deviations. |
| `pins/images.env` | Image digests. They change only by pull request. |
| `cli/validate.ts` | Validates every data file. |
| `docs/catalogue.md` | The formats and the rules the validator enforces. |
| `spikes/` | The phase 0 spikes (HappyView auth, networking) and their findings, kept as a record. Not part of the harness. |

## Working on it

Requires Node 24+ and Bun.

```sh
bun install
bun run check      # typecheck, unit tests, validate
```

To bring up a stack by hand:

```sh
docker compose --env-file pins/images.env \
  -f implementations/base.compose.yml \
  -f implementations/happyview/compose.yml \
  -f implementations/pdsjs/compose.yml up -d --wait
```

The network is internal, so nothing in the stack can reach the internet. Caddy fronts each implementation as `https://<name>.test` with its own CA, and every container trusts that CA. pds.js is served over plain http (see `implementations/base/Caddyfile`).

## Licence

MIT. See `LICENSE`.
