#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$REPO_ROOT/mcp-servers/office"
"$REPO_ROOT/scripts/python-tool.sh" uv pip compile --generate-hashes --python-version 3.11 --python-platform linux --output-file=requirements.txt requirements.in >/dev/null
