#!/usr/bin/env bash
# check-vulkan-path-budget.sh — fails loud before the ggml-vulkan build dies on MAX_PATH:
# cl.exe cannot open paths past it even with LongPathsEnabled (a cryptic C1083, ADR-085).

set -euo pipefail

# Deepest observed MSBuild-generator TryCompile scratch below the cargo target dir
# (cmTC_*.tlog\ParallelCustomBuild.command.1.tlog — 248 chars measured live; ninja is shallower).
SUFFIX_BUDGET=250
MAX_PATH=259

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
crate_dir="$repo_root/desktop/src-tauri"

target_dir="$(bash "$repo_root/scripts/cargo-target-dir.sh" "$crate_dir")" || exit 1

# Windows-style length is what cl.exe sees.
if command -v cygpath >/dev/null 2>&1; then
  win_target="$(cygpath -w "$target_dir" 2>/dev/null || echo "$target_dir")"
else
  win_target="$target_dir"
fi

if [ $(( ${#win_target} + SUFFIX_BUDGET )) -gt "$MAX_PATH" ]; then
  echo "❌ The desktop build dir is too deep for the ggml-vulkan shader build:" >&2
  echo "   $win_target (${#win_target} chars) + ~$SUFFIX_BUDGET of CMake scratch > $MAX_PATH (MAX_PATH)." >&2
  echo "   cl.exe cannot open such paths even with LongPathsEnabled. Run make setup-dev-windows" >&2
  echo "   (it provisions a short crate-local target-dir), or set CARGO_TARGET_DIR to a short" >&2
  echo "   directory, or clone the repo under a shorter path." >&2
  exit 1
fi
echo "✅ Vulkan build path budget OK ($win_target: ${#win_target} + $SUFFIX_BUDGET ≤ $MAX_PATH)"
