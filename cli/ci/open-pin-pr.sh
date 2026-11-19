#!/bin/sh
# Open a pin PR for a candidate that passed (design ch. 6.2).
#
#   cli/ci/open-pin-pr.sh <impl> <image> <results.json>
#
# Runs from a full checkout of main. The branch is pin/<impl>-<digest12>, so
# a second dispatch of the same image finds the open PR and does nothing.
# cli/pin.ts makes the change; `bun run validate` must pass on it before
# anything is pushed. Uses GH_TOKEN for gh.
#
# PUBLISH_DRY_RUN=1 builds and validates the commit, then prints the PR it
# would open instead of pushing.

set -eu
impl=$1 image=$2 file=$3
digest=${image#*@sha256:}
branch="pin/$impl-$(printf '%s' "$digest" | cut -c1-12)"
old=$(node cli/ci/targets.ts pin "$impl")
dry=${PUBLISH_DRY_RUN:-}

if [ -z "$dry" ] && [ -n "$(gh pr list --head "$branch" --state open --json number --jq '.[].number')" ]; then
  echo "a pin PR from $branch is already open"
  exit 0
fi

git config user.name >/dev/null 2>&1 || {
  git config user.name 'github-actions[bot]'
  git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
}
base=$(git rev-parse --abbrev-ref HEAD)
git checkout -q -B "$branch"
node cli/pin.ts "$impl" "$image" --results "$file"
bun run validate >/dev/null
git add pins/images.env evidence/passes.json test/fixtures/results/
git commit -q -m "chore(pins): move $impl to ${image#*@} after a clean candidate run"
body=$(node cli/report.ts "$file" --body pin --old-image "$old")
title="chore(pins): move $impl to sha256:$(printf '%s' "$digest" | cut -c1-12)"
if [ -n "$dry" ]; then
  echo "dry run: would push $branch and open \"$title\""
  git --no-pager show --stat --format='%s' HEAD
  printf '%s\n' "$body"
  git checkout -q "$base"
  exit 0
fi
git push -q origin "HEAD:refs/heads/$branch"
gh pr create --base main --head "$branch" --title "$title" --body "$body"
