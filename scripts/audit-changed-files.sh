#!/usr/bin/env bash
set -euo pipefail

: "${1:?usage: audit-changed-files.sh BASE_SHA HEAD_SHA OUT_JSON}"
: "${2:?usage: audit-changed-files.sh BASE_SHA HEAD_SHA OUT_JSON}"
: "${3:?usage: audit-changed-files.sh BASE_SHA HEAD_SHA OUT_JSON}"

BASE_SHA="$1"
HEAD_SHA="$2"
OUT_JSON="$3"

git diff --name-only "$BASE_SHA" "$HEAD_SHA" | python3 -c '
import json, sys
paths = [line.rstrip("\n") for line in sys.stdin if line.strip()]
json.dump(paths, sys.stdout)
' >"$OUT_JSON"
