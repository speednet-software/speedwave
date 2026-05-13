#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$REPO_ROOT/desktop/src-tauri}"
PACKAGES=(reminders calendar mail notes audio-capture)

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

# `swift build -c release` produces Mach-O with the `linker-signed` code-signing
# flag (0x20000). macOS taskgated treats a `linker-signed` ad-hoc signature as
# less trusted than a plain ad-hoc one and SIGKILLs the process ("Taskgated
# Invalid Signature") when another process spawns it — fatal for the
# audio-capture CLI, which links CoreAudio's hardened process-tap APIs. A
# release build (which is what scripts/sign-bundled-binaries.sh runs over later)
# strips that flag with the Developer ID re-sign; in dev builds nothing
# re-signs, so do a plain ad-hoc re-sign here. (Harmless if a real signing pass
# overwrites it afterwards.) With entitlements where one exists, so the embedded
# entitlements survive the dev-mode re-sign too.
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
  pkg_dir="$REPO_ROOT/native/macos/$pkg"
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
