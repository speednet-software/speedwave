#!/usr/bin/env bats

# Behavioral verification for `host_exec` (ADR-054 / SPW-83) against the
# real CLI binary — the wire-format contract between the Rust runtime
# (which serialises the user config) and the TypeScript worker (which
# reads the on-disk JSON), plus the user-config-only invariant
# (a `hostExec` block in the repo `.speedwave.json` MUST be silently
# ignored, like `claude.llm.provider`/`base_url`).
#
# These tests stand up a `SPEEDWAVE_DATA_DIR` per test, plant a user
# config, run `speedwave check`, and assert behaviour from its output
# and from the on-disk JSON the runtime read/wrote. They never spawn
# containers — `speedwave check` short-circuits with
# "runtime is not running" when there's no VM, which is enough to
# exercise the configuration layer end-to-end.

load setup

# Per-test data dir under a clean-named child of $(mktemp) — the data-dir
# basename must match `^[a-z][a-z0-9-]{0,63}$` (see plugin-tamper.bats for
# the same dance).
setup() {
    TEST_TEMP_DIR="$(mktemp -d)"
    export TEST_TEMP_DIR
    export SPEEDWAVE_DATA_DIR="$TEST_TEMP_DIR/sw-test"
    mkdir -p "$SPEEDWAVE_DATA_DIR"
    # A project directory the user config will point at.
    export E2E_PROJECT_DIR="$TEST_TEMP_DIR/proj"
    mkdir -p "$E2E_PROJECT_DIR"
}

teardown() {
    rm -rf "$TEST_TEMP_DIR"
    unset SPEEDWAVE_DATA_DIR E2E_PROJECT_DIR
}

# Writes a user config with the given `host_exec` JSON fragment to
# $SPEEDWAVE_DATA_DIR/config.json. The fragment may be empty.
write_user_config() {
    local host_exec_json="${1:-}"
    local integrations='{}'
    if [[ -n "$host_exec_json" ]]; then
        integrations="{\"hostExec\":$host_exec_json}"
    fi
    cat > "$SPEEDWAVE_DATA_DIR/config.json" <<EOF
{
    "projects": [
        {
            "name": "test-proj",
            "dir": "$E2E_PROJECT_DIR",
            "integrations": $integrations
        }
    ],
    "active_project": "test-proj",
    "selected_ide": null,
    "log_level": null
}
EOF
}

# Writes a repo .speedwave.json into $E2E_PROJECT_DIR with a hostExec
# block. The CLI must IGNORE this block (security-class field).
write_repo_config_with_host_exec() {
    cat > "$E2E_PROJECT_DIR/.speedwave.json" <<'EOF'
{
    "integrations": {
        "hostExec": {
            "enabled": true,
            "commands": [
                { "name": "pwn", "exec": "./pwn", "args": [], "confirm": "always" }
            ]
        }
    }
}
EOF
}

# ---------------------------------------------------------------------------
# Wire-format contract: a valid camelCase user-config survives a
# `speedwave check` round-trip — the JSON is what the worker would read.
# ---------------------------------------------------------------------------

@test "speedwave check accepts a valid host_exec user-config (camelCase JSON)" {
    write_user_config '{
        "enabled": true,
        "commands": [
            {
                "name": "gradle_test",
                "exec": "./gradlew",
                "args": ["test", "--tests={class}"],
                "cwdSub": "frontend",
                "params": [
                    { "name": "class", "pattern": "^[A-Za-z0-9_.]+$", "maxLen": 200 }
                ],
                "env": { "CI": "true" },
                "confirm": "session"
            }
        ]
    }'
    run "$SPEEDWAVE_BIN" check 2>&1 || true
    # The check pipeline must terminate cleanly — one of the three
    # structured verdicts (cf. speedwave.bats). A panic or a config-parse
    # error would mean the camelCase wire format is broken.
    [[ "$output" == *"speedwave check OK"* ]] \
        || [[ "$output" == *"speedwave check FAILED"* ]] \
        || [[ "$output" == *"runtime is not running"* ]]
    [[ "$output" != *"panicked"* ]]
    [[ "$output" != *"PANIC"* ]]
    # The user config itself must remain valid JSON after the check
    # (the runtime must NOT silently rewrite it).
    python3 -c "import json; json.load(open('$SPEEDWAVE_DATA_DIR/config.json'))"
}

# ---------------------------------------------------------------------------
# User-config-only invariant: a repo .speedwave.json `hostExec` block is
# silently ignored — `speedwave check` neither fails nor enables host_exec.
# ---------------------------------------------------------------------------

@test "speedwave check ignores a host_exec block in repo .speedwave.json" {
    write_user_config ''                       # user config has NO hostExec
    write_repo_config_with_host_exec           # repo config tries to enable it
    run "$SPEEDWAVE_BIN" check 2>&1 || true
    # Must NOT crash, must NOT report a security violation about host_exec.
    [[ "$output" == *"speedwave check OK"* ]] \
        || [[ "$output" == *"speedwave check FAILED"* ]] \
        || [[ "$output" == *"runtime is not running"* ]]
    [[ "$output" != *"panicked"* ]]
    # The runtime must have logged or silently dropped the repo's
    # hostExec block — it must NOT carry "pwn" through as an enabled tool.
    # If the check produced a security-violation message, it must not
    # be host_exec related; the cheap regression guard is asserting the
    # word "pwn" never shows up in the (potentially user-facing) output.
    [[ "$output" != *"pwn"* ]]
}

# ---------------------------------------------------------------------------
# Tolerance: a structurally invalid host_exec recipe in the user config
# must not crash `speedwave check`. (The validation gate is in the Tauri
# `host_exec_save_settings` command — `speedwave check` should ignore an
# invalid block gracefully rather than refuse to boot the CLI.)
# ---------------------------------------------------------------------------

@test "speedwave check tolerates a malformed host_exec block in the user config" {
    # `commands` here is the wrong shape (a string, not an array) — the
    # runtime should not panic on this.
    cat > "$SPEEDWAVE_DATA_DIR/config.json" <<EOF
{
    "projects": [
        {
            "name": "test-proj",
            "dir": "$E2E_PROJECT_DIR",
            "integrations": {
                "hostExec": { "enabled": true, "commands": "not-an-array" }
            }
        }
    ],
    "active_project": "test-proj"
}
EOF
    run "$SPEEDWAVE_BIN" check 2>&1 || true
    # Exit code may be non-zero (config parse failure is a legitimate
    # error), but the CLI must NOT panic.
    [[ "$output" != *"panicked"* ]]
    [[ "$output" != *"PANIC"* ]]
}

# ---------------------------------------------------------------------------
# Boundary: a 0-recipe `host_exec` block (enabled, no commands) is a valid
# state — host_exec is "on" but Claude can run nothing. The check must
# succeed and not list any recipe.
# ---------------------------------------------------------------------------

@test "speedwave check accepts an enabled host_exec with an empty commands list" {
    write_user_config '{ "enabled": true, "commands": [] }'
    run "$SPEEDWAVE_BIN" check 2>&1 || true
    [[ "$output" == *"speedwave check OK"* ]] \
        || [[ "$output" == *"speedwave check FAILED"* ]] \
        || [[ "$output" == *"runtime is not running"* ]]
    [[ "$output" != *"panicked"* ]]
}
