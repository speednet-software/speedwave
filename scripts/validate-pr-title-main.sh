#!/usr/bin/env bash
# Validates PR title for PRs targeting `main`.
#
# `chore(...)` is rejected here because release-please does not include
# `chore` in its changelog-sections (release-please-config.json), so a
# `chore` squash merge to main collapses feat/fix commits into an invisible
# release — no version bump, no release PR. See issue #371.
#
# Env vars:
#   PR_TITLE — the PR title to validate
#   HEAD_REF — the source branch name (for exemption logic)
#
# Exit codes:
#   0 — valid (or exempt)
#   1 — invalid

set -euo pipefail

PR_TITLE="${PR_TITLE:-}"
HEAD_REF="${HEAD_REF:-}"

# Release-please PRs are exempt (release-please manages its own titles).
if [[ "$HEAD_REF" == release-please--* ]]; then
    echo "Release-please PR — skipping title check"
    exit 0
fi

# Backmerge PRs are exempt (fallback merge when dev has diverged from main).
if [[ "$HEAD_REF" == chore/backmerge-* ]]; then
    echo "Backmerge PR — skipping title check"
    exit 0
fi

# Conventional commit types allowed on `dev → main` squash merges.
# `chore` is intentionally absent — see header comment and issue #371.
if [[ "$PR_TITLE" =~ ^(feat|fix|perf|refactor|docs|ci|test|build|style|revert)(\(.+\))?\!?:\ .+ ]]; then
    echo "PR title follows conventional commits: $PR_TITLE"
    exit 0
fi

echo "::error::PR title does not follow the conventions required for dev→main merges."
echo "::error::Your title: $PR_TITLE"
echo "::error::"
echo "::error::Expected format: type(scope): description"
echo "::error::Allowed types: feat, fix, perf, refactor, docs, ci, test, build, style, revert"
echo "::error::"
if [[ "$PR_TITLE" =~ ^chore(\(.+\))?\!?:\ .+ ]]; then
    echo "::error::'chore' is NOT allowed for PRs to main — release-please ignores chore commits,"
    echo "::error::so the squash merge would collapse all feat/fix commits from dev into an"
    echo "::error::invisible release (no version bump, no release PR). See issue #371."
    echo "::error::"
    echo "::error::Use 'feat(...)' or 'fix(...)' instead, matching the dominant change in this merge."
    echo "::error::'chore' is still fine for PRs targeting 'dev'."
fi
exit 1
