#!/usr/bin/env bash
set -euo pipefail
# Builds the pii-engine-wasm artifact (.wasm + Node glue) consumed by the hub (F3.2/F3.3).
# Output goes to a known, gitignored directory: mcp-servers/policies/wasm-pkg/.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$SCRIPT_DIR/../../mcp-servers/policies/wasm-pkg}"
cd "$SCRIPT_DIR"

# wasm-pack never cleans its out-dir: a stale *_bg.wasm (e.g. from an older crate name)
# would survive the build and get staged into the hub image. Start from an empty dir.
rm -rf "$OUT"

if ! wasm-pack build --target nodejs --release --out-dir "$OUT" .; then
  echo "wasm-opt step failed or is unavailable; retrying without optimization (raw artifact only)" >&2
  wasm-pack build --target nodejs --release --out-dir "$OUT" --no-opt .
fi
