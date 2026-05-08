#!/usr/bin/env bats

# Behavioral verification for the plugin signature runtime invariant.
#
# These tests exercise `speedwave check` against synthetic plugin
# directories that should be rejected, then assert exit code 2 and a
# diagnostic message. They run against whatever binary `SPEEDWAVE_BIN`
# points at — pass a release build to verify that the
# `SPEEDWAVE_ALLOW_UNSIGNED` debug bypass is compiled out.

load setup

# Override `setup` to also point SPEEDWAVE_DATA_DIR at a per-test
# tempdir, so we never touch the developer's real `~/.speedwave/`.
setup() {
    TEST_TEMP_DIR="$(mktemp -d)"
    export TEST_TEMP_DIR
    export SPEEDWAVE_DATA_DIR="$TEST_TEMP_DIR"
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

# The headline test for PR6: a release CLI must reject unsigned plugins
# even when SPEEDWAVE_ALLOW_UNSIGNED=1 is set in the environment. The
# bypass is `cfg(debug_assertions)`-gated, so the env var is dead code
# in release builds. With a debug build this test is skipped — debug
# binaries are explicitly allowed to bypass signature checks for dev
# workflows (`make dev` sets the var).
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
