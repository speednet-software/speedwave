#!/usr/bin/env bash

set -euo pipefail

SUFFIX_BUDGET=250
MAX_PATH=259

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
crate_dir="${1:-$repo_root/desktop/src-tauri}"
label="${2:-desktop build dir}"

target_dir="$(bash "$repo_root/scripts/cargo-target-dir.sh" "$crate_dir")" || exit 1

if command -v cygpath >/dev/null 2>&1; then
  win_target="$(cygpath -w "$target_dir" 2>/dev/null || echo "$target_dir")"
else
  win_target="$target_dir"
fi

if [ $(( ${#win_target} + SUFFIX_BUDGET )) -gt "$MAX_PATH" ]; then
  echo "❌ The $label is too deep for the ggml-vulkan shader build:" >&2
  echo "   $win_target (${#win_target} chars) + ~$SUFFIX_BUDGET of CMake scratch > $MAX_PATH (MAX_PATH)." >&2
  echo "   cl.exe cannot open such paths even with LongPathsEnabled. Run make setup-dev-windows" >&2
  echo "   (it provisions a short crate-local target-dir), or set CARGO_TARGET_DIR to a short" >&2
  echo "   directory, or clone the repo under a shorter path." >&2
  exit 1
fi
echo "✅ Vulkan build path budget OK ($win_target: ${#win_target} + $SUFFIX_BUDGET ≤ $MAX_PATH)"
