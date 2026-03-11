#!/usr/bin/env bash
# e2e-common.sh — Shared configuration for E2E testing scripts.
# Sourced by e2e-vm.sh and e2e-vm-setup.sh.

# -- SSH Targets ---------------------------------------------------------------
# Override via environment variables for different test machines.

LINUX_HOST="${SPEEDWAVE_LINUX_HOST:-limes@100.90.218.98}"
WINDOWS_HOST="${SPEEDWAVE_WINDOWS_HOST:-jakub@100.82.138.67}"
WINDOWS_SSH_PORT="${SPEEDWAVE_WINDOWS_SSH_PORT:-22}"
MACOS_HOST="${SPEEDWAVE_MACOS_HOST:-limes@100.104.82.7}"

# -- SSH Options ---------------------------------------------------------------
# Base options shared by all scripts. e2e-vm.sh appends keepalive options for
# long-running test sessions.

SSH_OPTS_BASE="-o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

# e2e-vm.sh overrides these with keepalive options; e2e-vm-setup.sh uses base.
LINUX_SSH_OPTS="${LINUX_SSH_OPTS:-$SSH_OPTS_BASE}"
WINDOWS_SSH_OPTS="${WINDOWS_SSH_OPTS:-$SSH_OPTS_BASE -p $WINDOWS_SSH_PORT}"
MACOS_SSH_OPTS="${MACOS_SSH_OPTS:-$SSH_OPTS_BASE}"

# WSL2 distro name for Windows E2E
WINDOWS_WSL_DISTRO="${SPEEDWAVE_WINDOWS_WSL_DISTRO:-Ubuntu-22.04}"

# -- SSH Helper Functions ------------------------------------------------------

# Run a command on the Linux machine via SSH.
linux_ssh() {
    # shellcheck disable=SC2086
    ssh $LINUX_SSH_OPTS "$LINUX_HOST" "$@"
}

# Run a command on the Windows machine via SSH (cmd.exe shell).
windows_ssh() {
    # shellcheck disable=SC2086
    ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" "$@"
}

# Run a command on the macOS machine via SSH.
macos_ssh() {
    # shellcheck disable=SC2086
    ssh $MACOS_SSH_OPTS "$MACOS_HOST" "$@"
}
