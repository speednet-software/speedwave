#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

setup() {
    CALLER_BIN="$BATS_TEST_TMPDIR/caller-bin"
    FAKE_HOME="$BATS_TEST_TMPDIR/home"
    PROBE="$BATS_TEST_TMPDIR/probe.mk"
    OUT="$BATS_TEST_TMPDIR/probe.out"
    MAKE_BIN="$(command -v make)"
    mkdir -p "$CALLER_BIN" "$FAKE_HOME"
    for tool in node npm npx; do
        {
            echo '#!/bin/sh'
            echo "echo $CALLER_BIN/$tool"
        } >"$CALLER_BIN/$tool"
        chmod +x "$CALLER_BIN/$tool"
    done
    cat >"$PROBE" <<'EOF'
probe-path: ; @printf '%s' "$$PATH" >"$(OUT)"
probe-tools: ; @{ printf '%s\n' "$$PATH"; for tool in node npm npx; do command -v "$$tool"; done; } >"$(OUT)"
probe-direct: ; @node --version
probe-recursive: ; @"$(MAKE)" --no-print-directory -f Makefile -f "$(PROBE)" probe-tools
EOF
}

run_probe() {
    run env -u MAKEFLAGS -u MFLAGS -u MAKELEVEL PATH="$CALLER_BIN:/usr/bin:/bin" HOME="$FAKE_HOME" \
        "$MAKE_BIN" --no-print-directory -C "$REPO_ROOT" -f Makefile -f "$PROBE" \
        OUT="$OUT" PROBE="$PROBE" "$1"
    [ "$status" -eq 0 ] || {
        echo "make $1 failed ($status): $output"
        return 1
    }
}

expect_homebrew_last() {
    case "$1" in
        *"/opt/homebrew/bin"*) ;;
        *)
            echo "Homebrew fallback missing from PATH: $1"
            return 1
            ;;
    esac
    case "${1%%/opt/homebrew/bin*}" in
        *"$CALLER_BIN"*) ;;
        *)
            echo "Homebrew precedes the caller's PATH: $1"
            return 1
            ;;
    esac
}

expect_caller_tools() {
    local expected
    expected="$(printf '%s\n' "$CALLER_BIN/node" "$CALLER_BIN/npm" "$CALLER_BIN/npx")"
    [ "$(tail -n +2 "$OUT")" = "$expected" ] || {
        echo "make resolved:"
        cat "$OUT"
        return 1
    }
    expect_homebrew_last "$(head -n 1 "$OUT")"
}

@test "make exports cargo before the caller's PATH and Homebrew after it" {
    run_probe probe-path
    [ "$(cat "$OUT")" = "$FAKE_HOME/.cargo/bin:$CALLER_BIN:/usr/bin:/bin:/opt/homebrew/bin" ] || {
        echo "make exported PATH=$(cat "$OUT")"
        return 1
    }
}

@test "make recipes run the caller's node, npm and npx" {
    run_probe probe-tools
    expect_caller_tools
}

@test "a bare recipe line runs the caller's node" {
    run_probe probe-direct
    [ "$output" = "$CALLER_BIN/node" ] || {
        echo "bare recipe line ran: $output"
        return 1
    }
}

@test "a recursive make keeps the caller's node, npm and npx" {
    run_probe probe-recursive
    expect_caller_tools
}
