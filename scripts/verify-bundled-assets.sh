#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/verify-bundled-assets.sh <macos|windows> [resources-root]
EOF
}

fail() {
  echo "$1" >&2
  exit 1
}

require_file() {
  local path="$1"
  [[ -f "$path" ]] || fail "Missing bundled file: $path"
  [[ -s "$path" ]] || fail "Bundled file is empty: $path"
}

require_exec() {
  local path="$1"
  require_file "$path"
  [[ -x "$path" ]] || fail "Bundled executable is not executable: $path"
}

require_non_empty_dir() {
  local path="$1"
  [[ -d "$path" ]] || fail "Missing bundled directory: $path"
  find "$path" -mindepth 1 -print -quit | grep -q . || fail "Bundled directory is empty: $path"
}

# The bundled Vulkan loader is a signed, load-time import — presence is not enough; it must
# match the pin in install-vulkan-sdk.ps1 (the SSOT for the SDK artifact hashes).
require_pinned_vulkan_dll() {
  local path="$1"
  require_file "$path"
  local pin_file expected actual
  pin_file="$(cd "$(dirname "$0")" && pwd)/install-vulkan-sdk.ps1"
  # Case-insensitive scrape + lowercase normalization: Get-FileHash emits uppercase hex.
  expected="$(sed -n "s/^\\\$RuntimeDllSha256 = '\([0-9a-fA-F]\{64\}\)'.*/\1/p" "$pin_file" | tr '[:upper:]' '[:lower:]')"
  [[ -n "$expected" ]] || fail "Could not read \$RuntimeDllSha256 from $pin_file"
  # macOS has shasum, Linux/CI has sha256sum — same fallback as the Makefile download targets.
  actual="$( (sha256sum "$path" 2>/dev/null || shasum -a 256 "$path") | cut -d' ' -f1)"
  [[ "$actual" == "$expected" ]] || fail "vulkan-1.dll SHA256 mismatch: got $actual, expected $expected"
}

# Any Mach-O under the tree — including one wrapped in gzip — fails Apple
# notarization if unsigned. `file -z` inspects compressed payloads directly.
require_no_macho_under() {
  local root_dir="$1"
  local f
  while IFS= read -r f; do
    if file -z "$f" 2>/dev/null | grep -q "Mach-O"; then
      fail "Bundled Mach-O found under $root_dir (breaks notarization): $f"
    fi
  done < <(find "$root_dir" -type f)
}

platform="${1:-}"
root="${2:-$(cd "$(dirname "$0")/.." && pwd)/desktop/src-tauri}"

if [[ -z "$platform" ]]; then
  usage
  exit 1
fi

case "$platform" in
  macos | windows) ;;
  *)
    usage
    fail "Unsupported platform: $platform"
    ;;
esac

require_non_empty_dir "$root/build-context/containers"
require_non_empty_dir "$root/build-context/mcp-servers"
require_file "$root/mcp-os/os/dist/index.js"
require_non_empty_dir "$root/mcp-os/shared/dist"
require_file "$root/mcp-os/shared/package.json"
require_file "$root/mcp-os/shared/package-lock.json"
require_non_empty_dir "$root/mcp-os/shared/node_modules"
[[ -d "$root/mcp-os/os/node_modules/@speedwave/mcp-shared" ]] || fail "Missing mcp-shared dir: $root/mcp-os/os/node_modules/@speedwave/mcp-shared"
[[ ! -L "$root/mcp-os/os/node_modules/@speedwave/mcp-shared" ]] || fail "mcp-shared must be a real directory, not a symlink: $root/mcp-os/os/node_modules/@speedwave/mcp-shared"
# Third-party notices ship in every bundle (make bundle-static-licenses / the CI copy step).
require_non_empty_dir "$root/THIRD-PARTY-LICENSES"

case "$platform" in
  macos)
    require_exec "$root/lima/bin/limactl"
    require_non_empty_dir "$root/lima/share"
    require_no_macho_under "$root/lima/share"
    require_exec "$root/nodejs/bin/node"
    require_exec "$root/cli/speedwave"
    require_exec "$root/reminders-cli"
    require_exec "$root/calendar-cli"
    require_exec "$root/mail-cli"
    require_exec "$root/notes-cli"
    require_exec "$root/audio-capture-cli"
    ;;
  windows)
    require_file "$root/wsl/nerdctl-full.tar.gz"
    require_file "$root/wsl/ubuntu-rootfs.tar.gz"
    require_file "$root/nodejs/node.exe"
    require_file "$root/cli/speedwave.exe"
    require_file "$root/windows/sweep.ps1"
    require_file "$root/windows/firewall.ps1"
    require_pinned_vulkan_dll "$root/vulkan-1.dll"
    # The notice for the redistributed loader must ship next to it (ADR-085, Apache-2.0).
    require_file "$root/THIRD-PARTY-LICENSES/VulkanRT-License.txt"
    ;;
esac

echo "Bundled assets verified for $platform at $root"
