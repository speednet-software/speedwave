#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/ci-gate.sh"

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


@test "needs ids are read from both the flow and the block form" {
    run _needs_ids <<<'    needs: [a, b-c]'
    [ "$output" = $'a\nb-c' ]
    run _needs_ids <<<$'    needs:\n      - a\n      - b-c  # note\n    runs-on: x'
    [ "$output" = $'a\nb-c' ]
}
