#!/usr/bin/env bash

set -euo pipefail

PR_TITLE="${PR_TITLE:-}"
HEAD_REF="${HEAD_REF:-}"

if [[ "$HEAD_REF" == release-please--* ]]; then
    echo "Release-please PR — skipping title check"
    exit 0
fi

if [[ "$HEAD_REF" == chore/backmerge-* ]]; then
    echo "Backmerge PR — skipping title check"
    exit 0
fi

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
