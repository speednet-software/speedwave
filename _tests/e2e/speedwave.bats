#!/usr/bin/env bats

load setup

# ── CLI argument parsing ─────────────────────────────────────────────────────

@test "speedwave without runtime shows informative error" {
    # When runtime is not available, CLI should exit with helpful message
    # This test works even without Lima/nerdctl installed
    run "$SPEEDWAVE_BIN" 2>&1 || true
    # Should mention setup wizard or runtime
    [[ "$output" == *"runtime"* ]] || [[ "$output" == *"setup"* ]] || [[ "$output" == *"Speedwave"* ]]
}

@test "speedwave --help prints usage without touching runtime" {
    run "$SPEEDWAVE_BIN" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"USAGE"* ]]
    [[ "$output" == *"speedwave check"* ]]
    [[ "$output" == *"plugin install"* ]]
    # Must NOT show the runtime-not-running banner
    [[ "$output" != *"runtime is not running"* ]]
}

@test "speedwave -h is equivalent to --help" {
    run "$SPEEDWAVE_BIN" -h
    [ "$status" -eq 0 ]
    [[ "$output" == *"USAGE"* ]]
    [[ "$output" != *"runtime is not running"* ]]
}

@test "speedwave help (subcommand form) prints usage" {
    run "$SPEEDWAVE_BIN" help
    [ "$status" -eq 0 ]
    [[ "$output" == *"USAGE"* ]]
    [[ "$output" != *"runtime is not running"* ]]
}

@test "speedwave check produces a structured verdict" {
    # Verdicts: "speedwave check OK" / "FAILED" / "runtime is not running" / "No project configured"
    cd "$TEST_TEMP_DIR"
    run "$SPEEDWAVE_BIN" check 2>&1 || true
    [[ "$output" == *"speedwave check OK"* ]] \
        || [[ "$output" == *"speedwave check FAILED"* ]] \
        || [[ "$output" == *"runtime is not running"* ]] \
        || [[ "$output" == *"No project configured"* ]]
    # Must not crash with a panic
    [[ "$output" != *"panicked"* ]]
    [[ "$output" != *"PANIC"* ]]
}

@test "speedwave plugin install with nonexistent file shows error" {
    run "$SPEEDWAVE_BIN" plugin install /nonexistent/path/plugin.zip 2>&1
    [ "$status" -ne 0 ]
    [[ "$output" == *"error"* ]] || [[ "$output" == *"Error"* ]] || [[ "$output" == *"No such file"* ]] || [[ "$output" == *"not found"* ]]
}

@test "speedwave plugin without subcommand shows usage" {
    run "$SPEEDWAVE_BIN" plugin 2>&1
    [ "$status" -ne 0 ]
    [[ "$output" == *"usage"* ]] || [[ "$output" == *"Usage"* ]] || [[ "$output" == *"plugin install"* ]]
}

@test "speedwave plugin install without path shows usage" {
    run "$SPEEDWAVE_BIN" plugin install 2>&1
    [ "$status" -ne 0 ]
    [[ "$output" == *"usage"* ]] || [[ "$output" == *"Usage"* ]] || [[ "$output" == *"zip-path"* ]]
}

# ── Binary exists and is executable ─────────────────────────────────────────

@test "speedwave binary exists" {
    [ -f "$SPEEDWAVE_BIN" ] || skip "Binary not built yet (run cargo build -p speedwave-cli first)"
}

@test "speedwave binary is executable" {
    [ -x "$SPEEDWAVE_BIN" ] || skip "Binary not built yet"
}
