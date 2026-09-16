#!/bin/bash
set -euo pipefail


CLAUDE_VERSION="${1:?Usage: install-claude.sh <version>}"
INSTALLER_URL="https://claude.ai/install.sh"

INSTALL_TMPDIR="${HOME}/.cache/speedwave-install"
mkdir -p "$INSTALL_TMPDIR"

INSTALLER_TMP=$(mktemp "$INSTALL_TMPDIR/install-claude.XXXXXX")
trap 'rm -f "$INSTALLER_TMP"' EXIT

curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 10 --max-time 30 \
    -o "$INSTALLER_TMP" "$INSTALLER_URL"

TMPDIR="$INSTALL_TMPDIR" bash "$INSTALLER_TMP" "$CLAUDE_VERSION"
