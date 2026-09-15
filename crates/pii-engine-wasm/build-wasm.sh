#!/usr/bin/env bash
set -euo pipefail
# Builds the pii-engine-wasm artifact (.wasm + Node glue) consumed by the hub (F3.2/F3.3).
# Output goes to a known, gitignored directory: mcp-servers/policies/wasm-pkg/.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# --lock (npm's build:wasm) waits on the .wasm-build.lock beside the out dir; the bundle scripts omit
# it because they already hold that lock through their later copy of the artifact.
LOCK=""
if [ "${1:-}" = "--lock" ]; then LOCK=1; shift; fi
OUT="${1:-$SCRIPT_DIR/../../mcp-servers/policies/wasm-pkg}"
# The rm and wasm-pack's --out-dir below resolve a relative path from the crate dir, so anchor a
# caller-relative one (the .ps1 passes one) with `/` separators; absolute forms as in cargo-target-dir.sh.
case "$OUT" in /* | [A-Za-z]:* | \\\\*) ;; *) OUT="$PWD/${OUT//\\//}" ;; esac
if [ -n "$LOCK" ]; then
  # shellcheck source=../../scripts/mkdir-lock.sh
  source "$SCRIPT_DIR/../../scripts/mkdir-lock.sh"
  mkdir -p "$(dirname "$OUT")"
  acquire_lock "$(dirname "$OUT")/.wasm-build.lock"
fi
cd "$SCRIPT_DIR"

# wasm-pack never cleans its out-dir: a stale *_bg.wasm (e.g. from an older crate name)
# would survive the build and get staged into the hub image. Start from an empty dir.
rm -rf "$OUT"

if ! wasm-pack build --target nodejs --release --out-dir "$OUT" .; then
  echo "wasm-opt step failed or is unavailable; retrying without optimization (raw artifact only)" >&2
  wasm-pack build --target nodejs --release --out-dir "$OUT" --no-opt .
fi
