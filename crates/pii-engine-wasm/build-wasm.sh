#!/usr/bin/env bash
set -euo pipefail
# Builds the pii-engine-wasm artifact (.wasm + Node glue) consumed by the hub (F3.2/F3.3).
# Output goes to a known, gitignored directory: mcp-servers/policies/wasm-pkg/.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$SCRIPT_DIR/../../mcp-servers/policies/wasm-pkg}"
cd "$SCRIPT_DIR"

if ! wasm-pack build --target nodejs --release --out-dir "$OUT" .; then
  echo "wasm-opt step failed or is unavailable; retrying without optimization (raw artifact only)" >&2
  wasm-pack build --target nodejs --release --out-dir "$OUT" --no-opt .
fi
