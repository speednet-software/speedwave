#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "::error::usage: beta-release-notes.sh <since-tag>" >&2
  exit 1
fi

NOTES="${BODY:-}"
if [ -z "${NOTES//[[:space:]]/}" ]; then
  NOTES="No user-facing changes since $1."
fi

echo "body<<SPEEDWAVE_NOTES_EOF"
printf '%s\n' "$NOTES"
echo "SPEEDWAVE_NOTES_EOF"
