#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/verify-bundled-assets.sh <macos|linux|windows> [resources-root]
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

platform="${1:-}"
root="${2:-$(cd "$(dirname "$0")/.." && pwd)/desktop/src-tauri}"

if [[ -z "$platform" ]]; then
  usage
  exit 1
fi

case "$platform" in
  macos | linux | windows) ;;
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

case "$platform" in
  macos)
    require_exec "$root/lima/bin/limactl"
    require_non_empty_dir "$root/lima/share"
    require_exec "$root/nodejs/bin/node"
    require_exec "$root/cli/speedwave"
    require_exec "$root/reminders-cli"
    require_exec "$root/calendar-cli"
    require_exec "$root/mail-cli"
    require_exec "$root/notes-cli"
    ;;
  linux)
    require_non_empty_dir "$root/nerdctl-full/bin"
    require_non_empty_dir "$root/nerdctl-full/lib"
    require_non_empty_dir "$root/nerdctl-full/libexec"
    require_non_empty_dir "$root/nerdctl-full/share"
    require_exec "$root/nodejs/bin/node"
    require_exec "$root/cli/speedwave"
    ;;
  windows)
    require_file "$root/wsl/nerdctl-full.tar.gz"
    require_file "$root/wsl/ubuntu-rootfs.tar.gz"
    require_file "$root/nodejs/node.exe"
    require_file "$root/cli/speedwave.exe"
    ;;
esac

echo "Bundled assets verified for $platform at $root"
