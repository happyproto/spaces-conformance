# HAP-408 phase 0 spikes

Throwaway scripts that prove the two things the design (ch. 4.2, 6.1) left open. Nothing here is graded and none of it is the harness. The phase 0 write-up records what they found.

| Script | Proves |
|---|---|
| `spike1.sh` → `spike1-auth.ts` | HappyView accepts a real OAuth/DPoP session obtained through pds.js's headless consent, with `authority=*` and `manage=` grants. createSpace, getSpace and createRecord then work over DPoP. |
| `spike2.sh` → `spike2-net.ts` | On one internal bridge network with an IPv6 documentation subnet and a Caddy `tls internal` front, the harness, HappyView, pds.js and ZDS (Zig) reach each other by name, over https where TLS applies, and trust Caddy's CA. |

```sh
spikes/spike1.sh                # brings the stack up, seeds HappyView, runs spike 1
spikes/spike2.sh                # same, then spike 2 and a Caddy access-log summary
spikes/stack/dc down -v         # tear down
```

The stack (`stack/compose.yml`) runs HappyView `sha-9f084f5` (3.0.0-beta.6, `9f084f5c`), two pds.js accounts, ZDS, PLC, Postgres, Caddy and an idle harness container. The pds.js, ZDS and PLC images are pinned to HappyView's `interop/images.env` digests. Nothing is published to the host, and the network is `internal`, so nothing in it can reach the internet.

HappyView is bootstrapped by `stack/seed.sql`, which sets `feature.spaces_enabled` and registers one confidential API client. That's ungraded setup (design ch. 3.1). TODO(HAP-415): use HappyView's env var for spaces once it ships.
