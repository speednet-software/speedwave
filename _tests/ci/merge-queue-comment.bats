#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/merge-queue-comment.sh"
HEAD="gh-readonly-queue/dev/pr-1420-0123456789abcdef"
ENCODED="gh-readonly-queue%2Fdev%2Fpr-1420-0123456789abcdef"

setup() {
    STUB_DIR="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$STUB_DIR"
    cat >"$STUB_DIR/gh" <<'EOF2'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$BATS_TEST_TMPDIR/gh.argv"
if [[ " $* " == *" --body-file - "* ]]; then
    cat >"$BATS_TEST_TMPDIR/gh.stdin"
fi
exit "${GH_STUB_EXIT:-0}"
EOF2
    chmod +x "$STUB_DIR/gh"
    export REPO="speednet/speedwave" SERVER_URL="https://github.com" GH_TOKEN=x
}

run_script() {
    PATH="$STUB_DIR:$PATH" run bash "$SCRIPT"
}

posted_body() {
    if [ -f "$BATS_TEST_TMPDIR/gh.stdin" ]; then
        cat "$BATS_TEST_TMPDIR/gh.stdin"
    else
        grep -A1 -x -- '--body' "$BATS_TEST_TMPDIR/gh.argv" | tail -n1
    fi
}

@test "the PR number is parsed from the group branch and passed to gh pr comment" {
    HEAD_REF="$HEAD" run_script
    [ "$status" -eq 0 ]
    run cat "$BATS_TEST_TMPDIR/gh.argv"
    [[ "${lines[0]}" == "pr" ]]
    [[ "${lines[1]}" == "comment" ]]
    [[ "${lines[2]}" == "1420" ]]
    [[ "$output" == *$'--repo\nspeednet/speedwave'* ]]
}

@test "the comment carries the test.yml badge and the runs link for the encoded branch" {
    HEAD_REF="$HEAD" run_script
    [ "$status" -eq 0 ]
    body="$(posted_body)"
    runs="https://github.com/speednet/speedwave/actions/workflows/test.yml?query=branch%3A$ENCODED"
    badge="https://github.com/speednet/speedwave/actions/workflows/test.yml/badge.svg?branch=$ENCODED&event=merge_group"
    [[ "$body" == "🚦 Merge queue run: [![test]($badge)]($runs) [logs]($runs)" ]]
}

@test "an empty head_ref fails with an error annotation and posts nothing" {
    HEAD_REF="" run_script
    [ "$status" -ne 0 ]
    [[ "$output" == *"::error::"* ]]
    [ ! -f "$BATS_TEST_TMPDIR/gh.argv" ]
}

@test "a head_ref without a pr number fails with an error annotation and posts nothing" {
    HEAD_REF="gh-readonly-queue/dev/nothing-here" run_script
    [ "$status" -ne 0 ]
    [[ "$output" == *"::error::"* ]]
    [ ! -f "$BATS_TEST_TMPDIR/gh.argv" ]
}

@test "a gh failure propagates as a non-zero exit" {
    HEAD_REF="$HEAD" GH_STUB_EXIT=1 run_script
    [ "$status" -ne 0 ]
}
