#!/usr/bin/env bats

GIT_TRANSPORT="$BATS_TEST_DIRNAME/../../containers/git-transport.sh"
EXEC="$BATS_TEST_DIRNAME/../../containers/speedwave-exec.sh"
HELPER="$BATS_TEST_DIRNAME/../../containers/git-credential-speedwave.sh"

setup() {
    TMP_HOME=$(mktemp -d)
    CONF="$TMP_HOME/.config/speedwave/git-proxy.gitconfig"
    OLD_CONF="$TMP_HOME/.config/speedwave/git-transport.gitconfig"
    SECRETS_DIR="$TMP_HOME/secrets"
    mkdir -p "$SECRETS_DIR"
    export SPEEDWAVE_SECRETS_DIR="$SECRETS_DIR"
    export GIT_TERMINAL_PROMPT=0
    export GIT_CONFIG_NOSYSTEM=1
    export GIT_CONFIG_GLOBAL="$TMP_HOME/.gitconfig"
    PROXY="http://proxy:4000/git"
    URL="$PROXY/github.com/o/r.git"
    export SPEEDWAVE_GIT_HOSTS="github.com"
    export SPEEDWAVE_GIT_PROXY_URL="$PROXY"
    export SPEEDWAVE_GIT_CREDENTIAL_HELPER="$HELPER"
    unset GIT_CONFIG_COUNT
    AUTH="tok-secret-123"
    printf '%s\n' "$AUTH" > "$SECRETS_DIR/caller-token"
}

teardown() {
    rm -rf "$TMP_HOME"
}

run_transport() {
    HOME="$TMP_HOME" SPEEDWAVE_GIT_HOSTS="$1" SPEEDWAVE_GIT_PROXY_URL="${2-$PROXY}" \
        bash "$GIT_TRANSPORT"
}

# git as every process of the claude container starts it: through speedwave-exec,
# which exports the secret files and the credential helper config.
exec_git() {
    "$EXEC" HOME="$TMP_HOME" git "$@"
}

credential_fill() {
    printf 'url=%s\n\n' "$1" | exec_git credential fill
}

credential_approve() {
    printf 'url=%s\nusername=speedwave\npassword=%s\n\n' "$1" "$AUTH" | exec_git credential approve
}

