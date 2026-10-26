#!/bin/bash
set -euo pipefail


CLAUDE_VERSION="${1:?Usage: install-claude.sh <version>}"
INSTALLER_URL="https://claude.ai/install.sh"
INSTALL_ATTEMPTS=4
INSTALL_RETRY_DELAY_SECS=30

INSTALL_TMPDIR="${HOME}/.cache/speedwave-install"
mkdir -p "$INSTALL_TMPDIR"

INSTALLER_TMP=$(mktemp "$INSTALL_TMPDIR/install-claude.XXXXXX")
trap 'rm -f "$INSTALLER_TMP"' EXIT

install_once() {
    curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 10 --max-time 30 \
        -o "$INSTALLER_TMP" "$INSTALLER_URL" &&
        TMPDIR="$INSTALL_TMPDIR" bash "$INSTALLER_TMP" "$CLAUDE_VERSION"
}

attempt=1
until install_once; do
    status=$?
    if [ "$attempt" -ge "$INSTALL_ATTEMPTS" ]; then
        echo "Claude Code install failed after $INSTALL_ATTEMPTS attempts" >&2
        exit "$status"
    fi
    echo "Claude Code install attempt $attempt of $INSTALL_ATTEMPTS failed (exit $status), retrying in ${INSTALL_RETRY_DELAY_SECS}s" >&2
    sleep "$INSTALL_RETRY_DELAY_SECS"
    attempt=$((attempt + 1))
done
