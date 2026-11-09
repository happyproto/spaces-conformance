#!/bin/sh
# Bring up base + the given implementations' fragments, apply each one's
# bootstrap, and leave the stack running. Usage: cli/stack.sh up happyview pdsjs
#                                                 cli/stack.sh test | down
# Phase 2's TypeScript stack runner replaces this.
set -e
cd "$(dirname "$0")/.."
P=conformance-local
files="-f implementations/base.compose.yml"
for f in implementations/*/compose.yml; do files="$files -f $f"; done
dc() { docker compose -p $P --env-file pins/images.env $files "$@"; }
case "$1" in
  up)
    shift
    dc up -d --wait postgres plc caddy harness "$@"
    for impl in "$@"; do
      if [ "$impl" = happyview ]; then
        SCOPE='atproto space:com.example.conformance.space?authority=*&manage=create&manage=update&manage=delete&collection=*'
        CLIENT_ID=$(node -e 'console.log("http://localhost?"+new URLSearchParams({redirect_uri:"http://127.0.0.1/callback",scope:process.argv[1]}))' "$SCOPE")
        dc exec -T postgres psql -q -v ON_ERROR_STOP=1 -U conf -d happyview \
          -v client_id="$CLIENT_ID" -v scopes="$SCOPE" -v secret="${HV_CLIENT_SECRET:-hvs_conformance-secret}" < implementations/happyview/seed.sql
      fi
    done ;;
  test) dc exec -T -e CONFORMANCE_STACK=1 harness node_modules/.bin/vitest run --config vitest.stack.config.ts ;;
  down) dc down -v ;;
  *) echo "usage: $0 up <impl...> | test | down" >&2; exit 2 ;;
esac
