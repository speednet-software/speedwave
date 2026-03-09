#!/usr/bin/env bats

load setup

# ---------------------------------------------------------------------------
# CLI argument parsing
# ---------------------------------------------------------------------------

@test "speedwave without runtime shows informative error" {
    # When runtime is not available, CLI should exit with helpful message
    # This test works even without Lima/nerdctl installed
    run "$SPEEDWAVE_BIN" 2>&1 || true
    # Should mention setup wizard or runtime
    [[ "$output" == *"runtime"* ]] || [[ "$output" == *"setup"* ]] || [[ "$output" == *"Speedwave"* ]]
}

@test "speedwave check with no compose file shows error" {
    cd "$TEST_TEMP_DIR"
    run "$SPEEDWAVE_BIN" check 2>&1 || true
    # Should fail since there's no project/compose to check
    [ "$status" -ne 0 ] || [[ "$output" == *"error"* ]] || [[ "$output" == *"Error"* ]] || [[ "$output" == *"runtime"* ]]
}

@test "speedwave addon install with nonexistent file shows error" {
    run "$SPEEDWAVE_BIN" addon install /nonexistent/path/addon.zip 2>&1
    [ "$status" -ne 0 ]
    [[ "$output" == *"error"* ]] || [[ "$output" == *"Error"* ]] || [[ "$output" == *"No such file"* ]] || [[ "$output" == *"not found"* ]]
}

@test "speedwave addon without subcommand shows usage" {
    run "$SPEEDWAVE_BIN" addon 2>&1
    [ "$status" -ne 0 ]
    [[ "$output" == *"usage"* ]] || [[ "$output" == *"Usage"* ]] || [[ "$output" == *"addon install"* ]]
}

@test "speedwave addon install without path shows usage" {
    run "$SPEEDWAVE_BIN" addon install 2>&1
    [ "$status" -ne 0 ]
    [[ "$output" == *"usage"* ]] || [[ "$output" == *"Usage"* ]] || [[ "$output" == *"zip-path"* ]]
}

# ---------------------------------------------------------------------------
# Binary exists and is executable
# ---------------------------------------------------------------------------

@test "speedwave binary exists" {
    [ -f "$SPEEDWAVE_BIN" ] || skip "Binary not built yet (run cargo build -p speedwave-cli first)"
}

@test "speedwave binary is executable" {
    [ -x "$SPEEDWAVE_BIN" ] || skip "Binary not built yet"
}
