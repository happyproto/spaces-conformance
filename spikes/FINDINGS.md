# HAP-408 phase 0: spikes and skeleton

**Both spikes worked, so the design's primary paths hold and no fallback is needed. The skeleton is built, and the revised estimate is 28 to 39 agent-days, down from 30 to 42.**

| | |
|---|---|
| Date | 2026-11-09 |
| Builder | spaces-conformance-11, for MARVIN |
| Images | HappyView `sha-9f084f5` (3.0.0-beta.6, `9f084f5c`). pds.js, ZDS and PLC at HappyView's `interop/images.env` digests |
| Branches | `spike/hap408-phase0` (spikes), `feat/hap408-phase0-skeleton` (skeleton) |

## 1. Spike 1: HappyView auth (works)

The harness got a real HappyView DPoP session and wrote through it:

1. **Bootstrap (ungraded).** A SQL seed runs once `/health` answers:
   - it sets `feature.spaces_enabled`;
   - it registers one confidential API client, with its secret's SHA-256 in `happyview_api_client_secrets`.

   HappyView reads flags from the database per request, so nothing restarts. There's no headless admin path: the platform key carries only stats and metrics permissions. The seed is marked TODO(HAP-415).
2. **Client id.** A loopback id, `http://localhost?redirect_uri=http://127.0.0.1/callback&scope=<scope>`. pds.js generates the metadata for it, so nothing has to host a metadata document.
3. **The flow:**
   - `POST /oauth/dpop-keys` with the client key and secret. HappyView returns the private DPoP JWK.
   - PAR at pds.js, DPoP-signed with that key, with one nonce retry.
   - `POST /oauth/authorize` with the account password and `Accept: application/json`, which returns the redirect.
   - Token exchange.
   - `POST /oauth/sessions`.
   - XRPC calls with `Authorization: DPoP`, a `DPoP` proof and `X-Client-Key`.
4. **Grant:** `atproto space:<type>?authority=*&manage=create&manage=update&manage=delete&collection=*`. pds.js granted it as requested.
5. **Writes:** createSpace (200), getSpace (200, policy round-trips), and createRecord (201, stored by HappyView).

Because this worked, the dashboard-cookie fallback wasn't needed and wasn't tried.

## 2. Spike 2: networking (works)

The stack is one compose project. The network is `internal: true` (no egress), on the IPv6 subnet `3fff:408::/64`. Caddy fronts each implementation with `tls internal`. Evidence for each leg is in Caddy's JSON access log, which records Host and the caller's address.

| From → to | Over | Evidence |
|---|---|---|
| harness → HappyView, ZDS, harness | https, IPv6 | 200s from `3fff:408::9`, trusted through `NODE_EXTRA_CA_CERTS` |
| HappyView → harness | https, IPv6 | `getSession` on `https://harness.test` from `3fff:408::5` during session registration |
| pds.js → HappyView | https, IPv6, `Host: happyview.test` | `notifyWrite` after a native write into a HappyView space |
| ZDS (Zig TLS) → harness | https, IPv4 | `POST requestCrawl` through `ZDS_CRAWLERS=https://harness.test` |

HappyView and ZDS trust Caddy through an entrypoint that installs its root into the Debian store (`update-ca-certificates`), as `docker-compose.e2e.yml` does. Node images use `NODE_EXTRA_CA_CERTS`.

## 3. What the spikes found

**Design changes:**

1. **pds.js is served over plain http.** It builds its OAuth issuer and DPoP `htu` from the socket's own scheme and ignores `X-Forwarded-Proto`. Behind a TLS front it advertises `http://` endpoints, so issuer, `htu` and DID-document endpoint disagree. Caddy serves `http://pdsjs-<name>.test`, and DID docs name that URL. (Ch. 6.1. It's also an upstream issue worth raising with the pds.js maintainers once Q5's heads-up has happened.)
2. **The spaces-off "carol" twin goes.** A spaces-off pds.js refuses every `space:` scope at PAR (`invalid_scope`), so such a user can't get a grant that HappyView accepts for a write (403). It isn't needed anyway. While `feature.spaces_pds_migration` is off, HappyView hosts every author's space repo itself, spaces-on pds.js users included. So alice and bob are both partners and HappyView's repo-host subjects. (Ch. 4.2, accounts per run: four pds.js containers, not five.)
3. **The harness is a long-running service.** `compose run` containers get no DNS name, so Caddy couldn't reach the harness's receiver or managing-app actors. The runner execs into an idle harness service. (Ch. 6.1.)
4. **The network is internal.** On an unrouted method (`memberspace.putMember`), HappyView tried to resolve a lexicon authority by public DNS. On an internal network that fails fast and stays inside the stack. (Ch. 6.1.)
5. **ZDS binds IPv4 only** (`0.0.0.0`) and dials over IPv4. It's still reachable by name through Caddy. If some implementation refuses non-routable IPv4 peers, as Tranquil does, ZDS needs `ZDS_HOST=::`. That's untested.

