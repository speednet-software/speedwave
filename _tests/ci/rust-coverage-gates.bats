#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/test.yml"
MAKEFILE="$REPO_ROOT/Makefile"

_makefile_test_rust_cargo_line() {
    awk '
        /^test-rust:/ { in_target=1; next }
        in_target && /^[a-zA-Z]/ { exit }
        in_target && /RUN_CARGO_ISOLATED,cargo test/ {
            sub(/.*RUN_CARGO_ISOLATED,/, "")
            sub(/\)[[:space:]]*$/, "")
            print
        }
    ' "$MAKEFILE"
}

_workflow_runtime_windows_cargo_lines() {
    awk '
        /^  runtime-windows:/ { in_job=1; next }
        in_job && /^  [A-Za-z_][A-Za-z0-9_-]*:[[:space:]]*$/ { exit }
        in_job && /^[[:space:]]*run: cargo test/ {
            sub(/^[[:space:]]*run:[[:space:]]*/, "")
            print
        }
    ' "$WORKFLOW"
}

_makefile_check_clippy_cargo_lines() {
    awk '
        /^check-clippy:/ { in_target=1; next }
        in_target && /^[a-zA-Z]/ { exit }
        in_target && /cargo clippy/ { gsub(/^[ \t]+/, ""); print }
    ' "$MAKEFILE"
}

@test "runtime-windows runs exactly the cargo test invocation of make test-rust" {
    makefile_line="$(_makefile_test_rust_cargo_line)"
    [ -n "$makefile_line" ]

    workflow_lines="$(_workflow_runtime_windows_cargo_lines)"
    [ -n "$workflow_lines" ]

    if [ "$workflow_lines" != "$makefile_line" ]; then
        echo "Makefile test-rust runs: $makefile_line"
        echo "runtime-windows runs:    $workflow_lines"
        echo "Keep the workflow's cargo test line identical to make test-rust's."
        return 1
    fi
}

@test "workflow has no filtered --lib subset for speedwave-runtime" {
    if grep -n 'cargo test -p speedwave-runtime --lib' "$WORKFLOW" | grep -v 'transcription::'; then
        echo "Filtered --lib subsets skip integration binaries and test-support suites."
        return 1
    fi
}

@test "lint job delegates Rust clippy to make check-clippy" {
    grep -q 'run: make check-clippy' "$WORKFLOW"

    if grep -n 'run:.*cargo clippy -p speedwave-' "$WORKFLOW"; then
        echo "Run make check-clippy instead of a hand-rolled cargo clippy."
        return 1
    fi
}

@test "make check-clippy lints all targets and the gated features" {
    lines="$(_makefile_check_clippy_cargo_lines)"
    [ -n "$lines" ]

    while IFS= read -r line; do
        [[ "$line" == *"--all-targets"* ]] || {
            echo "check-clippy line lacks --all-targets: $line"
            return 1
        }
        [[ "$line" == *"-D warnings"* ]] || {
            echo "check-clippy line lacks -D warnings: $line"
            return 1
        }
    done <<< "$lines"

    grep -q -- '--features test-support,audio-transcription' <<< "$lines" || {
        echo "check-clippy must lint the test-support + audio-transcription feature pass."
        return 1
    }
}

@test "audit job delegates cargo audit to make audit-rust" {
    grep -q 'run: make audit-rust' "$WORKFLOW"

    if grep -n 'run:.*cargo audit' "$WORKFLOW"; then
        echo "Run make audit-rust instead of a hand-rolled cargo audit."
        return 1
    fi
}

@test "audit job delegates npm audit to the Makefile targets" {
    grep -q 'run: make audit-mcp audit-desktop' "$WORKFLOW"

    if grep -n 'run:.*npm audit' "$WORKFLOW"; then
        echo "Run make audit-mcp audit-desktop instead of a hand-rolled npm audit."
        return 1
    fi
}
