#!/usr/bin/env bash
# Validates PR title for PRs targeting `main`.
#
# The desktop updater installs only when latest.json.version is strictly newer
# than the installed version. A dev -> main squash commit must therefore use a
# release-triggering Conventional Commit type; otherwise release-please may
# produce no version bump, no release, and no update for end users.
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

# Conventional commit types allowed on `dev -> main` squash merges.
# Keep this set restricted to types that produce a release-please semver bump.
if [[ "$PR_TITLE" =~ ^(feat|fix)(\(.+\))?\!?:\ .+ ]]; then
    echo "PR title follows conventional commits: $PR_TITLE"
    exit 0
fi

echo "::error::PR title does not follow the conventions required for dev→main merges."
echo "::error::Your title: $PR_TITLE"
echo "::error::"
echo "::error::Expected format: type(scope): description"
echo "::error::Allowed release-triggering types for PRs to main: feat, fix"
echo "::error::"
if [[ "$PR_TITLE" =~ ^(build|chore|ci|docs|perf|refactor|revert|style|test)(\(.+\))?\!?:\ .+ ]]; then
    echo "::error::'${BASH_REMATCH[1]}' is NOT allowed for PRs to main — it does not guarantee"
    echo "::error::a release-please version bump. The desktop updater only installs when"
    echo "::error::latest.json.version is greater than the installed version, so a non-releasing"
    echo "::error::main squash can strand code changes outside the user update path. See issue #371."
    echo "::error::"
    echo "::error::Use 'feat(...)' or 'fix(...)' instead, matching the"
    echo "::error::dominant user-visible release reason. Non-release types remain valid for"
    echo "::error::PRs targeting 'dev'."
fi
exit 1
