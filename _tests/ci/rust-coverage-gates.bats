#!/usr/bin/env bats
# Coverage gates: CI must run the authoritative Makefile lint/test invocations —
# filtered `--lib` subsets and hand-rolled clippy silently skip most test code.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/test.yml"
MAKEFILE="$REPO_ROOT/Makefile"

# The cargo command inside test-rust's RUN_CARGO_ISOLATED call.
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

# Every `run: cargo test ...` line inside the runtime-windows job.
_workflow_runtime_windows_cargo_lines() {
    awk '
        /^  runtime-windows:/ { in_job=1; next }
        in_job && /^  [a-z][a-zA-Z-]*:[[:space:]]*$/ { exit }
        in_job && /^[[:space:]]*run: cargo test/ {
            sub(/^[[:space:]]*run:[[:space:]]*/, "")
            print
        }
    ' "$WORKFLOW"
}

# Every `cargo clippy` recipe line of the check-clippy target.
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
    # Sole sanctioned subset: the Windows Vulkan lane's `transcription::` module filter —
    # additive #[cfg(windows)] coverage with its own vacuous-filter guard, not the full-suite gate.
    if grep -n 'cargo test -p speedwave-runtime --lib' "$WORKFLOW" | grep -v 'transcription::'; then
        echo "Filtered --lib subsets skip integration binaries and test-support suites."
        return 1
    fi
}

@test "lint job delegates Rust clippy to make check-clippy" {
    grep -q 'run: make check-clippy' "$WORKFLOW"

    # A hand-rolled root-workspace clippy drifts from the Makefile gate
    # (loses --all-targets and the feature passes).
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

    # A hand-rolled cargo audit re-copies AUDIT_IGNORE and drifts from the Makefile.
    if grep -n 'run:.*cargo audit' "$WORKFLOW"; then
        echo "Run make audit-rust instead of a hand-rolled cargo audit."
        return 1
    fi
}
