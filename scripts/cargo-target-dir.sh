#!/usr/bin/env bash
# Prints the effective cargo target dir for a crate dir, resolving every layer cargo does:
# CARGO_TARGET_DIR wins, then the crate-local/home/repo-root config.toml `[build] target-dir`.

set -euo pipefail

crate_dir="${1:?usage: $0 <crate-dir>}"

target_dir="${CARGO_TARGET_DIR:-}"
if [ -z "$target_dir" ]; then
  if command -v cargo >/dev/null 2>&1; then
    unset CARGO_TARGET_DIR
    metadata="$(cd "$crate_dir" && cargo metadata --format-version 1 --no-deps)" || {
      echo "cargo metadata failed in $crate_dir -- cannot resolve the effective target dir." >&2
      exit 1
    }
    if command -v jq >/dev/null 2>&1; then
      target_dir="$(printf '%s' "$metadata" | jq -r .target_directory)"
    else
      # No jq (bare dev shells): scrape the JSON, un-escape the doubled Windows backslashes.
      target_dir="$(printf '%s' "$metadata" | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')"
      target_dir="${target_dir//\\\\/\\}"
    fi
  else
    # No cargo on PATH (bare shells): assume the default crate-local target dir.
    target_dir="$crate_dir/target"
  fi
fi

if [ -z "$target_dir" ]; then
  echo "Could not resolve the cargo target dir for $crate_dir." >&2
  exit 1
fi

# A relative target-dir resolves against cargo's working directory — the crate dir.
case "$target_dir" in
  /* | [A-Za-z]:* | \\\\*) ;;
  *) target_dir="$crate_dir/$target_dir" ;;
esac

printf '%s\n' "$target_dir"
