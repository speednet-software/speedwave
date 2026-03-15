#!/bin/bash
set -euo pipefail

# Reusable Claude Code installer — SSOT for both Containerfile and entrypoint.sh.
# Uses the official native installer (bootstrap.sh) which downloads the binary
# from GCS and verifies its SHA256 against a version-pinned manifest.json.
#
# Usage: install-claude.sh <version>
#   version: a semver like "2.1.76" (required, no default)

CLAUDE_VERSION="${1:?Usage: install-claude.sh <version>}"
INSTALLER_URL="https://claude.ai/install.sh"

# Use $HOME/.cache as temp dir to avoid /tmp:noexec issues at runtime.
# At runtime the container mounts /tmp as tmpfs with noexec — the Claude installer
# downloads binaries there and tries to exec them, which fails. $HOME is a writable
# VirtioFS volume mount without noexec restrictions.
INSTALL_TMPDIR="${HOME}/.cache/speedwave-install"
mkdir -p "$INSTALL_TMPDIR"

INSTALLER_TMP=$(mktemp "$INSTALL_TMPDIR/install-claude.XXXXXX")
trap 'rm -f "$INSTALLER_TMP"' EXIT

curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 10 --max-time 30 \
    -o "$INSTALLER_TMP" "$INSTALLER_URL"

# The official installer verifies the downloaded binary's SHA256 against
# a version-pinned manifest.json from GCS. We trust this verification chain.
TMPDIR="$INSTALL_TMPDIR" bash "$INSTALLER_TMP" "$CLAUDE_VERSION"
