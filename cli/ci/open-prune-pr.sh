#!/bin/sh
# Open a PR that removes deviation entries the nightly runs show as fixed
# (design ch. 4.4 rule 6, cli/prune.ts). The branch is prune/<yyyy-mm-dd>.
# One PR at a time: while a prune PR is open, this does nothing, so a fix
# isn't proposed twice.
#
#   cli/ci/open-prune-pr.sh <results.json>...
#
# Uses GH_TOKEN for gh. PUBLISH_DRY_RUN=1 prints the PR instead.

set -eu
dry=${PUBLISH_DRY_RUN:-}
if [ -z "$dry" ] && [ -n "$(gh pr list --state open --search 'head:prune/' --json number --jq '.[].number')" ]; then
  echo "a prune PR is already open"
  exit 0
fi
changes=$(node cli/prune.ts "$@" --write)
printf '%s\n' "$changes"
if git diff --quiet -- implementations; then
  echo "nothing to prune"
  exit 0
fi
bun run validate >/dev/null
git config user.name >/dev/null 2>&1 || {
  git config user.name 'github-actions[bot]'
  git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
}
base=$(git rev-parse --abbrev-ref HEAD)
branch="prune/$(date -u +%Y-%m-%d)"
# A branch left from a closed prune PR gets a successor; nothing is force-pushed.
if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then branch="$branch-$(date -u +%H%M%S)"; fi
git checkout -q -B "$branch"
git add implementations
git commit -q -m "chore(deviations): remove entries the nightly runs show as fixed"
# shellcheck disable=SC2016 # the backticks are Markdown, not a command.
body=$(printf 'The nightly runs pass these listed assertions, so their entries come out (`cli/prune.ts`).\n\n```\n%s\n```\n' "$(printf '%s\n' "$changes" | grep -v '^pruned=')")
title="chore(deviations): remove entries fixed as of $(date -u +%Y-%m-%d)"
if [ -n "$dry" ]; then
  echo "dry run: would push $branch and open \"$title\""
  git --no-pager show --stat --format='%s' HEAD
  printf '%s\n' "$body"
  git checkout -q "$base"
  exit 0
fi
git push -q origin "HEAD:refs/heads/$branch"
gh pr create --base main --head "$branch" --title "$title" --body "$body"
