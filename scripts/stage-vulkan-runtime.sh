#!/usr/bin/env bash
# stage-vulkan-runtime.sh — copies the redistributable Vulkan loader from the installed SDK
# into desktop/src-tauri/ for bundling (ADR-085). Windows staging only; fails loud when the
# SDK (scripts/install-vulkan-sdk.ps1) is missing, because the shipped exe imports the DLL.

set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/desktop/src-tauri/vulkan-1.dll"

if [ -z "${VULKAN_SDK:-}" ]; then
  # The installer persists VULKAN_SDK machine-wide; a fresh shell may predate it.
  for d in /c/VulkanSDK/*/; do
    [ -f "${d}runtime/x64/vulkan-1.dll" ] && VULKAN_SDK="$d"
  done
fi

SRC="${VULKAN_SDK:-}/runtime/x64/vulkan-1.dll"
SRC="${SRC//\\//}"
if [ ! -f "$SRC" ]; then
  echo "❌ Vulkan runtime loader not found (looked at: $SRC)." >&2
  echo "   Run scripts/install-vulkan-sdk.ps1 first (or make setup-dev-windows)." >&2
  exit 1
fi

cp -f "$SRC" "$DEST"
echo "✅ Staged $(basename "$DEST") from $SRC"
