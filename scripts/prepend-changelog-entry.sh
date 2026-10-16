#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: prepend-changelog-entry.sh <version> <compare-url> (notes on stdin)}"
COMPARE_URL="${2:?usage: prepend-changelog-entry.sh <version> <compare-url> (notes on stdin)}"
DATE="$(date -u +%Y-%m-%d)"

ENTRY_FILE="$(mktemp)"
trap 'rm -f "$ENTRY_FILE"' EXIT

{
  echo "## [${VERSION}](${COMPARE_URL}) (${DATE})"
  echo
  cat -
} > "$ENTRY_FILE"

{
  head -n 1 CHANGELOG.md
  echo
  cat "$ENTRY_FILE"
  echo
  tail -n +2 CHANGELOG.md
} > CHANGELOG.md.new
mv CHANGELOG.md.new CHANGELOG.md

git add CHANGELOG.md
git commit -m "chore(release): changelog ${VERSION}"
