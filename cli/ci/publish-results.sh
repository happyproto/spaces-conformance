#!/bin/sh
# Commit results files to the orphan `results` branch (design ch. 7.2).
#
#   cli/ci/publish-results.sh <message> <results.json>...
#
# Run from a checkout of this repository whose `origin` is the repository to
# publish to. It checks the branch out into ./.store (a separate worktree),
# creating it as an orphan if it doesn't exist yet, adds the files with
# `cli/store.ts add` (which validates them and writes nothing if any fails),
# checks the store, commits and pushes. A push that loses a race is retried
# on the new tip, up to three times.
#
# PUBLISH_DRY_RUN=1 does everything except the push.

set -eu
message=$1
shift
[ "$#" -gt 0 ] || { echo "no results files given" >&2; exit 2; }

root=$(pwd)
store="$root/.store"
branch=results
files=""
for f in "$@"; do files="$files $(cd "$(dirname "$f")" && pwd)/$(basename "$f")"; done

git config --global --get user.name >/dev/null 2>&1 || {
  git config --global user.name 'github-actions[bot]'
  git config --global user.email '41898282+github-actions[bot]@users.noreply.github.com'
}

checkout() {
  rm -rf "$store"
  git worktree prune
  if git fetch -q origin "refs/heads/$branch:refs/remotes/origin/$branch" 2>/dev/null; then
    git worktree add -q --detach "$store" "origin/$branch"
  else
    echo "no $branch branch on origin yet: starting it as an orphan"
    git worktree add -q --detach "$store"
    (cd "$store" && git checkout -q --orphan "$branch" && git rm -rfq . && git clean -fdxq)
    node "$root/cli/store.ts" init --store "$store"
  fi
}

attempt=1
while :; do
  checkout
  # shellcheck disable=SC2086 # $files is a list of absolute paths without spaces.
  node "$root/cli/store.ts" add --store "$store" $files
  node "$root/cli/store.ts" check --store "$store"
  cd "$store"
  git add -A
  if git diff --cached --quiet; then
    echo "nothing new to publish"
    cd "$root"
    exit 0
  fi
  git commit -q -m "$message"
  if [ "${PUBLISH_DRY_RUN:-}" = 1 ]; then
    echo "dry run: would push $(git rev-parse --short HEAD) to $branch"
    git --no-pager show --stat --format='%s' HEAD | head -20
    cd "$root"
    exit 0
  fi
  if git push -q origin "HEAD:refs/heads/$branch"; then
    echo "published $(git rev-parse --short HEAD) to $branch"
    cd "$root"
    exit 0
  fi
  cd "$root"
  attempt=$((attempt + 1))
  [ "$attempt" -le 3 ] || { echo "push to $branch failed three times" >&2; exit 1; }
  echo "push lost a race; retrying on the new tip"
done
