#!/usr/bin/env bats

EXEC="$BATS_TEST_DIRNAME/../../containers/speedwave-exec.sh"
ENTRYPOINT="$BATS_TEST_DIRNAME/../../containers/entrypoint.sh"
LIBRARY="$BATS_TEST_DIRNAME/../../containers/speedwave-secret-env.sh"
DEFAULTS_RS="$BATS_TEST_DIRNAME/../../crates/speedwave-runtime/src/defaults.rs"

setup() {
    SECRETS_DIR="$(mktemp -d)"
    export SPEEDWAVE_SECRETS_DIR="$SECRETS_DIR"
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_CUSTOM_HEADERS SPEEDWAVE_GIT_PROXY_AUTH
}

teardown() {
    rm -rf "$SECRETS_DIR" "${TEST_HOME:-}" "${PATCHED:-}"
}

show_secret_env() {
    printf 'key=[%s] token=[%s] headers=[%s] git=[%s]' \
        "${ANTHROPIC_API_KEY-unset}" "${ANTHROPIC_AUTH_TOKEN-unset}" \
        "${ANTHROPIC_CUSTOM_HEADERS-unset}" "${SPEEDWAVE_GIT_PROXY_AUTH-unset}"
}

@test "exports the four secret files as environment of the executed command" {
    printf 'k1' > "$SECRETS_DIR/anthropic-api-key"
    printf 't1' > "$SECRETS_DIR/anthropic-auth-token"
    printf 'x-speedwave-proxy-auth: c1' > "$SECRETS_DIR/anthropic-custom-headers"
    printf 'g1' > "$SECRETS_DIR/git-proxy-auth"
    run "$EXEC" FOO=bar sh -c "$(declare -f show_secret_env); show_secret_env; printf ' foo=[%s]' \"\$FOO\""
    [ "$status" -eq 0 ]
    [ "$output" = "key=[k1] token=[t1] headers=[x-speedwave-proxy-auth: c1] git=[g1] foo=[bar]" ]
}

@test "strips trailing newlines from a secret value" {
    printf 'k1\n\n' > "$SECRETS_DIR/anthropic-api-key"
    run "$EXEC" sh -c 'printf "[%s]" "$ANTHROPIC_API_KEY"'
    [ "$status" -eq 0 ]
    [ "$output" = "[k1]" ]
}

@test "exports nothing for empty, newline-only and missing files" {
    : > "$SECRETS_DIR/anthropic-api-key"
    printf '\n' > "$SECRETS_DIR/anthropic-auth-token"
    run "$EXEC" sh -c "$(declare -f show_secret_env); show_secret_env"
    [ "$status" -eq 0 ]
    [ "$output" = "key=[unset] token=[unset] headers=[unset] git=[unset]" ]
}

@test "exports nothing when the secrets directory does not exist" {
    export SPEEDWAVE_SECRETS_DIR="$SECRETS_DIR/absent"
    run "$EXEC" sh -c "$(declare -f show_secret_env); show_secret_env"
    [ "$status" -eq 0 ]
    [ "$output" = "key=[unset] token=[unset] headers=[unset] git=[unset]" ]
}

@test "a secret file overrides a stale value of the same variable" {
    printf 'fresh' > "$SECRETS_DIR/anthropic-api-key"
    ANTHROPIC_API_KEY=stale run "$EXEC" sh -c 'printf "[%s]" "$ANTHROPIC_API_KEY"'
    [ "$output" = "[fresh]" ]
}

@test "an explicit assignment on the command line wins over the secret file" {
    printf 'fromfile' > "$SECRETS_DIR/anthropic-api-key"
    run "$EXEC" ANTHROPIC_API_KEY=explicit sh -c 'printf "[%s]" "$ANTHROPIC_API_KEY"'
    [ "$output" = "[explicit]" ]
}

@test "env -u after the wrapper's own assignments unsets a loaded secret" {
    printf 'k1' > "$SECRETS_DIR/anthropic-api-key"
    run "$EXEC" X=1 env -u ANTHROPIC_API_KEY sh -c 'printf "[%s]" "${ANTHROPIC_API_KEY-unset}"'
    [ "$output" = "[unset]" ]
}

@test "passes the exit code of the command through" {
    run "$EXEC" sh -c 'exit 37'
    [ "$status" -eq 37 ]
}

@test "reports a missing command with env's exit code" {
    run -127 "$EXEC" FOO=bar /nonexistent/command
}

@test "refuses to run without arguments instead of printing the environment" {
    printf 'k1' > "$SECRETS_DIR/anthropic-api-key"
    run "$EXEC"
    [ "$status" -eq 2 ]
    [[ "$output" != *"k1"* ]]
}

@test "replaces itself with the command so signals reach it" {
    run "$EXEC" sh -c 'kill -TERM $$'
    [ "$status" -eq 143 ]
}

@test "entrypoint exports the secret files before running its command" {
    TEST_HOME="$(mktemp -d)"
    PATCHED="$(mktemp)"
    mkdir -p "$TEST_HOME/.claude" "$TEST_HOME/stubs"
    printf '#!/bin/bash\necho "%s (Claude Code)"\n' \
        "$(grep 'pub const CLAUDE_VERSION' "$DEFAULTS_RS" | sed 's/.*"\(.*\)".*/\1/')" > "$TEST_HOME/stubs/claude"
    chmod +x "$TEST_HOME/stubs/claude"
    sed "s|/usr/local/bin/speedwave-secret-env.sh|${LIBRARY}|" "$ENTRYPOINT" > "$PATCHED"
    printf 'k1\n' > "$SECRETS_DIR/anthropic-api-key"
    printf 'g1' > "$SECRETS_DIR/git-proxy-auth"
    HOME="$TEST_HOME" PATH="$TEST_HOME/stubs:$PATH" SPEEDWAVE_SKIP_HUB_WAIT=1 \
        CLAUDE_READY_MARKER="$TEST_HOME/ready" SPEEDWAVE_RESOURCES="$TEST_HOME/res" \
        CLAUDE_VERSION="$(grep 'pub const CLAUDE_VERSION' "$DEFAULTS_RS" | sed 's/.*"\(.*\)".*/\1/')" \
        run bash "$PATCHED" sh -c "$(declare -f show_secret_env); show_secret_env"
    [[ "$output" == *"key=[k1] token=[unset] headers=[unset] git=[g1]" ]]
}
