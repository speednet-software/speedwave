#!/usr/bin/env bats

# Behavioral verification for the plugin signature runtime invariant.

load setup

# SPEEDWAVE_DATA_DIR basename must match `^[a-z][a-z0-9-]{0,63}$`;
# `mktemp -d` basenames contain a `.`, so nest a clean-named child.
setup() {
    TEST_TEMP_DIR="$(mktemp -d)"
    export TEST_TEMP_DIR
    export SPEEDWAVE_DATA_DIR="$TEST_TEMP_DIR/sw-test"
    mkdir -p "$SPEEDWAVE_DATA_DIR/plugins"
}

teardown() {
    rm -rf "$TEST_TEMP_DIR"
    unset SPEEDWAVE_DATA_DIR
}

# Drops a syntactically-valid manifest into the plugin dir but no
# SIGNATURE — exercises the MissingSignature audit path.
make_unsigned_plugin_dir() {
    local slug="$1"
    local plugin_dir="$SPEEDWAVE_DATA_DIR/plugins/$slug"
    mkdir -p "$plugin_dir"
    cat > "$plugin_dir/plugin.json" <<EOF
{"slug":"$slug","speedwave_compat":">=0.0.1","name":"$slug","version":"1.0.0","description":"x"}
EOF
}

@test "speedwave check rejects unsigned plugin (audit hard-fail, exit 2)" {
    make_unsigned_plugin_dir "evil"
    run "$SPEEDWAVE_BIN" check
    [ "$status" -eq 2 ]
    [[ "$output" == *"Plugin verification failed"* ]]
    [[ "$output" == *"evil"* ]]
}

# Bypass is `cfg(debug_assertions)`-gated; release ignores the env var,
# debug builds are skipped.
@test "release CLI rejects unsigned plugin even with SPEEDWAVE_ALLOW_UNSIGNED=1" {
    if [[ "$SPEEDWAVE_BIN" == *"/debug/"* ]]; then
        skip "Skipping on debug build — bypass is intentionally live there"
    fi
    make_unsigned_plugin_dir "evil"
    SPEEDWAVE_ALLOW_UNSIGNED=1 run "$SPEEDWAVE_BIN" check
    [ "$status" -eq 2 ]
    [[ "$output" == *"Plugin verification failed"* ]]
}

@test "speedwave plugin remove works on unverified plugin (recovery path)" {
    make_unsigned_plugin_dir "evil"
    # Recovery is the contract: even when audit_all would fail, the
    # user must be able to clean up by name.
    run "$SPEEDWAVE_BIN" plugin remove evil
    [ "$status" -eq 0 ]
    [ ! -d "$SPEEDWAVE_DATA_DIR/plugins/evil" ]
}

@test "speedwave plugin list works when other plugins are unverified" {
    # The list command must run even if the on-disk state contains a
    # tampered plugin — without this, recovery is impossible from CLI.
    make_unsigned_plugin_dir "evil"
    run "$SPEEDWAVE_BIN" plugin list
    [ "$status" -eq 0 ]
    [[ "$output" == *"evil"* ]]
}

# Recovery must target only the named plugin even when another bad one is
# co-installed.
@test "speedwave plugin remove targets only the bad plugin" {
    make_unsigned_plugin_dir "evil"
    make_unsigned_plugin_dir "also-evil"
    run "$SPEEDWAVE_BIN" plugin remove evil
    [ "$status" -eq 0 ]
    [ ! -d "$SPEEDWAVE_DATA_DIR/plugins/evil" ]
    [ -d "$SPEEDWAVE_DATA_DIR/plugins/also-evil" ]
}

# The tolerant lister must surface every directory, verified or not.
@test "speedwave plugin list shows both verified and unverified entries" {
    make_unsigned_plugin_dir "evil"
    make_unsigned_plugin_dir "also-evil"
    run "$SPEEDWAVE_BIN" plugin list
    [ "$status" -eq 0 ]
    [[ "$output" == *"evil"* ]]
    [[ "$output" == *"also-evil"* ]]
}
