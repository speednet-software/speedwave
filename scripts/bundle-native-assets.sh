#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$REPO_ROOT/desktop/src-tauri}"
NATIVE_ROOT="${SPEEDWAVE_NATIVE_MACOS_DIR:-$REPO_ROOT/native/macos}"
PACKAGES=(reminders calendar mail notes audio-capture)

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Skipping native asset bundling on non-macOS host"
  exit 0
fi

# Both `swift build -c release` (.build/release) and the universal release
# build (.build/apple/Products/Release) are legitimate producers — newest wins.
resolve_binary_path() {
  local pkg_dir="$1"
  local binary_name="$2"
  local newest="" candidate
  while IFS= read -r -d '' candidate; do
    if [[ -z "$newest" || "$candidate" -nt "$newest" ]]; then
      newest="$candidate"
    fi
  done < <(find "$pkg_dir/.build" -type f \( -path "*/release/$binary_name" -o -path "*/Release/$binary_name" \) -print0 2>/dev/null)
  printf '%s\n' "$newest"
}

mkdir -p "$DEST"

# Swift release builds set the `linker-signed` flag; taskgated SIGKILLs it.
adhoc_resign() {
  local path="$1" pkg="$2"
  command -v codesign >/dev/null 2>&1 || return 0
  local ent="$REPO_ROOT/desktop/src-tauri/entitlements"
  local ent_arg=()
  case "$pkg" in
    audio-capture) [[ -f "$ent/audio-capture.plist" ]] && ent_arg=(--entitlements "$ent/audio-capture.plist") ;;
    calendar)      [[ -f "$ent/calendars.plist" ]]     && ent_arg=(--entitlements "$ent/calendars.plist") ;;
    reminders)     [[ -f "$ent/reminders.plist" ]]     && ent_arg=(--entitlements "$ent/reminders.plist") ;;
    mail|notes)    [[ -f "$ent/apple-events.plist" ]]  && ent_arg=(--entitlements "$ent/apple-events.plist") ;;
  esac
  codesign --force --sign - "${ent_arg[@]}" "$path" >/dev/null 2>&1 \
    || echo "  warning: ad-hoc re-sign of $path failed (dev build) — capture may be SIGKILLed by taskgated" >&2
}

for pkg in "${PACKAGES[@]}"; do
  pkg_dir="$NATIVE_ROOT/$pkg"
  binary_name="${pkg}-cli"
  binary_path="$(resolve_binary_path "$pkg_dir" "$binary_name")"

  if [[ -z "$binary_path" || ! -f "$binary_path" ]]; then
    echo "Missing built macOS native asset $binary_name. Run scripts/build-native-macos.sh first." >&2
    exit 1
  fi

  cp "$binary_path" "$DEST/$binary_name"
  chmod +x "$DEST/$binary_name"
  adhoc_resign "$DEST/$binary_name" "$pkg"
done

echo "Bundled macOS native assets into $DEST"
