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

Every positive vector carries a machine-readable `cross_check: {area, status, against}`:
- `area` is one of `cbor`, `lthash`, `mac`, `httpsig`, `jwt` or `star`. These are the same areas as the manifests' `lineage`.
- `status` is `cross-checked` when a source other than the harness agrees, and `pending` otherwise.

An area is **pending** while any of its vectors is pending, or while it has none. Each assertion lists the `areas` its check runs through (`spec/assertions.yaml`). While any of them is pending, the assertion is provisional (`harness/provisional.ts`). It's shown as "fail (provisional)", isn't scored, and only warns in CI. Phase 3 clears an area by comparing its pending vectors once against HappyView and the reference PDS. If two of the three agree and the harness disagrees, the harness is wrong.

Every verifier also has `negative` vectors, inputs it must reject. That way a harness that's too lenient can't pass its own positive vectors and clear an area.

| File | Covers |
|---|---|
| `jwt.json` | Compact JWS verification: RFC 7515 A.3 (ES256, with a high-S signature). |
| `lthash.json` | The set hash, including the empty digest. |
| `cid.json` | DRISL record CIDs, including `$link`, `$bytes`, integers near 2^32 and 2^53-1, and raw CIDs. |
| `kem.json` | The HKDF shared secret. |
| `mac.json` | Commit and record MACs. One commit vector has its full HMAC input written out in hex. Negatives: a flipped bit, a MAC for another repo, another URI. |
| `httpsig.json` | The RFC 9421 signature base and `Signature-Input`, plus fixed-key presentations (deterministic signatures) to accept or reject. |
| `star.json` | One valid `atproto-space-repo` archive. The rejections are built in the test. |
