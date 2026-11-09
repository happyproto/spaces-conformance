# Test vectors

Inputs and expected outputs for the harness's crypto, as plain JSON, so a harness in another language can reuse them (design ch. 3.4). `test/vectors.test.ts` runs every file on each PR.

Each vector lists its `sources`:

| Source | Meaning |
|---|---|
| `spec ...` | A constant or example in Proposal 0016 at the pinned revision. |
| `RFC 9180 appendix A.3.1` | The DHKEM(P-256, HKDF-SHA256) test vector. It's independent of every space implementation. |
| `atproto#5187 ...` | An expected value from a test in the reference implementation, at `98ef3a6b`. Only the values are used, not the code. |
| `HappyView ...` | An expected value from a test in HappyView's Rust, at `9f084f5c`. Only the values are used, not the code. |
| `@ipld/dag-cbor 9.2.5` | Recomputed with that third-party encoder in a separate cross-check, outside this repo. |
| `node:crypto HMAC (in the test)` | Recomputed in the test with Node's own HMAC, a second HMAC implementation. |
| `harness` | Computed by this harness only. |

A vector whose only source is `harness` carries `cross_check: pending`. Phase 3 compares each one once against HappyView and the reference PDS. If two of the three agree and the harness disagrees, the harness is wrong.

| File | Covers |
|---|---|
| `lthash.json` | The set hash, including the empty digest. |
| `cid.json` | DRISL record CIDs, including `$link`, `$bytes`, integers near 2^32 and 2^53-1, and raw CIDs. |
| `kem.json` | The HKDF shared secret. |
| `mac.json` | Commit and record MACs. |
| `httpsig.json` | The RFC 9421 signature base and `Signature-Input`. |
| `star.json` | One valid `atproto-space-repo` archive. The rejections are built in the test. |
