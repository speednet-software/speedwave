#!/usr/bin/env bash
set -euo pipefail

if [ -n "$(git tag --points-at HEAD --list 'v*+*')" ]; then
  echo "skip=true"
  exit 0
fi

SINCE="$(git describe --tags --abbrev=0 --match 'v*+*' HEAD 2>/dev/null \
  || git describe --tags --abbrev=0 --match 'v*' HEAD 2>/dev/null \
  || true)"

if [ -z "$SINCE" ]; then
  echo "::error::no v* tag is an ancestor of HEAD, cannot bound the beta release notes" >&2
  exit 1
fi

echo "skip=false"
echo "since=$SINCE"
