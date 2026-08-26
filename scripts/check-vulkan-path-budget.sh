#!/usr/bin/env bash
# check-vulkan-path-budget.sh — fails loud before the ggml-vulkan build dies on MAX_PATH.
# The whisper-rs-sys Vulkan shader build nests ~205 chars of scratch dirs below the cargo
# target dir, and cl.exe's front-end cannot open >260-char paths even with LongPathsEnabled
# (the symptom is a cryptic C1083 in a CMake TryCompile). Windows-only concern (ADR-085).

set -euo pipefail

# The deepest observed path below the target dir: the MSBuild-generator TryCompile scratch
# incl. generated files (cmTC_*.dir\Debug\*.obj — ~214 chars measured on CI; ninja is shallower).
SUFFIX_BUDGET=220
MAX_PATH=259

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
crate_dir="$repo_root/desktop/src-tauri"

# Effective target dir: CARGO_TARGET_DIR, else the crate-local .cargo/config.toml override
# (the sanctioned machine-local escape), else the default desktop/src-tauri/target.
target_dir="${CARGO_TARGET_DIR:-}"
if [ -z "$target_dir" ] && [ -f "$crate_dir/.cargo/config.toml" ]; then
  target_dir="$(sed -n 's/^target-dir *= *"\(.*\)"/\1/p' "$crate_dir/.cargo/config.toml" | head -1)"
fi
[ -n "$target_dir" ] || target_dir="$crate_dir/target"

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
