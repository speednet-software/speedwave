#!/usr/bin/env bats

GIT_TRANSPORT="$BATS_TEST_DIRNAME/../../containers/git-transport.sh"

setup() {
    TMP_HOME=$(mktemp -d)
    CONF="$TMP_HOME/.config/speedwave/git-transport.gitconfig"
    export GIT_CONFIG_NOSYSTEM=1
    export GIT_CONFIG_GLOBAL="$TMP_HOME/.gitconfig"
    PROXY="http://proxy:4000/git"
    AUTH="tok-secret-123"
}

teardown() {
    rm -rf "$TMP_HOME"
}

run_transport() {
    HOME="$TMP_HOME" SPEEDWAVE_GIT_HOSTS="$1" SPEEDWAVE_GIT_PROXY_URL="${2-$PROXY}" \
        SPEEDWAVE_GIT_PROXY_AUTH="${3-$AUTH}" bash "$GIT_TRANSPORT"
}

@test "scp-style remote is rewritten to the proxy" {
    run run_transport "github.com"
    [ "$status" -eq 0 ]
    run env HOME="$TMP_HOME" git ls-remote --get-url git@github.com:o/r.git
    [ "$output" = "http://proxy:4000/git/github.com/o/r.git" ]
}

@test "https remote is rewritten to the proxy" {
    run run_transport "github.com"
    run env HOME="$TMP_HOME" git ls-remote --get-url https://github.com/o/r.git
    [ "$output" = "http://proxy:4000/git/github.com/o/r.git" ]
}

@test "multiple hosts each get their own prefix" {
    run run_transport "github.com,gitlab.example.com:8443"
    run env HOME="$TMP_HOME" git ls-remote --get-url git@gitlab.example.com:g/r.git
    [ "$output" = "http://proxy:4000/git/gitlab.example.com:8443/g/r.git" ]
    run env HOME="$TMP_HOME" git ls-remote --get-url https://gitlab.example.com:8443/g/r.git
    [ "$output" = "http://proxy:4000/git/gitlab.example.com:8443/g/r.git" ]
    run env HOME="$TMP_HOME" git ls-remote --get-url git@github.com:o/r.git
    [ "$output" = "http://proxy:4000/git/github.com/o/r.git" ]
}

@test "auth header is set for the proxy url" {
    run run_transport "github.com"
    run env HOME="$TMP_HOME" git config --get-urlmatch http.extraHeader "http://proxy:4000/git/github.com/o/r.git"
    [ "$status" -eq 0 ]
    [ "$output" = "x-speedwave-proxy-auth: $AUTH" ]
}

@test "generated file has mode 600" {
    run run_transport "github.com"
    [ "$(stat -c %a "$CONF")" = "600" ]
}

@test "include is added once after two runs" {
    run run_transport "github.com"
    run run_transport "github.com"
    [ "$status" -eq 0 ]
    run env HOME="$TMP_HOME" git config --global --get-all include.path
    [ "$(printf '%s\n' "$output" | wc -l)" -eq 1 ]
    [ "$output" = "$CONF" ] || [ "$output" = "~/.config/speedwave/git-transport.gitconfig" ]
}

@test "existing gitconfig settings are preserved" {
    printf '[user]\n\tname = Keep Me\n[alias]\n\tco = checkout\n' > "$TMP_HOME/.gitconfig"
    run run_transport "github.com"
    run env HOME="$TMP_HOME" git config --global user.name
    [ "$output" = "Keep Me" ]
    run env HOME="$TMP_HOME" git config --global alias.co
    [ "$output" = "checkout" ]
}

@test "invalid hosts are skipped, valid ones kept" {
    run run_transport 'bad/host,ev il.com,github.com,x.com:abc,$(touch pwned).com'
    [ "$status" -eq 0 ]
    run env HOME="$TMP_HOME" git ls-remote --get-url git@github.com:o/r.git
    [ "$output" = "http://proxy:4000/git/github.com/o/r.git" ]
    run env HOME="$TMP_HOME" git config --global --includes --get-regexp '^url\..*\.insteadof$'
    [ "${#lines[@]}" -eq 2 ]
    [ ! -e pwned.com ]
}

@test "empty proxy url or auth writes nothing" {
    run run_transport "github.com" "" "$AUTH"
    [ "$status" -eq 0 ]
    [ ! -e "$CONF" ]
    run run_transport "github.com" "$PROXY" ""
    [ "$status" -eq 0 ]
    [ ! -e "$CONF" ]
}

@test "hosts unset removes the generated file" {
    run run_transport "github.com"
    [ -f "$CONF" ]
    run run_transport ""
    [ "$status" -eq 0 ]
    [ ! -e "$CONF" ]
    run env HOME="$TMP_HOME" git ls-remote --get-url git@github.com:o/r.git
    [ "$output" = "git@github.com:o/r.git" ]
}

@test "hosts unset with no prior state succeeds" {
    run run_transport ""
    [ "$status" -eq 0 ]
}

@test "unwritable config dir warns and exits 0" {
    mkdir -p "$TMP_HOME/.config"
    chmod 500 "$TMP_HOME/.config"
    [ "$(id -u)" -ne 0 ] || skip "root ignores directory modes"
    run run_transport "github.com"
    chmod 700 "$TMP_HOME/.config"
    [ "$status" -eq 0 ]
}
