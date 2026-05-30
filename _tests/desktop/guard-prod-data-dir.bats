#!/usr/bin/env bats
# Tests for the `guard-not-prod-data-dir` Makefile target (ADR-031 §4).
# It must hard-refuse a production data dir (basename `.speedwave`) so a
# dev/test action can never touch ~/.speedwave, even if the user exported
# SPEEDWAVE_DATA_DIR to point there.

REPO_ROOT="$BATS_TEST_DIRNAME/../.."

run_guard() {
    SPEEDWAVE_DATA_DIR="$1" make -C "$REPO_ROOT" guard-not-prod-data-dir
}

@test "guard refuses the production data dir (~/.speedwave)" {
    run run_guard "$HOME/.speedwave"
    [ "$status" -ne 0 ]
    [[ "$output" == *"production data dir"* ]]
}

@test "guard refuses any path whose basename is .speedwave" {
    run run_guard "/opt/somewhere/.speedwave"
    [ "$status" -ne 0 ]
}

@test "guard refuses a bare .speedwave (no path separator)" {
    run run_guard ".speedwave"
    [ "$status" -ne 0 ]
}

@test "guard allows the dev data dir (~/.speedwave-dev)" {
    run run_guard "$HOME/.speedwave-dev"
    [ "$status" -eq 0 ]
}

@test "guard allows a non-production basename ending in -dev/-test" {
    run run_guard "/tmp/.speedwave-test"
    [ "$status" -eq 0 ]
    run run_guard "/tmp/scratch"
    [ "$status" -eq 0 ]
}

@test "guard allows an empty SPEEDWAVE_DATA_DIR" {
    # An empty value does not match the `*/.speedwave` production pattern, so the
    # guard passes it. (Make's `?=` does NOT substitute the default for an
    # explicitly-empty value; the empty-as-unset → ~/.speedwave fallback is
    # enforced in Rust by `data_dir_from`, not here.)
    run run_guard ""
    [ "$status" -eq 0 ]
}
