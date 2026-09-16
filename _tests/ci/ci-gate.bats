#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/ci-gate.sh"
WORKFLOW="$REPO_ROOT/.github/workflows/test.yml"
JOB_HEADER='^  [A-Za-z_][A-Za-z0-9_-]*:[[:space:]]*$'

run_gate() {
    NEEDS_JSON="$1" run bash "$GATE"
}

needs_json() {
    local json="{" sep=""
    for pair in "$@"; do
        json+="${sep}\"${pair%%=*}\":{\"result\":\"${pair#*=}\",\"outputs\":{}}"
        sep=","
    done
    echo "${json}}"
}

_workflow_job_ids() {
    awk -v hdr="$JOB_HEADER" '
        /^jobs:/ { in_jobs=1; next }
        in_jobs && $0 ~ hdr { sub(/^  /, ""); sub(/:.*/, ""); print }
    ' "$WORKFLOW"
}

_ci_gate_block() {
    awk -v hdr="$JOB_HEADER" '
        /^  ci-gate:[[:space:]]*$/ { in_job=1; next }
        in_job && $0 ~ hdr { exit }
        in_job { print }
    ' "$WORKFLOW"
}

_needs_ids() {
    awk '
        /^    needs:[[:space:]]*\[/ {
            sub(/^    needs:[[:space:]]*\[/, ""); sub(/\].*$/, ""); gsub(/,/, " ")
            n = split($0, a, " "); for (i = 1; i <= n; i++) print a[i]; next
        }
        /^    needs:[[:space:]]*$/ { block=1; next }
        block && /^      - / { sub(/^      - /, ""); sub(/[[:space:]].*$/, ""); print; next }
        block { block=0 }
    '
}

_ci_gate_needs() {
    _ci_gate_block | _needs_ids
}

_job_ifs() {
    awk -v hdr="$JOB_HEADER" '
        /^jobs:/ { in_jobs=1; next }
        in_jobs && $0 ~ hdr { job=$0; sub(/^  /, "", job); sub(/:.*/, "", job) }
        in_jobs && /^[[:space:]]+if:/ { sub(/^[[:space:]]+if:[[:space:]]*/, ""); print job " " $0 }
    ' "$WORKFLOW"
}


@test "gate passes when every job succeeded" {
    run_gate "$(needs_json lint=success test=success)"
    [ "$status" -eq 0 ]
    [[ "$output" == *"lint"* ]]
    [[ "$output" == *"test"* ]]
}

@test "gate fails and names the job and its result when one job failed" {
    run_gate "$(needs_json lint=success test=failure)"
    [ "$status" -eq 1 ]
    [[ "$output" == *"test"*"failure"* ]]
}

@test "gate fails when a job was cancelled" {
    run_gate "$(needs_json lint=cancelled)"
    [ "$status" -eq 1 ]
    [[ "$output" == *"lint"*"cancelled"* ]]
}

@test "gate names every non-success job, not only the first" {
    run_gate "$(needs_json lint=failure test=success desktop=skipped)"
    [ "$status" -eq 1 ]
    [[ "$output" == *"lint"*"failure"* ]]
    [[ "$output" == *"desktop"*"skipped"* ]]
}

@test "gate reads the pretty-printed payload toJSON(needs) emits" {
    run_gate "$(jq -n '{lint:{result:"success",outputs:{}},test:{result:"failure",outputs:{}}}')"
    [ "$status" -eq 1 ]
    [[ "$output" == *"lint: success"* ]]
    [[ "$output" == *"test"*"failure"* ]]
}

@test "gate fails when NEEDS_JSON is unset" {
    run env -u NEEDS_JSON bash "$GATE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::ci-gate: NEEDS_JSON"* ]]
}

@test "gate fails on an empty needs object" {
    run_gate "{}"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no jobs"* ]]
}

@test "gate fails on malformed NEEDS_JSON" {
    run_gate "not json"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::ci-gate: NEEDS_JSON"* ]]
}

@test "gate fails when NEEDS_JSON is not an object" {
    run_gate '[{"result":"success"}]'
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::ci-gate: NEEDS_JSON"* ]]
}

@test "gate fails when a job entry carries no result" {
    run_gate '{"lint":{"outputs":{}}}'
    [ "$status" -eq 1 ]
    [[ "$output" == *"lint"*"missing"* ]]
}

@test "gate fails when a job entry is not an object" {
    run_gate '{"lint":"success"}'
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::ci-gate: lint"*"missing"* ]]
}


@test "ci-gate needs every other job in test.yml" {
    expected="$(_workflow_job_ids | grep -v '^ci-gate$' | sort)"
    [ -n "$expected" ]
    actual="$(_ci_gate_needs | sort)"
    if [ "$expected" != "$actual" ]; then
        echo "ci-gate.needs must list every other test.yml job."
        echo "expected: $(tr '\n' ' ' <<<"$expected")"
        echo "actual:   $(tr '\n' ' ' <<<"$actual")"
        return 1
    fi
}

@test "needs ids are read from both the flow and the block form" {
    run _needs_ids <<<'    needs: [a, b-c]'
    [ "$output" = $'a\nb-c' ]
    run _needs_ids <<<$'    needs:\n      - a\n      - b-c  # note\n    runs-on: x'
    [ "$output" = $'a\nb-c' ]
}

@test "ci-gate feeds toJSON(needs) into scripts/ci-gate.sh" {
    run grep -c 'NEEDS_JSON: ${{ toJSON(needs) }}' <(_ci_gate_block)
    [ "$output" = "1" ]
    run grep -c '^        run: scripts/ci-gate.sh$' <(_ci_gate_block)
    [ "$output" = "1" ]
}

@test "ci-gate keeps its job id as the check context (no name override)" {
    run grep -c '^    name:' <(_ci_gate_block)
    [ "$output" = "0" ]
}

@test "ci-gate carries the only if: in test.yml (the gate counts skipped as failure)" {
    run _job_ifs
    [ "$output" = "ci-gate always()" ]
}
