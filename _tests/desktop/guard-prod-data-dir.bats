#!/usr/bin/env bats

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
    run run_guard ""
    [ "$status" -ne 0 ]
    [[ "$output" == *"production data dir"* ]]
}

@test "guard refuses a whitespace-only SPEEDWAVE_DATA_DIR" {
    run run_guard "   "
    [ "$status" -ne 0 ]
    [[ "$output" == *"production data dir"* ]]
}
