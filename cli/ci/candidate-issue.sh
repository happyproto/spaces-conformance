#!/bin/sh
# Open, or update, the one issue per implementation for candidates with
# unexpected results (design ch. 6.2). The issue carries the label
# `candidate:<impl>`; while one is open, each new candidate replaces its body.
# Nothing is ever opened or posted on another project's repository (design ch. 9.3).
#
#   cli/ci/candidate-issue.sh <impl> <results.json>
#
# Uses GH_TOKEN for gh. PUBLISH_DRY_RUN=1 prints the issue instead.

set -eu
impl=$1 file=$2
label="candidate:$impl"
title="Candidate image of $impl has unexpected results"
body=$(node cli/report.ts "$file" --body issue)

if [ -n "${PUBLISH_DRY_RUN:-}" ]; then
  echo "dry run: would open or update the issue \"$title\" (label $label)"
  printf '%s\n' "$body"
  exit 0
fi
gh label create "$label" --color BFD4F2 --description "Candidate runs of $impl with unexpected results" --force >/dev/null
number=$(gh issue list --label "$label" --state open --json number --jq '.[0].number // empty')
if [ -n "$number" ]; then
  gh issue edit "$number" --body "$body"
  echo "updated issue #$number"
else
  gh issue create --title "$title" --label "$label" --body "$body"
fi
