#!/usr/bin/env bash
# E2E test helpers for Speedwave CLI

# Path to the built CLI binary. Several tests `cd` into a per-test tempdir
# before running the binary, so a relative path (the default `make test-e2e`
# passes one) would resolve against the tempdir and fail with "command not
# found". Resolve to an absolute path here once, idempotently.
export SPEEDWAVE_BIN="${SPEEDWAVE_BIN:-../../target/debug/speedwave}"
case "$SPEEDWAVE_BIN" in
    /*) ;;  # already absolute
    *)  SPEEDWAVE_BIN="$(cd "$(dirname "$SPEEDWAVE_BIN")" && pwd)/$(basename "$SPEEDWAVE_BIN")"
        export SPEEDWAVE_BIN
        ;;
esac

# Temp directory for test artifacts
setup() {
    TEST_TEMP_DIR="$(mktemp -d)"
    export TEST_TEMP_DIR
}

teardown() {
    rm -rf "$TEST_TEMP_DIR"
}

# Helper: assert exit code
assert_exit_code() {
    local expected="$1"
    local actual="$status"
    if [[ "$actual" != "$expected" ]]; then
        echo "Expected exit code $expected, got $actual"
        echo "Output: $output"
        return 1
    fi
}

# Helper: assert output contains string
assert_output_contains() {
    local expected="$1"
    if [[ "$output" != *"$expected"* ]]; then
        echo "Expected output to contain: $expected"
        echo "Actual output: $output"
        return 1
    fi
}
