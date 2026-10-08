#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
TEST_WORKFLOW="$REPO_ROOT/.github/workflows/test.yml"
E2E_WORKFLOW="$REPO_ROOT/.github/workflows/e2e.yml"
JOB_HEADER='^  [A-Za-z_][A-Za-z0-9_-]*:[[:space:]]*$'

REQUIRED_LANES="architecture audit build ci-config desktop-windows-check lint security swift test-cli test-desktop test-mcp test-rust test-rust-windows"

_workflow_job_ids() {
    awk -v hdr="$JOB_HEADER" '
        /^jobs:/ { in_jobs=1; next }
        in_jobs && $0 ~ hdr { sub(/^  /, ""); sub(/:.*/, ""); print }
    ' "$1"
}

_job_block() {
    local file="$1" job="$2"
    awk -v hdr="$JOB_HEADER" -v job="  ${job}:" '
        $0 == job { in_job=1; next }
        in_job && $0 ~ hdr { exit }
        in_job { print }
    ' "$file"
}

_on_block() {
    awk '
        /^on:/ { f=1; next }
        f && /^[A-Za-z]/ { exit }
        f { print }
    ' "$1"
}

@test "test.yml triggers on pull_request and merge_group only, never push" {
    on="$(_on_block "$TEST_WORKFLOW")"
    [[ "$on" == *"pull_request"* ]]
    [[ "$on" == *"merge_group"* ]]
    [[ "$on" != *"push"* ]]
}

@test "test.yml has no path filter (build and every other lane run unconditionally)" {
    run grep -n '^[[:space:]]*paths:' "$TEST_WORKFLOW"
    [ "$status" -ne 0 ]
}

@test "test.yml defines exactly the thirteen required lanes plus ci-gate" {
    ids="$(_workflow_job_ids "$TEST_WORKFLOW" | sort)"
    expected="$(printf '%s\n' $REQUIRED_LANES ci-gate | sort)"
    if [ "$ids" != "$expected" ]; then
        echo "expected: $(tr '\n' ' ' <<<"$expected")"
        echo "actual:   $(tr '\n' ' ' <<<"$ids")"
        return 1
    fi
}

@test "desktop-build.yml no longer exists" {
    [ ! -f "$REPO_ROOT/.github/workflows/desktop-build.yml" ]
}

@test "build lane builds both macos-latest and windows-latest, no Intel leg" {
    block="$(_job_block "$TEST_WORKFLOW" build)"
    [[ "$block" == *"macos-latest"* ]]
    [[ "$block" == *"windows-latest"* ]]
    [[ "$block" != *"macos_x64"* ]]
    [[ "$block" != *"arch_label"* ]]
}

@test "build lane ends with git diff --exit-code (named failure: build step wrote to a tracked file)" {
    block="$(_job_block "$TEST_WORKFLOW" build)"
    [[ "$block" == *"git diff --exit-code"* ]]
}

@test "test.yml reads no secrets (named failure: PR code gets a release signing key)" {
    run grep -n 'secrets\.' "$TEST_WORKFLOW"
    [ "$status" -eq 1 ]
}

@test "build lane never creates signed updater artifacts" {
    block="$(_job_block "$TEST_WORKFLOW" build)"
    [[ "$block" == *'"createUpdaterArtifacts\":false'* ]]
    [[ "$block" != *TAURI_SIGNING_PRIVATE_KEY* ]]
}

@test "build lane runs check-nsis-update-reset.ps1 on the Windows leg" {
    block="$(_job_block "$TEST_WORKFLOW" build)"
    [[ "$block" == *"check-nsis-update-reset.ps1"* ]]
}

@test "architecture lane is always-green (no test/audit command)" {
    block="$(_job_block "$TEST_WORKFLOW" architecture)"
    [ -n "$block" ]
    [[ "$block" != *"make "* ]]
    [[ "$block" != *"cargo "* ]]
    [[ "$block" != *"npm "* ]]
}

@test "security lane scans PR commits with gitleaks, scoped to the PR's range" {
    block="$(_job_block "$TEST_WORKFLOW" security)"
    [[ "$block" == *"gitleaks"* ]]
    [[ "$block" == *"log-opts"* ]]
}

@test "ci-config lane runs both the CI bats suite and actionlint" {
    block="$(_job_block "$TEST_WORKFLOW" ci-config)"
    [[ "$block" == *"make test-ci"* ]]
    [[ "$block" == *"actionlint"* ]]
}

@test "test-rust lane gates on cargo llvm-cov coverage, on macOS" {
    block="$(_job_block "$TEST_WORKFLOW" test-rust)"
    [[ "$block" == *"macos-latest"* ]]
    [[ "$block" == *"make coverage-rust"* ]]
}

@test "test-desktop lane runs ng test with coverage" {
    block="$(_job_block "$TEST_WORKFLOW" test-desktop)"
    [[ "$block" == *"ng test"* ]]
    [[ "$block" == *"--coverage"* ]]
}

@test "test-cli lane runs the no-VM e2e trio and entrypoint tests" {
    block="$(_job_block "$TEST_WORKFLOW" test-cli)"
    [[ "$block" == *"make test-e2e"* ]]
    [[ "$block" == *"make test-entrypoint"* ]]
}

@test "e2e.yml exists with e2e-macos and e2e-windows on merge_group and workflow_dispatch, referencing SPEED-738" {
    [ -f "$E2E_WORKFLOW" ]
    on="$(_on_block "$E2E_WORKFLOW")"
    [[ "$on" == *"merge_group"* ]]
    [[ "$on" == *"workflow_dispatch"* ]]
    [[ "$on" != *"push"* ]]

    run grep -c '^  e2e-macos:' "$E2E_WORKFLOW"
    [ "$output" = "1" ]
    run grep -c '^  e2e-windows:' "$E2E_WORKFLOW"
    [ "$output" = "1" ]
    run grep -c 'SPEED-738' "$E2E_WORKFLOW"
    [ "$output" -ge 1 ]
}

@test "e2e.yml stub jobs carry no real work (always green)" {
    for job in e2e-macos e2e-windows; do
        block="$(_job_block "$E2E_WORKFLOW" "$job")"
        [[ "$block" != *"ssh"* ]]
        [[ "$block" != *"rig-lane"* ]]
    done
}
