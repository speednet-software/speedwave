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

@test "test.yml reads no secrets (named failure: PR code gets a release signing key)" {
    run grep -n 'secrets\.' "$TEST_WORKFLOW"
    [ "$status" -eq 1 ]
}

@test "e2e.yml exists with e2e-macos and e2e-windows on pull_request, merge_group and workflow_dispatch, referencing SPEED-738 (named failure: a required check that never reports on the pull request keeps it out of the merge queue)" {
    [ -f "$E2E_WORKFLOW" ]
    on="$(_on_block "$E2E_WORKFLOW")"
    [[ "$on" == *"pull_request"* ]]
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

@test "test.yml never interpolates github.event.* straight into a run: step (named failure: untrusted payload reaches the shell unescaped, route it through env: instead)" {
    run python3 - "$TEST_WORKFLOW" <<'PY'
import re
import sys

path = sys.argv[1]
lines = open(path).read().split("\n")
pattern = re.compile(r"\$\{\{\s*github\.event\.")
in_run = False
run_indent = None
hits = []
for i, line in enumerate(lines, 1):
    block_start = re.match(r"^(\s*)run:\s*[|>]?\s*$", line)
    inline = re.match(r"^(\s*)run:\s*(.+)$", line)
    if in_run:
        if line.strip() == "":
            continue
        indent = len(line) - len(line.lstrip())
        if indent <= run_indent:
            in_run = False
        elif pattern.search(line):
            hits.append((i, line))
            continue
    if block_start:
        in_run = True
        run_indent = len(block_start.group(1))
    elif inline and pattern.search(inline.group(2)):
        hits.append((i, line))

for lineno, text in hits:
    print(f"{lineno}: {text}")
sys.exit(1 if hits else 0)
PY
    [ "$status" -eq 0 ]
}