**For HappyView** (not phase 0 work; MARVIN to route):

6. One HappyView security finding was reported privately.
7. `com.atproto.memberspace.putMember` isn't routed (502 from the proxy path). This is already in ch. 4.5 under `memberspace-under-simplespace`.
8. HappyView answers createRecord with 201. pds.js and ZDS answer 200. The spec names no status, so this is at most an `info` row.
9. HappyView answers 401 to pds.js's `notifyWrite`. That's phase 7 material: it's the `writers.notify-write-sent` path.

**For other implementations** (phase 7 material):

10. After a write into a HappyView space, ZDS never contacted HappyView. The binary references an `atproto_space_host` service id, while HappyView's space DIDs publish only `#atproto_pds`. One side doesn't match the spec. Check it against `#credential-flow` and `#write-notifications` in phase 7.

**Still open, unchanged:** `scope.bare-grant-declared-collections` needs HappyView to resolve the fixture space type's declaration with no DNS. That needs a local lexicon source, probably through `HAPPYVIEW_PROJECT`. Not spiked.

## 4. Skeleton

On `feat/hap408-phase0-skeleton`. `bun run check` passes: typecheck, 34 unit tests, and validation of every data file.

- **Catalogue:** `spec/assertions.yaml`, `schemas/assertions.schema.json`, `harness/catalogue.ts`. The validator enforces:
  - the level/basis rule (ch. 3.1);
  - each basis on its own terms (`keyword` needs a keyword of the row's level, `default` needs "default" and only goes on `should`);
  - quotes verbatim in the pinned text, which is fetched by commit and checked by SHA-256;
  - `section` values that are real heading anchors;
  - unique ids and known revisions.

  It ships 11 seed rows with real quotes. Phase 1 fills in the rest.
- **Manifests:** for HappyView, pds.js and ZDS, the three the spike proved. The validator checks pins, compose files, partners, profile versus roles, and capability-path resolution for `requires`.
- **Deviations:** the schema plus catalogue cross-checks. `tracking` must be a real issue, so `pending` is refused, per Q10.
- **Results:** the ch. 7.1 schema, plus at most one result per assertion, the evidence cap, applied deviations that each have a result, and consistent summaries.
- **Compose:** `implementations/base.compose.yml` plus per-implementation fragments, split from the spike stack. They come up healthy, and CI checks that they assemble.
- **CI:** `.github/workflows/ci.yml`, with read-only permissions. It runs typecheck, tests, validate and compose config.

## 5. Revised estimate

| Phase | Design | Now | Why |
|---|---|---|---|
| 1. Catalogue | 2 to 3 | 1.5 to 2.5 | The validator, schemas and revision pinning are done. What's left is writing about 95 rows. |
| 2. Harness core | 5 to 7 | 4.5 to 6 | PLC genesis, DPoP, pds.js OAuth and the stack's CA trust exist as spike code to harden. |
| 3. Port | 3.5 to 5 | 3.5 to 5 | Unchanged. Three of four pinned images are still on the October 22 lifecycle. |
| **1 to 3** | **10.5 to 15** | **9.5 to 13.5** | |
| 4. HappyView | 5 to 7 | 4 to 6 | The auth path is proven, and one fewer partner type is needed. The lexicon-resolution question stays. |
| 5 to 7 | 12.5 to 16.5 | 12.5 to 16.5 | Unchanged. |
| **Total** | **30 to 42** | **28 to 39** (about 33 likely) | |

## 6. Blocked on

- **`main` doesn't exist.** The repo has no commits, so no PR can be opened until Trezy creates `main` or approves one initial commit. Both branches are ready to push.
- **Licence:** not chosen. `package.json` has none.
