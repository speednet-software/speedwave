#!/usr/bin/env bats
# Tests for the `guard-not-prod-data-dir` Makefile target (ADR-031 §4).
# Must hard-refuse a production data dir (basename `.speedwave`).

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

@test "guard refuses an empty SPEEDWAVE_DATA_DIR" {
    # Empty resolves to the production ~/.speedwave in consts::data_dir_from.
    run run_guard ""
    [ "$status" -ne 0 ]
    [[ "$output" == *"production data dir"* ]]
}

@test "guard refuses a whitespace-only SPEEDWAVE_DATA_DIR" {
    run run_guard "   "
    [ "$status" -ne 0 ]
    [[ "$output" == *"production data dir"* ]]
}
