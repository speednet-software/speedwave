#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$REPO_ROOT/desktop/src-tauri}"
PACKAGES=(reminders calendar mail notes)

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Skipping native asset bundling on non-macOS host"
  exit 0
fi

resolve_binary_path() {
  local pkg_dir="$1"
  local binary_name="$2"
  local candidates=(
    "$pkg_dir/.build/apple/Products/Release/$binary_name"
    "$pkg_dir/.build/universal-apple-macosx/release/$binary_name"
    "$pkg_dir/.build/release/$binary_name"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  find "$pkg_dir/.build" -type f \( -path "*/release/$binary_name" -o -path "*/Release/$binary_name" \) | sort | tail -n 1
}

mkdir -p "$DEST"

for pkg in "${PACKAGES[@]}"; do
  pkg_dir="$REPO_ROOT/native/macos/$pkg"
  binary_name="${pkg}-cli"
  binary_path="$(resolve_binary_path "$pkg_dir" "$binary_name")"

  if [[ -z "$binary_path" || ! -f "$binary_path" ]]; then
    echo "Missing built macOS native asset $binary_name. Run scripts/build-native-macos.sh first." >&2
    exit 1
  fi

  cp "$binary_path" "$DEST/$binary_name"
  chmod +x "$DEST/$binary_name"
done

echo "Bundled macOS native assets into $DEST"
