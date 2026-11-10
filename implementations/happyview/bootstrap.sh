#!/bin/sh
# HappyView bootstrap (ungraded): seed.sql with the harness API client.
# cli/run.ts sets $COMPOSE to this run's docker compose command.
set -e
SCOPE='atproto space:com.example.conformance.space?authority=*&manage=create&manage=update&manage=delete&collection=*'
CLIENT_ID=$(node -e 'console.log("http://localhost?"+new URLSearchParams({redirect_uri:"http://127.0.0.1/callback",scope:process.argv[1]}))' "$SCOPE")
$COMPOSE exec -T postgres psql -q -v ON_ERROR_STOP=1 -U conf -d happyview \
  -v client_id="$CLIENT_ID" -v scopes="$SCOPE" -v secret="${HV_CLIENT_SECRET:-hvs_conformance-secret}" \
  < implementations/happyview/seed.sql
