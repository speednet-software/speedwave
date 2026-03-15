#!/usr/bin/env bash
# create-desktop-stubs.sh — Creates minimal stub files for desktop/src-tauri/
# so that build.rs validation passes with SPEEDWAVE_ALLOW_BUNDLE_STUBS=1.
#
# Used by: Makefile (check-desktop-clippy), CI (test.yml).
# Does NOT overwrite existing real files (e.g. from bundle-build-context.sh or downloads).

set -euo pipefail

DEST="${1:-$(cd "$(dirname "$0")/.." && pwd)/desktop/src-tauri}"

stub_dir() {
    [ -d "$1" ] || mkdir -p "$1"
}

stub_file() {
    [ -f "$1" ] || { mkdir -p "$(dirname "$1")"; touch "$1"; }
}

# Platform-agnostic stubs (covers all platforms for clippy)
stub_dir "$DEST/nerdctl-full/bin"
stub_dir "$DEST/nerdctl-full/lib"
stub_dir "$DEST/nerdctl-full/libexec"
stub_dir "$DEST/nerdctl-full/share"
stub_dir "$DEST/build-context/containers/claude-resources"
stub_dir "$DEST/build-context/mcp-servers"
stub_dir "$DEST/mcp-os/os/dist"
stub_dir "$DEST/mcp-os/shared/dist"
stub_dir "$DEST/mcp-os/shared/node_modules"
stub_dir "$DEST/mcp-os/os/node_modules/@speedwave/mcp-shared"
stub_dir "$DEST/nodejs/bin"
stub_dir "$DEST/cli"
stub_dir "$DEST/lima/bin"
stub_dir "$DEST/lima/share"
stub_dir "$DEST/wsl"
stub_dir "$DEST/THIRD-PARTY-LICENSES"
stub_file "$DEST/build-context/containers/Containerfile.claude"
stub_file "$DEST/build-context/mcp-servers/tsconfig.base.json"
stub_file "$DEST/mcp-os/os/dist/index.js"
stub_file "$DEST/mcp-os/shared/package.json"
stub_file "$DEST/mcp-os/shared/package-lock.json"
stub_file "$DEST/nodejs/bin/node"
stub_file "$DEST/nodejs/node.exe"
stub_file "$DEST/cli/speedwave"
stub_file "$DEST/cli/speedwave.exe"
stub_file "$DEST/lima/bin/limactl"
stub_file "$DEST/wsl/nerdctl-full.tar.gz"
stub_file "$DEST/wsl/ubuntu-rootfs.tar.gz"
stub_file "$DEST/reminders-cli"
stub_file "$DEST/calendar-cli"
stub_file "$DEST/mail-cli"
stub_file "$DEST/notes-cli"
