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

_makefile_var() {
    awk -v name="$1" '
        $1 == name && ($2 == ":=" || $2 == "=") {
            $1 = ""; $2 = ""
            sub(/^[[:space:]]+/, "")
            print
            exit
        }
    ' "$MAKEFILE"
}

_workflow_runtime_windows_pii_ner_step() {
    awk '
        /^  runtime-windows:/ { in_job=1 }
        in_job && /^      - name: pii-ner/ { in_step=1; next }
        in_step && /^      - name: / { exit }
        in_step { print }
    ' "$WORKFLOW"
}

_line_of() {
    grep -n -F -- "$2" <<< "$1" | head -1 | cut -d: -f1
}

@test "runtime-windows runs the same pii-ner commands as the make targets" {
    tools_dir="$(_makefile_var PII_NER_TOOLS)"
    artifact_dir="$(_makefile_var PII_NER_ARTIFACT_DIR)"
    [ -n "$tools_dir" ]
    [ -n "$artifact_dir" ]

    step="$(_workflow_runtime_windows_pii_ner_step)"
    [ -n "$step" ]

    for fragment in \
        "unittest discover -s $tools_dir -p 'test_*.py'" \
        "$tools_dir/fetch_and_convert.py --out $artifact_dir --verify" \
        "cargo test -p speedwave-pii-ner --features model-e2e --test model_e2e"; do
        if ! grep -qF -- "$fragment" <<< "$step"; then
            echo "runtime-windows is missing: $fragment"
            echo "It hand-writes what the pii-ner make targets run; keep both in sync."
            return 1
        fi
    done
}

@test "both CI legs fetch the pii-ner model before the converter tests run" {
    mac_model="$(grep -n 'run: make test-pii-ner-model' "$WORKFLOW" | head -1 | cut -d: -f1)"
    mac_tools="$(grep -n 'run: make test-pii-ner-tools' "$WORKFLOW" | head -1 | cut -d: -f1)"
    [ -n "$mac_model" ]
    [ -n "$mac_tools" ]
    if [ "$mac_model" -gt "$mac_tools" ]; then
        echo "make test-pii-ner-model must run before make test-pii-ner-tools."
        echo "The converter's real-model test skips itself unless the pinned tflite is already cached."
        return 1
    fi

    step="$(_workflow_runtime_windows_pii_ner_step)"
    fetch_line="$(_line_of "$step" "fetch_and_convert.py")"
    unittest_line="$(_line_of "$step" "unittest discover")"
    [ -n "$fetch_line" ]
    [ -n "$unittest_line" ]
    if [ "$fetch_line" -gt "$unittest_line" ]; then
        echo "runtime-windows must fetch the model before running the converter tests."
        return 1
    fi
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
