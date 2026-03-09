#!/bin/bash
set -euo pipefail

# Reusable Claude Code installer with SHA256 verification.
# Used by both Containerfile.claude (build time) and entrypoint.sh (runtime fallback).
#
# Usage: install-claude.sh [version]
#   version: "latest", "stable", or a semver (default: "latest")
#
# Environment:
#   CLAUDE_INSTALLER_SHA256 — expected SHA256 of install.sh (empty = skip verification with warning)

CLAUDE_VERSION="${1:-latest}"
CLAUDE_INSTALLER_SHA256="${CLAUDE_INSTALLER_SHA256:-}"
INSTALLER_URL="https://claude.ai/install.sh"

# Use $HOME/.cache as temp dir to avoid /tmp:noexec issues at runtime.
# At runtime the container mounts /tmp as tmpfs with noexec — the Claude installer
# downloads binaries there and tries to exec them, which fails. $HOME is a writable
# VirtioFS volume mount without noexec restrictions.
INSTALL_TMPDIR="${HOME}/.cache/speedwave-install"
mkdir -p "$INSTALL_TMPDIR"

# Download installer to a temp file — never pipe directly to bash
INSTALLER_TMP=$(mktemp "$INSTALL_TMPDIR/install-claude.XXXXXX")
trap 'rm -f "$INSTALLER_TMP"' EXIT

curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 10 --max-time 30 -o "$INSTALLER_TMP" "$INSTALLER_URL"

# Portable SHA256: sha256sum (Linux/coreutils) or shasum (macOS)
compute_sha256() {
    if command -v sha256sum &>/dev/null; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        echo "FATAL: no sha256sum or shasum found" >&2
        exit 1
    fi
}

# Verify checksum if provided
if [ -n "$CLAUDE_INSTALLER_SHA256" ]; then
    ACTUAL_SHA256=$(compute_sha256 "$INSTALLER_TMP")
    if [ "$ACTUAL_SHA256" != "$CLAUDE_INSTALLER_SHA256" ]; then
        echo "SECURITY: installer checksum mismatch!" >&2
        echo "  expected: $CLAUDE_INSTALLER_SHA256" >&2
        echo "  actual:   $ACTUAL_SHA256" >&2
        exit 1
    fi
    echo "Installer checksum verified: $ACTUAL_SHA256" >&2
else
    echo "WARNING: CLAUDE_INSTALLER_SHA256 not set — skipping installer verification" >&2
fi

# Run installer with TMPDIR pointing to a non-noexec location so the Claude
# installer can download and exec binaries without hitting noexec restrictions.
TMPDIR="$INSTALL_TMPDIR" bash "$INSTALLER_TMP" "$CLAUDE_VERSION"
