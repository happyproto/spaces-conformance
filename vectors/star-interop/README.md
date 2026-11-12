# STAR interop fixtures

Copied unmodified from [microcosm.blue/star](https://tangled.org/microcosm.blue/star/tree/main/interop) at commit `41bdec1fd1be7f6f30a1f961a01442b2fa2ec3c1`, under its MIT / Apache-2.0 license. Upstream's licence texts are copied verbatim beside them: `LICENSE.MIT` and `LICENSE.Apache-2.0`. Upstream has no NOTICE file. They're STAR's own conformance fixtures. They reached this repo through the reference implementation's copy (`atproto#5187` at `98ef3a6b`, `packages/star/tests/interop`), which is byte for byte the same. Update them by copying from upstream, not by editing them here.

- `valid-star-fixtures.json`: 19 archives, each with its decoded metadata and pairs. The harness must read each one to exactly that, and write the same bytes back.
- `invalid-star-fixtures.json`: 37 archives the harness must reject.

`test/vectors.test.ts` runs both. These fixtures cover STAR's framing only. The `atproto-space-repo` profile's own rules are covered in `vectors/star.json`.
