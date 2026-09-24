#!/usr/bin/env bash

set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/desktop/src-tauri/vulkan-1.dll"
PIN_FILE="$(cd "$(dirname "$0")" && pwd)/install-vulkan-sdk.ps1"
SDK_BASE="${SPEEDWAVE_VULKANSDK_BASE:-/c/VulkanSDK}"

if [ -z "${VULKAN_SDK:-}" ]; then
  PIN_VERSION="$(sed -n "s/^\\\$Version = '\([0-9.]*\)'.*/\1/p" "$PIN_FILE" 2>/dev/null || true)"
  if [ -n "$PIN_VERSION" ] && [ -f "$SDK_BASE/$PIN_VERSION/runtime/x64/vulkan-1.dll" ]; then
    VULKAN_SDK="$SDK_BASE/$PIN_VERSION"
  else
    for d in "$SDK_BASE"/*/; do
      [ -f "${d}runtime/x64/vulkan-1.dll" ] && VULKAN_SDK="$d"
    done
  fi
fi

SRC="${VULKAN_SDK:-}/runtime/x64/vulkan-1.dll"
SRC="${SRC//\\//}"
if [ ! -f "$SRC" ]; then
  echo "❌ Vulkan runtime loader not found (looked at: $SRC)." >&2
  echo "   Run scripts/install-vulkan-sdk.ps1 first (or make setup-dev-windows)." >&2
  exit 1
fi

EXPECTED="$(sed -n "s/^\\\$RuntimeDllSha256 = '\([0-9a-fA-F]\{64\}\)'.*/\1/p" "$PIN_FILE" | tr '[:upper:]' '[:lower:]')"
if [ -z "$EXPECTED" ]; then
  echo "❌ Could not read \$RuntimeDllSha256 from $PIN_FILE." >&2
  exit 1
fi
ACTUAL="$( (sha256sum "$SRC" 2>/dev/null || shasum -a 256 "$SRC") | cut -d' ' -f1)"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "❌ vulkan-1.dll SHA256 mismatch at $SRC: got $ACTUAL, expected $EXPECTED." >&2
  echo "   Re-run scripts/install-vulkan-sdk.ps1, then open a new shell so VULKAN_SDK points at the pinned SDK." >&2
  exit 1
fi

cp -f "$SRC" "$DEST"
echo "✅ Staged $(basename "$DEST") from $SRC (SHA256 verified)"
