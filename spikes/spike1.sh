#!/bin/sh
# Bring the stack up, seed HappyView, run spike 1.
set -e
cd "$(dirname "$0")/.."
D=spikes/stack/dc
$D up -d --wait
SCOPE='atproto space:com.example.conformance.space?authority=*&manage=create&manage=update&manage=delete&collection=*'
CLIENT_ID=$(node -e 'console.log("http://localhost?"+new URLSearchParams({redirect_uri:"http://127.0.0.1/callback",scope:process.argv[1]}))' "$SCOPE")
$D exec -T postgres psql -q -v ON_ERROR_STOP=1 -U conf -d happyview \
  -v client_id="$CLIENT_ID" -v scopes="$SCOPE" -v secret=hvs_conformance-spike-secret < spikes/stack/seed.sql
$D exec -T harness node spikes/spike1-auth.ts
