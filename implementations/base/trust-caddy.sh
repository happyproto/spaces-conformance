#!/bin/sh
# Wait for Caddy's internal root CA, add it to a Debian system trust store,
# then exec the given command. Needs root: Caddy's pki/ tree is mode 0700.
set -e
CA_CERT=/caddy-data/caddy/pki/authorities/local/root.crt
while [ ! -f "$CA_CERT" ]; do sleep 0.5; done
cp "$CA_CERT" /usr/local/share/ca-certificates/caddy-local.crt
update-ca-certificates >/dev/null 2>&1
exec "$@"
