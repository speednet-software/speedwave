#!/usr/bin/env bash

export SPEEDWAVE_BIN="${SPEEDWAVE_BIN:-../../target/debug/speedwave}"
case "$SPEEDWAVE_BIN" in
    /*) ;;  
    *)  SPEEDWAVE_BIN="$(cd "$(dirname "$SPEEDWAVE_BIN")" && pwd)/$(basename "$SPEEDWAVE_BIN")"
        export SPEEDWAVE_BIN
        ;;
esac

setup() {
    TEST_TEMP_DIR="$(mktemp -d)"
    export TEST_TEMP_DIR
}

teardown() {
    rm -rf "$TEST_TEMP_DIR"
}

assert_exit_code() {
    local expected="$1"
    local actual="$status"
    if [[ "$actual" != "$expected" ]]; then
        echo "Expected exit code $expected, got $actual"
        echo "Output: $output"
        return 1
    fi
}

assert_output_contains() {
    local expected="$1"
    if [[ "$output" != *"$expected"* ]]; then
        echo "Expected output to contain: $expected"
        echo "Actual output: $output"
        return 1
    fi
}
