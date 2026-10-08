#!/usr/bin/env bash

set -euo pipefail

EVENT_NAME="${EVENT_NAME:-}"

case "$EVENT_NAME" in
pull_request)
    MESSAGE="${PR_TITLE:-}"
    ;;
merge_group)
    MESSAGE="${MERGE_GROUP_MESSAGE:-}"
    if [[ -z "$MESSAGE" ]]; then
        echo "::warning::resolve-pr-title-message: merge_group.head_commit.message is empty, falling back to the PR title via the API" >&2
        HEAD_REF="${HEAD_REF:-}"
        PR_NUMBER="$(printf '%s' "$HEAD_REF" | grep -oE 'pr-[0-9]+-' | grep -oE '[0-9]+' || true)"
        if [[ -z "$PR_NUMBER" ]]; then
            echo "::error::resolve-pr-title-message: could not parse a PR number out of merge_group.head_ref ($HEAD_REF)" >&2
            exit 1
        fi
        command -v gh >/dev/null 2>&1 || {
            echo "::error::resolve-pr-title-message: gh is required for the merge_group fallback" >&2
            exit 1
        }
        MESSAGE="$(gh pr view "$PR_NUMBER" --repo "${REPO:?REPO is required for the merge_group fallback}" --json title --jq .title)"
    fi
    ;;
*)
    echo "::error::resolve-pr-title-message: unsupported event '$EVENT_NAME' (expected pull_request or merge_group)" >&2
    exit 1
    ;;
esac

MESSAGE="$(printf '%s' "$MESSAGE" | head -n1)"

if [[ -z "$MESSAGE" ]]; then
    echo "::error::resolve-pr-title-message: no commit message resolved to validate" >&2
    exit 1
fi

printf '%s\n' "$MESSAGE"
