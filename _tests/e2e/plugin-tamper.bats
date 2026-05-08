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
#
# `consts::derive_instance_name_from` (called eagerly during CLI
# startup) asserts that the data-dir basename matches
# `^[a-z][a-z0-9-]{0,63}$`. `mktemp -d` produces basenames like
# `tmp.XXXXXX` on macOS / `tmp.XXXX` on Linux, both containing a `.`
# that breaks the assertion — so we create the tempdir, then nest a
# clean-named child under it and use *that* as SPEEDWAVE_DATA_DIR.
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

# Two plugins side-by-side: one tampered, one fine. The skip-list's
# whole point is that the user can `plugin remove <bad>` even when
# `<good>` is also installed. Without an explicit two-plugin scenario,
# recovery could regress (e.g. someone wires `plugin remove` through
# `list_verified_plugins`, which fails on the bad one) and the
# single-plugin tests would still pass.
@test "speedwave plugin remove targets only the bad plugin" {
    make_unsigned_plugin_dir "evil"
    make_unsigned_plugin_dir "also-evil"
    run "$SPEEDWAVE_BIN" plugin remove evil
    [ "$status" -eq 0 ]
    [ ! -d "$SPEEDWAVE_DATA_DIR/plugins/evil" ]
    [ -d "$SPEEDWAVE_DATA_DIR/plugins/also-evil" ]
}

@test "speedwave plugin list shows both verified and unverified entries" {
    # The tolerant lister surfaces every directory; the user must see
    # *which* one is broken, not just that "something" is wrong. A
    # filter that hid unverified plugins would make recovery
    # impossible in the UI without dropping to the shell.
    make_unsigned_plugin_dir "evil"
    make_unsigned_plugin_dir "also-evil"
    run "$SPEEDWAVE_BIN" plugin list
    [ "$status" -eq 0 ]
    [[ "$output" == *"evil"* ]]
    [[ "$output" == *"also-evil"* ]]
}
