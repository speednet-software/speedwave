#!/usr/bin/env bats

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/e2e-vm.sh"

@test "ps_squote doubles single quotes for PowerShell literals" {
    eval "$(sed -n '/^ps_squote()/,/^}/p' "$SCRIPT")"
    [ "$(ps_squote "plain")" = "plain" ]
    [ "$(ps_squote "")" = "" ]
    [ "$(ps_squote "o'brien")" = "o''brien" ]
    [ "$(ps_squote "a'b'c")" = "a''b''c" ]
    [ "$(ps_squote "'; calc; '")" = "''; calc; ''" ]
}

COMMON="$BATS_TEST_DIRNAME/../../scripts/e2e-common.sh"

_stub() {
    local name="$1" body="$2"
    mkdir -p "$BATS_TEST_TMPDIR/bin"
    printf '#!/usr/bin/env bash\n%s\n' "$body" >"$BATS_TEST_TMPDIR/bin/$name"
    chmod +x "$BATS_TEST_TMPDIR/bin/$name"
}

_load_rsync_to() {
    eval "$(sed -n '/^tar_is_bsdtar()/,/^}/p;/^windows_rsync_to()/,/^}/p' "$SCRIPT")"
    E2E_RSYNC_EXCLUDES=(node_modules target)
    WINDOWS_SSH_OPTS=""
    WINDOWS_SSH_PORT=22
    WINDOWS_HOST="runner@127.0.0.1"
    WINDOWS_WSL_DISTRO="Ubuntu-22.04"
    _stub ssh 'exit 0'
    _stub scp 'exit 0'
    mkdir -p "$BATS_TEST_TMPDIR/src/repo"
    PATH="$BATS_TEST_TMPDIR/bin:$PATH"
}

@test "tar_is_bsdtar recognises bsdtar and rejects GNU tar" {
    eval "$(sed -n '/^tar_is_bsdtar()/,/^}/p' "$SCRIPT")"
    PATH="$BATS_TEST_TMPDIR/bin:$PATH"
    _stub tar 'echo "bsdtar 3.5.3 - libarchive 3.7.2 zlib/1.2.12"'
    tar_is_bsdtar
    _stub tar 'echo "tar (GNU tar) 1.35"'
    ! tar_is_bsdtar
    _stub tar 'exit 2'
    ! tar_is_bsdtar
}

@test "windows_rsync_to drops --no-mac-metadata under GNU tar" {
    _load_rsync_to
    _stub tar 'if [ "$1" = "--version" ]; then echo "tar (GNU tar) 1.35"; else printf "%s\n" "$@" >"$BATS_TEST_TMPDIR/tar-args"; fi'
    run windows_rsync_to "$BATS_TEST_TMPDIR/src/repo/" /home/windows/speedwave-e2e/
    [ "$status" -eq 0 ]
    run cat "$BATS_TEST_TMPDIR/tar-args"
    [ "${lines[0]}" = "-cf" ]
    ! grep -qx -- '--no-mac-metadata' "$BATS_TEST_TMPDIR/tar-args"
    grep -qx -- '--exclude=node_modules' "$BATS_TEST_TMPDIR/tar-args"
    grep -qx -- '--exclude=._\*' "$BATS_TEST_TMPDIR/tar-args"
}

@test "windows_rsync_to keeps --no-mac-metadata under bsdtar" {
    _load_rsync_to
    _stub tar 'if [ "$1" = "--version" ]; then echo "bsdtar 3.5.3 - libarchive 3.7.2"; else printf "%s\n" "$@" >"$BATS_TEST_TMPDIR/tar-args"; fi'
    run windows_rsync_to "$BATS_TEST_TMPDIR/src/repo/" /home/windows/speedwave-e2e/
    [ "$status" -eq 0 ]
    run cat "$BATS_TEST_TMPDIR/tar-args"
    [ "${lines[0]}" = "--no-mac-metadata" ]
    [ "${lines[1]}" = "-cf" ]
}

@test "e2e-common.sh loads with only one platform host set" {
    run env -u SPEEDWAVE_WINDOWS_HOST SPEEDWAVE_MACOS_HOST=runner@127.0.0.1 \
        bash -c 'source "$1" && printf "%s|%s\n" "$MACOS_HOST" "$WINDOWS_HOST"' _ "$COMMON"
    [ "$status" -eq 0 ]
    [ "$output" = "runner@127.0.0.1|" ]
}

@test "require_host fails naming the variable when the host is empty" {
    eval "$(sed -n '/^require_host()/,/^}/p' "$COMMON")"
    run require_host SPEEDWAVE_WINDOWS_HOST ""
    [ "$status" -eq 1 ]
    [ "$output" = "ERROR: Set SPEEDWAVE_WINDOWS_HOST (e.g. user@host)" ]
    run require_host SPEEDWAVE_WINDOWS_HOST "runner@127.0.0.1"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "windows_wait_ssh stops before ssh when the Windows host is unset" {
    eval "$(sed -n '/^require_host()/,/^}/p' "$COMMON")"
    eval "$(sed -n '/^windows_wait_ssh()/,/^}/p' "$SCRIPT")"
    _stub ssh 'touch "$BATS_TEST_TMPDIR/ssh-called"'
    PATH="$BATS_TEST_TMPDIR/bin:$PATH"
    WINDOWS_HOST=""
    WINDOWS_SSH_PORT=22
    run windows_wait_ssh
    [ "$status" -eq 1 ]
    [[ "$output" == *"Set SPEEDWAVE_WINDOWS_HOST"* ]]
    [ ! -e "$BATS_TEST_TMPDIR/ssh-called" ]
}

SETUP="$BATS_TEST_DIRNAME/../../scripts/e2e-vm-setup.sh"

_load_ensure_provisioned_windows() {
    eval "$(sed -n '/^ensure_provisioned_windows()/,/^}/p' "$SCRIPT")"
    WINDOWS_SSH_OPTS=""
    WINDOWS_HOST="runner@127.0.0.1"
    WINDOWS_WSL_DISTRO="Ubuntu-22.04"
    SCRIPT_DIR="$BATS_TEST_TMPDIR/scripts"
    mkdir -p "$SCRIPT_DIR"
    printf '#!/usr/bin/env bash\ntouch "%s/setup-called"\n' "$BATS_TEST_TMPDIR" >"$SCRIPT_DIR/e2e-vm-setup.sh"
    chmod +x "$SCRIPT_DIR/e2e-vm-setup.sh"
    _stub ssh 'exit 0'
    PATH="$BATS_TEST_TMPDIR/bin:$PATH"
    windows_ps() { cat >/dev/null; return 1; }
}

@test "ensure_provisioned_windows fails without running setup in CI" {
    _load_ensure_provisioned_windows
    CI=true run ensure_provisioned_windows
    [ "$status" -eq 1 ]
    [[ "$output" == *"an administrator runs scripts/e2e-vm-setup.sh windows"* ]]
    [ ! -e "$BATS_TEST_TMPDIR/setup-called" ]
}

@test "ensure_provisioned_windows runs setup outside CI" {
    _load_ensure_provisioned_windows
    CI= run ensure_provisioned_windows
    [ "$status" -eq 0 ]
    [ -e "$BATS_TEST_TMPDIR/setup-called" ]
}

@test "ensure_provisioned_windows skips setup in CI when the toolchain is complete" {
    _load_ensure_provisioned_windows
    windows_ps() { cat >/dev/null; return 0; }
    CI=true run ensure_provisioned_windows
    [ "$status" -eq 0 ]
    [[ "$output" == *"Provisioning: OK"* ]]
    [ ! -e "$BATS_TEST_TMPDIR/setup-called" ]
}

@test "ensure_provisioned_windows fails before setup while Smart App Control is on" {
    _load_ensure_provisioned_windows
    windows_ps() { if grep -q SmartAppControlState; then printf 'sac=On\r\njunction=True\r\n'; fi; }
    CI= run ensure_provisioned_windows
    [ "$status" -eq 1 ]
    [[ "$output" == *"Smart App Control is on"* ]]
    [ ! -e "$BATS_TEST_TMPDIR/setup-called" ]
}

@test "ensure_provisioned_windows fails before setup when SSH sessions cannot follow junctions" {
    _load_ensure_provisioned_windows
    windows_ps() { if grep -q SmartAppControlState; then printf 'sac=Off\r\njunction=False\r\n'; fi; }
    CI= run ensure_provisioned_windows
    [ "$status" -eq 1 ]
    [[ "$output" == *"RedirectionGuard on sshd.exe"* ]]
    [ ! -e "$BATS_TEST_TMPDIR/setup-called" ]
}

_load_ensure_provisioned_macos() {
    eval "$(sed -n '/^ensure_provisioned_macos()/,/^}/p' "$SCRIPT")"
    SCRIPT_DIR="$BATS_TEST_TMPDIR/scripts"
    mkdir -p "$SCRIPT_DIR"
    printf 'touch "%s/setup-called"\n' "$BATS_TEST_TMPDIR" >"$SCRIPT_DIR/e2e-vm-setup.sh"
    macos_ssh() { return 1; }
}

@test "ensure_provisioned_macos fails without running setup in CI" {
    _load_ensure_provisioned_macos
    CI=true run ensure_provisioned_macos
    [ "$status" -eq 1 ]
    [[ "$output" == *"an administrator runs scripts/e2e-vm-setup.sh macos"* ]]
    [ ! -e "$BATS_TEST_TMPDIR/setup-called" ]
}

@test "ensure_provisioned_macos runs a non-executable setup script outside CI" {
    _load_ensure_provisioned_macos
    CI= run ensure_provisioned_macos
    [ "$status" -eq 0 ]
    [ -e "$BATS_TEST_TMPDIR/setup-called" ]
}

_run_installer() {
    command -v pwsh >/dev/null || skip "pwsh not installed"
    eval "$(sed -n "/^SETUP_PS_PRELUDE='/,/^}'\$/p" "$SETUP")"
    printf '%s\nfunction Start-Process { param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru) "$FilePath|$($ArgumentList -join ",")" | Set-Content "%s/started"; [pscustomobject]@{ ExitCode = %s } }\n$ErrorActionPreference = "Stop"\nInvoke-Installer msiexec "/i","cmake.msi","/qn"\nWrite-Output "after"\n' \
        "$SETUP_PS_PRELUDE" "$BATS_TEST_TMPDIR" "$1" >"$BATS_TEST_TMPDIR/run.ps1"
    run pwsh -NoProfile -File "$BATS_TEST_TMPDIR/run.ps1"
}

@test "Invoke-Installer stops the script with the installer's exit code" {
    _run_installer 87
    [ "$status" -eq 87 ]
    [[ "$output" == *"msiexec /i cmake.msi /qn exited with 87"* ]]
    [[ "$output" != *"after"* ]]
}

@test "Invoke-Installer continues on success and on reboot-required" {
    _run_installer 0
    [ "$status" -eq 0 ]
    [ "$output" = "after" ]
    [ "$(cat "$BATS_TEST_TMPDIR/started")" = "msiexec|/i,cmake.msi,/qn" ]
    _run_installer 3010
    [ "$status" -eq 0 ]
    [ "$output" = "after" ]
}

_load_rig_lock() {
    eval "$(sed -n '/^RIG_LOCK_STALE_MINUTES=/p;/^RIG_LOCK_POLL_SECONDS=/p;/^RIG_LOCK_WAIT_SECONDS=/p;/^with_rig_lock()/,/^}/p;/^rig_lock_try_script()/,/^}/p' "$SCRIPT")"
    RIG_LOCK_POLL_SECONDS=0
    LOCK="$BATS_TEST_TMPDIR/rig.lock"
}

_record_run() {
    echo ran >>"$BATS_TEST_TMPDIR/runs"
    return "${1:-0}"
}

@test "with_rig_lock runs the command under the lock and releases it" {
    _load_rig_lock
    run with_rig_lock bash "$LOCK" bash -c '[ -d "$0" ] && echo held' "$LOCK"
    [ "$status" -eq 0 ]
    [ "$output" = "held" ]
    [ ! -e "$LOCK" ]
}

@test "with_rig_lock returns the command's exit code and still releases the lock" {
    _load_rig_lock
    run with_rig_lock bash "$LOCK" _record_run 7
    [ "$status" -eq 7 ]
    [ "$(cat "$BATS_TEST_TMPDIR/runs")" = "ran" ]
    [ ! -e "$LOCK" ]
}

@test "with_rig_lock gives up on a fresh lock held by another run without running the command" {
    _load_rig_lock
    RIG_LOCK_WAIT_SECONDS=0
    mkdir "$LOCK"
    run with_rig_lock bash "$LOCK" _record_run
    [ "$status" -eq 1 ]
    [[ "$output" == *"still held"* ]]
    [ ! -e "$BATS_TEST_TMPDIR/runs" ]
    [ -d "$LOCK" ]
}

@test "with_rig_lock takes over a lock older than the stale limit" {
    _load_rig_lock
    mkdir "$LOCK"
    touch -t 202001010000 "$LOCK"
    run with_rig_lock bash "$LOCK" _record_run
    [ "$status" -eq 0 ]
    [ "$(cat "$BATS_TEST_TMPDIR/runs")" = "ran" ]
    [ ! -e "$LOCK" ]
}

@test "with_rig_lock fails at once when the rig cannot be reached" {
    _load_rig_lock
    _unreachable() { cat >/dev/null; return 255; }
    run with_rig_lock _unreachable "$LOCK" _record_run
    [ "$status" -eq 255 ]
    [[ "$output" == *"could not reach the rig"* ]]
    [ ! -e "$BATS_TEST_TMPDIR/runs" ]
}
