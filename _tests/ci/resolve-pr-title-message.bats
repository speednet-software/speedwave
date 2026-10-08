#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/resolve-pr-title-message.sh"

setup() {
    STUB_DIR="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$STUB_DIR"
}

run_script() {
    PATH="$STUB_DIR:$PATH" run bash "$SCRIPT"
}

@test "pull_request event resolves to the PR title" {
    EVENT_NAME=pull_request PR_TITLE='feat(release): add changelog job' run_script
    [ "$status" -eq 0 ]
    [ "$output" = "feat(release): add changelog job" ]
}

@test "pull_request event with an empty title fails loud" {
    EVENT_NAME=pull_request PR_TITLE='' run_script
    [ "$status" -ne 0 ]
    [[ "$output" == *"no commit message resolved"* ]]
}

@test "merge_group event resolves to the first line of head_commit.message" {
    EVENT_NAME=merge_group MERGE_GROUP_MESSAGE=$'fix(ci): stop flaky retry\n\nBody line explaining why.' run_script
    [ "$status" -eq 0 ]
    [ "$output" = "fix(ci): stop flaky retry" ]
}

@test "merge_group event falls back to the PR title via the API when head_commit.message is empty" {
    cat >"$STUB_DIR/gh" <<'EOF'
#!/usr/bin/env bash
echo "gh $*" >>"$GH_CALL_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
    printf '%s' "chore(release): changelog 0.21.0"
fi
EOF
    chmod +x "$STUB_DIR/gh"
    export GH_CALL_LOG="$BATS_TEST_TMPDIR/gh-calls.log"
    : >"$GH_CALL_LOG"

    EVENT_NAME=merge_group MERGE_GROUP_MESSAGE='' \
        HEAD_REF='refs/heads/gh-readonly-queue/dev/pr-1234-abcdef0' \
        REPO='speednet-software/speedwave' run_script

    [ "$status" -eq 0 ]
    [ "$output" = "chore(release): changelog 0.21.0" ]
    grep -q -- '--repo speednet-software/speedwave' "$GH_CALL_LOG"
    grep -q 'pr view 1234' "$GH_CALL_LOG"
}

@test "merge_group fallback fails loud when the PR number cannot be parsed from head_ref" {
    EVENT_NAME=merge_group MERGE_GROUP_MESSAGE='' \
        HEAD_REF='refs/heads/some-other-branch' \
        REPO='speednet-software/speedwave' run_script
    [ "$status" -ne 0 ]
    [[ "$output" == *"could not parse a PR number"* ]]
}

@test "merge_group fallback fails loud when gh is not available" {
    EVENT_NAME=merge_group MERGE_GROUP_MESSAGE='' \
        HEAD_REF='refs/heads/gh-readonly-queue/dev/pr-5-deadbee' \
        REPO='speednet-software/speedwave' PATH="/usr/bin:/bin" run bash "$SCRIPT"
    [ "$status" -ne 0 ]
    [[ "$output" == *"gh is required"* ]]
}

@test "unsupported event name fails loud" {
    EVENT_NAME=workflow_dispatch run_script
    [ "$status" -ne 0 ]
    [[ "$output" == *"unsupported event"* ]]
}
