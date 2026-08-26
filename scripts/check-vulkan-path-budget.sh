#!/usr/bin/env bash
# check-vulkan-path-budget.sh — fails loud before the ggml-vulkan build dies on MAX_PATH:
# cl.exe cannot open paths past it even with LongPathsEnabled (a cryptic C1083, ADR-085).

set -euo pipefail

# Deepest observed MSBuild-generator TryCompile scratch below the cargo target dir
# (cmTC_*.dir\Debug\*.obj — ~214 chars measured on CI, rounded up; ninja is shallower).
SUFFIX_BUDGET=220
MAX_PATH=259

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
crate_dir="$repo_root/desktop/src-tauri"

# CARGO_TARGET_DIR wins (cargo's own precedence); otherwise ask cargo itself, which resolves
# every remaining layer (CARGO_BUILD_TARGET_DIR, crate-local/home/repo-root config.toml).
target_dir="${CARGO_TARGET_DIR:-}"
if [ -z "$target_dir" ]; then
  unset CARGO_TARGET_DIR
  metadata="$(cd "$crate_dir" && cargo metadata --format-version 1 --no-deps)" || {
    echo "❌ cargo metadata failed in $crate_dir — cannot resolve the effective target dir." >&2
    exit 1
  }
  if command -v jq >/dev/null 2>&1; then
    target_dir="$(printf '%s' "$metadata" | jq -r .target_directory)"
  else
    # No jq (bare dev shells): scrape the JSON, un-escape the doubled Windows backslashes.
    target_dir="$(printf '%s' "$metadata" | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')"
    target_dir="${target_dir//\\\\/\\}"
  fi
fi
if [ -z "$target_dir" ]; then
  echo "❌ Could not resolve the cargo target dir for $crate_dir." >&2
  exit 1
fi

# A relative CARGO_TARGET_DIR resolves against the working directory — measure the real path.
case "$target_dir" in
  /* | [A-Za-z]:* | \\\\*) ;;
  *) target_dir="$PWD/$target_dir" ;;
esac

# Windows-style length is what cl.exe sees.
if command -v cygpath >/dev/null 2>&1; then
  win_target="$(cygpath -w "$target_dir" 2>/dev/null || echo "$target_dir")"
else
  win_target="$target_dir"
fi

if [ $(( ${#win_target} + SUFFIX_BUDGET )) -gt "$MAX_PATH" ]; then
  echo "❌ The desktop build dir is too deep for the ggml-vulkan shader build:" >&2
  echo "   $win_target (${#win_target} chars) + ~$SUFFIX_BUDGET of CMake scratch > $MAX_PATH (MAX_PATH)." >&2
  echo "   cl.exe cannot open such paths even with LongPathsEnabled. Either clone the repo" >&2
  echo "   under a shorter path, or create desktop/src-tauri/.cargo/config.toml with:" >&2
  echo '     [build]' >&2
  echo '     target-dir = "C:/spwd"   # any short directory' >&2
  exit 1
fi
echo "✅ Vulkan build path budget OK ($win_target: ${#win_target} + $SUFFIX_BUDGET ≤ $MAX_PATH)"
