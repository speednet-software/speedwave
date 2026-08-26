#!/usr/bin/env bash
# stage-vulkan-runtime.sh — copies the redistributable Vulkan loader from the installed SDK
# into desktop/src-tauri/ for bundling (ADR-085). Windows staging only; fails loud when the
# SDK (scripts/install-vulkan-sdk.ps1) is missing, because the shipped exe imports the DLL.

set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/desktop/src-tauri/vulkan-1.dll"
PIN_FILE="$(cd "$(dirname "$0")" && pwd)/install-vulkan-sdk.ps1"

if [ -z "${VULKAN_SDK:-}" ]; then
  # The installer persists VULKAN_SDK machine-wide; a fresh shell may predate it. Prefer the
  # pinned SDK version — the glob sorts lexicographically, so e.g. 1.4.99.0 beats 1.4.357.0.
  PIN_VERSION="$(sed -n "s/^\\\$Version = '\([0-9.]*\)'.*/\1/p" "$PIN_FILE" 2>/dev/null || true)"
  if [ -n "$PIN_VERSION" ] && [ -f "/c/VulkanSDK/$PIN_VERSION/runtime/x64/vulkan-1.dll" ]; then
    VULKAN_SDK="/c/VulkanSDK/$PIN_VERSION"
  else
    for d in /c/VulkanSDK/*/; do
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

# The staged DLL gets signed and shipped with a load-time import — verify it against the pin
# in install-vulkan-sdk.ps1 (the SSOT), not just its presence on disk.
# Case-insensitive scrape + lowercase normalization: Get-FileHash emits uppercase hex.
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
