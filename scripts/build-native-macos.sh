#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGES=(reminders calendar mail notes audio-capture)
ARCHS="${SPEEDWAVE_SWIFT_ARCHS:-arm64 x86_64}"
TAURI_CONF="$REPO_ROOT/desktop/src-tauri/tauri.conf.json"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Skipping macOS native CLI build on non-macOS host"
  exit 0
fi

read -r -a ARCH_LIST <<<"$ARCHS"
BUILD_ARGS=(-c release)
for arch in "${ARCH_LIST[@]}"; do
  BUILD_ARGS+=(--arch "$arch")
done

# Read app version from tauri.conf.json (SSOT), stamp into each CLI's Info.plist.
APP_VERSION="0.0.0"
if [[ -f "$TAURI_CONF" ]]; then
  if command -v jq >/dev/null 2>&1; then
    APP_VERSION="$(jq -r '.version // "0.0.0"' "$TAURI_CONF")"
  else
    # jq not available in some minimal CI images; grep the single version line.
    APP_VERSION="$(grep -E '^\s*"version"\s*:' "$TAURI_CONF" | head -1 | sed -E 's/.*"version"\s*:\s*"([^"]+)".*/\1/')"
    [[ -z "$APP_VERSION" ]] && APP_VERSION="0.0.0"
  fi
fi
echo "Stamping native CLI Info.plist files with version $APP_VERSION"

stamp_info_plist() {
  local plist="$1"
  if [[ ! -f "$plist" ]]; then
    echo "Missing Info.plist: $plist (each CLI must have Resources/Info.plist for embedded plist)" >&2
    exit 1
  fi
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $APP_VERSION" "$plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $APP_VERSION" "$plist"
}

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

for pkg in "${PACKAGES[@]}"; do
  pkg_dir="$REPO_ROOT/native/macos/$pkg"
  binary_name="${pkg}-cli"

  stamp_info_plist "$pkg_dir/Resources/Info.plist"

  echo "Building $binary_name (${ARCH_LIST[*]})"
  (
    cd "$pkg_dir"
    swift build "${BUILD_ARGS[@]}"
  )

  binary_path="$(resolve_binary_path "$pkg_dir" "$binary_name")"
  if [[ -z "$binary_path" || ! -f "$binary_path" ]]; then
    echo "Missing built binary for $binary_name in $pkg_dir/.build" >&2
    exit 1
  fi

  chmod +x "$binary_path"

  if command -v lipo >/dev/null 2>&1 && [[ "${#ARCH_LIST[@]}" -gt 1 ]]; then
    archs_out="$(lipo -archs "$binary_path")"
    for arch in "${ARCH_LIST[@]}"; do
      if ! grep -qw "$arch" <<<"$archs_out"; then
        echo "$binary_name is missing architecture $arch: $archs_out" >&2
        exit 1
      fi
    done
  fi
done

echo "macOS native CLI binaries built successfully"