assert_token_persisted_nowhere() {
    [ ! -e "$TMP_HOME/.git-credentials" ]
    [ ! -e "$TMP_HOME/.config/git/credentials" ]
    run find "$TMP_HOME" -type f -not -path "$SECRETS_DIR/*" -exec grep -lF -- "$AUTH" {} +
    [ -z "$output" ]
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

@test "credential helper hands the caller token to git for the proxy url" {
    run run_transport "github.com"
    run credential_fill "http://proxy:4000/git/github.com/o/r.git"
    [ "$status" -eq 0 ]
    [[ "$output" == *"password=$AUTH"* ]]
}

@test "credential helper follows a rotated token without rerunning the transport" {
    run run_transport "github.com"
    printf 'rotated-456' > "$SECRETS_DIR/caller-token"
    run credential_fill "http://proxy:4000/git/github.com/o/r.git"
    [[ "$output" == *"password=rotated-456"* ]]
    [[ "$output" != *"$AUTH"* ]]
}

@test "credential helper gives the token to no other url" {
    run run_transport "github.com"
    run credential_fill "http://other:4000/git/github.com/o/r.git"
    [ "$status" -ne 0 ]
    [[ "$output" != *"$AUTH"* ]]
    run credential_fill "https://github.com/o/r.git"
    [[ "$output" != *"$AUTH"* ]]
}

@test "a missing or empty token file makes git quit before any later helper" {
    unset GIT_TERMINAL_PROMPT
    later="!f(){ echo password=LATER; }; f"
    rm "$SECRETS_DIR/caller-token"
    run credential_fill_with_later_helper "$later"
    [ "$status" -ne 0 ]
    [[ "$output" != *"LATER"* ]]
    [[ "$output" == *"told us to quit"* ]]
    [[ "$output" == *"caller-token is missing or empty"* ]]
    : > "$SECRETS_DIR/caller-token"
    run credential_fill_with_later_helper "$later"
    [ "$status" -ne 0 ]
    [[ "$output" != *"LATER"* ]]
    [[ "$output" == *"told us to quit"* ]]
}

credential_fill_with_later_helper() {
    printf 'url=%s\n\n' "$URL" | exec_git -c credential.helper="$1" credential fill 2>&1
}

@test "a credential.helper=store set in the global config after the transport ran does not persist the token" {
    run run_transport "github.com"
    [ "$status" -eq 0 ]
    git config --file "$TMP_HOME/.gitconfig" credential.helper store
    run credential_fill "$URL"
    [ "$status" -eq 0 ]
    [[ "$output" == *"password=$AUTH"* ]]
    credential_approve "$URL"
    assert_token_persisted_nowhere
}

@test "a credential.helper=store set in the global config before the transport ran does not persist the token" {
    git config --file "$TMP_HOME/.gitconfig" credential.helper store
    run run_transport "github.com"
    [ "$status" -eq 0 ]
    run credential_fill "$URL"
    [ "$status" -eq 0 ]
    [[ "$output" == *"password=$AUTH"* ]]
    credential_approve "$URL"
    assert_token_persisted_nowhere
}

@test "an unscoped credential.helper=store in a repository config does not persist the token" {
    run run_transport "github.com"
    [ "$status" -eq 0 ]
    git init -q "$TMP_HOME/repo"
    git -C "$TMP_HOME/repo" config credential.helper store
    cd "$TMP_HOME/repo"
    run credential_fill "$URL"
    [ "$status" -eq 0 ]
    [[ "$output" == *"password=$AUTH"* ]]
    credential_approve "$URL"
    assert_token_persisted_nowhere
}

@test "existing GIT_CONFIG_COUNT entries are kept and the helper entries follow them" {
    export GIT_CONFIG_COUNT=1
    export GIT_CONFIG_KEY_0=user.name
    export GIT_CONFIG_VALUE_0="Keep Me"
    run run_transport "github.com"
    run "$EXEC" HOME="$TMP_HOME" git config --get user.name
    [ "$output" = "Keep Me" ]
    run credential_fill "$URL"
    [[ "$output" == *"password=$AUTH"* ]]
}

@test "the token is in no file under home and not in the git config listing" {
    run run_transport "github.com"
    [ "$status" -eq 0 ]
    run env HOME="$TMP_HOME" git config --list --show-origin
    [[ "$output" != *"$AUTH"* ]]
    run find "$TMP_HOME" -type f -not -path "$SECRETS_DIR/*" -exec grep -lF -- "$AUTH" {} +
    [ -z "$output" ]
}

@test "the old gitconfig and its include are removed, other includes stay" {
    mkdir -p "$TMP_HOME/.config/speedwave"
    printf '[http "http://proxy:4000/git/"]\n\textraHeader = "x-speedwave-proxy-auth: %s"\n' "$AUTH" > "$OLD_CONF"
    git config --file "$TMP_HOME/.gitconfig" --add include.path "~/.config/speedwave/git-transport.gitconfig"
    git config --file "$TMP_HOME/.gitconfig" --add include.path "~/.config/mine.gitconfig"
    run run_transport "github.com"
    [ "$status" -eq 0 ]
    [ ! -e "$OLD_CONF" ]
    run env HOME="$TMP_HOME" git config --global --get-all include.path
    [[ "$output" != *"git-transport.gitconfig"* ]]
    [[ "$output" == *"mine.gitconfig"* ]]
    run env HOME="$TMP_HOME" git config --list --show-origin
    [[ "$output" != *"$AUTH"* ]]
}

@test "the old gitconfig is removed also when no forge is enabled" {
    mkdir -p "$TMP_HOME/.config/speedwave"
    printf 'x\n' > "$OLD_CONF"
    git config --file "$TMP_HOME/.gitconfig" --add include.path "~/.config/speedwave/git-transport.gitconfig"
    run run_transport ""
    [ "$status" -eq 0 ]
    [ ! -e "$OLD_CONF" ]
    run env HOME="$TMP_HOME" git config --global --get-all include.path
    [ "$status" -ne 0 ]
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
    [ "$output" = "$CONF" ] || [ "$output" = "~/.config/speedwave/git-proxy.gitconfig" ]
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

@test "empty proxy url writes nothing" {
    run run_transport "github.com" ""
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
