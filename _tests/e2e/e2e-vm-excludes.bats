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
