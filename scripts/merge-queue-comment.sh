#!/usr/bin/env bash

set -euo pipefail

HEAD_REF="${HEAD_REF:-}"

PR_NUMBER="$(printf '%s' "$HEAD_REF" | grep -oE 'pr-[0-9]+-' | grep -oE '[0-9]+' || true)"
if [[ -z "$PR_NUMBER" ]]; then
    echo "::error::merge-queue-comment: could not parse a PR number out of merge_group.head_ref ($HEAD_REF)" >&2
    exit 1
fi

BASE="${SERVER_URL:?SERVER_URL is required}/${REPO:?REPO is required}/actions/workflows/test.yml"
BRANCH="${HEAD_REF//\//%2F}"
RUNS_URL="$BASE?query=branch%3A$BRANCH"
BADGE_URL="$BASE/badge.svg?branch=$BRANCH&event=merge_group"

printf '🚦 Merge queue run: [![test](%s)](%s) [logs](%s)\n' "$BADGE_URL" "$RUNS_URL" "$RUNS_URL" |
    gh pr comment "$PR_NUMBER" --repo "$REPO" --body-file -
