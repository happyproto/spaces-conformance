#!/bin/sh
# Let git push to this repository with $PUSH_TOKEN, from this step on.
#
# The publish jobs check out with persist-credentials: false and install
# dependencies with --ignore-scripts, so no write token is on disk or in the
# environment while third-party code installs. This runs after that, as its
# own step: least-privilege CI hardening.
set -eu
[ -n "${PUSH_TOKEN:-}" ] || { echo "PUSH_TOKEN is not set" >&2; exit 1; }
auth=$(printf 'x-access-token:%s' "$PUSH_TOKEN" | base64 | tr -d '\n')
echo "::add-mask::$auth"
git config --local http.https://github.com/.extraheader "AUTHORIZATION: basic $auth"
