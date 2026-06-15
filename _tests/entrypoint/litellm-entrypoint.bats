#!/usr/bin/env bats
# Tests for containers/litellm/entrypoint.sh (ADR-073)
# Runs on the host (macOS) — stubs out 'litellm' so no Python is required.

ENTRYPOINT="$BATS_TEST_DIRNAME/../../containers/litellm/entrypoint.sh"

setup() {
    TOKENS_DIR="$(mktemp -d)"
    export SPW_TOKENS_DIR="$TOKENS_DIR"

    # Stub litellm: dump the SPW_KEY_* environment it would see, then exit.
    STUBS_DIR="$(mktemp -d)"
    cat > "$STUBS_DIR/litellm" <<'EOF'
#!/bin/sh
env | grep '^SPW_KEY_' | sort
echo "LITELLM-ARGS: $*"
EOF
    chmod +x "$STUBS_DIR/litellm"
    export PATH="$STUBS_DIR:$PATH"
}

teardown() {
    rm -rf "$TOKENS_DIR" "$STUBS_DIR"
}

@test "exports token files as SPW_KEY_<PROVIDER_ID> env vars" {
    printf 'sk-or-v1-test-key' > "$TOKENS_DIR/openrouter_api_key"
    printf 'sk-ant-test' > "$TOKENS_DIR/my-anthropic_api_key"

    run "$ENTRYPOINT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"SPW_KEY_OPENROUTER=sk-or-v1-test-key"* ]]
    # Hyphens in provider_id map to underscores (derive_worker_env rule).
    [[ "$output" == *"SPW_KEY_MY_ANTHROPIC=sk-ant-test"* ]]
}

@test "execs litellm with the fixed config path and port" {
    run "$ENTRYPOINT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"LITELLM-ARGS: --config /config/config.yaml --host 0.0.0.0 --port 4000"* ]]
}

@test "starts cleanly with no tokens dir" {
    export SPW_TOKENS_DIR="$TOKENS_DIR/does-not-exist"
    run "$ENTRYPOINT"
    [ "$status" -eq 0 ]
    [[ "$output" != *"SPW_KEY_"* ]]
}

@test "skips empty token files" {
    : > "$TOKENS_DIR/empty_api_key"
    run "$ENTRYPOINT"
    [ "$status" -eq 0 ]
    [[ "$output" != *"SPW_KEY_EMPTY"* ]]
}

@test "skips provider ids that fail the slug shape" {
    # Uppercase, dots, and underscores would not have passed host-side slug
    # validation — the entrypoint must not export them (defense in depth
    # against a tampered tokens dir injecting arbitrary env names).
    printf 'v' > "$TOKENS_DIR/Bad.Provider_api_key"
    printf 'v' > "$TOKENS_DIR/UPPER_api_key"
    run "$ENTRYPOINT"
    [ "$status" -eq 0 ]
    [[ "$output" != *"SPW_KEY_BAD"* ]]
    [[ "$output" != *"SPW_KEY_UPPER"* ]]
}

@test "rejects a provider id with a leading digit" {
    # `^[a-z]...` — a digit-leading id fails host-side validation; the
    # entrypoint must not normalise it into an env name.
    printf 'v' > "$TOKENS_DIR/9bad_api_key"
    run "$ENTRYPOINT"
    [ "$status" -eq 0 ]
    [[ "$output" != *"SPW_KEY_9BAD"* ]]
}

@test "rejects a provider id with a leading hyphen" {
    # A hyphen-leading id would normalise to SPW_KEY__BAD — rejected.
    printf 'v' > "$TOKENS_DIR/-bad_api_key"
    run "$ENTRYPOINT"
    [ "$status" -eq 0 ]
    [[ "$output" != *"SPW_KEY__BAD"* ]]
    [[ "$output" != *"_BAD="* ]]
}

@test "accepts a valid slug starting with a letter" {
    printf 'v' > "$TOKENS_DIR/a-valid-slug_api_key"
    run "$ENTRYPOINT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"SPW_KEY_A_VALID_SLUG=v"* ]]
}

@test "never exports canonical provider env names" {
    # The ADR-073 invariant: a key must not surface as ANTHROPIC_API_KEY etc.
    printf 'sk-test' > "$TOKENS_DIR/anthropic_api_key"
    cat > "$STUBS_DIR/litellm" <<'EOF'
#!/bin/sh
env | grep -E '^(ANTHROPIC|OPENAI|OPENROUTER)' || true
echo "DONE"
EOF
    chmod +x "$STUBS_DIR/litellm"
    run "$ENTRYPOINT"
    [ "$status" -eq 0 ]
    [[ "$output" != *"ANTHROPIC_API_KEY="* ]]
    [[ "$output" != *"ANTHROPIC_AUTH_TOKEN="* ]]
    [[ "$output" == *"DONE"* ]]
}
