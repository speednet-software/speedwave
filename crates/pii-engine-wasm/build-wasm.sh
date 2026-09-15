#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$SCRIPT_DIR/../../mcp-servers/policies/wasm-pkg}"
case "$OUT" in /* | [A-Za-z]:*) ;; *) OUT="$PWD/$OUT" ;; esac
cd "$SCRIPT_DIR"

rm -rf "$OUT"

if ! wasm-pack build --target nodejs --release --out-dir "$OUT" .; then
  echo "wasm-opt step failed or is unavailable; retrying without optimization (raw artifact only)" >&2
  wasm-pack build --target nodejs --release --out-dir "$OUT" --no-opt .
fi
