#!/usr/bin/env bash
set -euo pipefail

ALLOW_REUSE=false
if [ "${1:-}" = "--allow-reuse-same-commit" ]; then
  ALLOW_REUSE=true
  shift
fi

TAG="${1:?usage: tag-release-commit.sh [--allow-reuse-same-commit] <tag>}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  EXISTING_SHA="$(git rev-parse "${TAG}^{commit}")"
  HEAD_SHA="$(git rev-parse HEAD)"
  if [ "$ALLOW_REUSE" = "true" ] && [ "$EXISTING_SHA" = "$HEAD_SHA" ]; then
    echo "::notice::tag $TAG already exists on HEAD, reusing it"
    exit 0
  fi
  echo "::error::tag $TAG already exists, refusing to move it"
  exit 1
fi

git tag "$TAG"
git push origin "$TAG"
