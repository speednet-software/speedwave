#!/bin/bash
set -euo pipefail

# Claude Code installer — SSOT for both Containerfile and entrypoint.sh.
# Usage: install-claude.sh <version>  (semver, e.g. "2.1.76"; required, no default)

CLAUDE_VERSION="${1:?Usage: install-claude.sh <version>}"
INSTALLER_URL="https://claude.ai/install.sh"

# Temp dir under $HOME avoids the runtime /tmp:noexec mount the installer cannot exec from.
INSTALL_TMPDIR="${HOME}/.cache/speedwave-install"
mkdir -p "$INSTALL_TMPDIR"

INSTALLER_TMP=$(mktemp "$INSTALL_TMPDIR/install-claude.XXXXXX")
trap 'rm -f "$INSTALLER_TMP"' EXIT

curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 10 --max-time 30 \
    -o "$INSTALLER_TMP" "$INSTALLER_URL"

# Installer verifies the binary's SHA256 against a version-pinned manifest.json.
TMPDIR="$INSTALL_TMPDIR" bash "$INSTALLER_TMP" "$CLAUDE_VERSION"
