#!/usr/bin/env bash

# shellcheck disable=SC1091
[[ -f "${BASH_SOURCE[0]%/*}/../.env" ]] && source "${BASH_SOURCE[0]%/*}/../.env"


WINDOWS_HOST="${SPEEDWAVE_WINDOWS_HOST:-}"
WINDOWS_SSH_PORT="${SPEEDWAVE_WINDOWS_SSH_PORT:-22}"
MACOS_HOST="${SPEEDWAVE_MACOS_HOST:-}"


SSH_OPTS_BASE="-o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

WINDOWS_SSH_OPTS="${WINDOWS_SSH_OPTS:-$SSH_OPTS_BASE -p $WINDOWS_SSH_PORT}"
MACOS_SSH_OPTS="${MACOS_SSH_OPTS:-$SSH_OPTS_BASE}"

WINDOWS_WSL_DISTRO="${SPEEDWAVE_WINDOWS_WSL_DISTRO:-Ubuntu-22.04}"


require_host() {
    [ -n "$2" ] || { echo "ERROR: Set $1 (e.g. user@host)" >&2; exit 1; }
}

windows_ssh() {
    # shellcheck disable=SC2086
    ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" "$@"
}

macos_ssh() {
    # shellcheck disable=SC2086
    ssh $MACOS_SSH_OPTS "$MACOS_HOST" "$@"
}
