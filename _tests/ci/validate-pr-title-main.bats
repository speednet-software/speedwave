#!/usr/bin/env bats
# Tests for scripts/validate-pr-title-main.sh
#
# Regression: issue #371 — `chore` as PR title to main makes release-please
# ignore the merge, collapsing feat/fix commits into an invisible release.

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/validate-pr-title-main.sh"

run_script() {
    PR_TITLE="$1" HEAD_REF="${2:-feature/branch}" run bash "$SCRIPT"
}

# ---------------------------------------------------------------------------
# Happy path — allowed conventional commit types
# ---------------------------------------------------------------------------

@test "feat with scope passes" {
    run_script "feat(runtime): add logging"
    [ "$status" -eq 0 ]
}

@test "feat without scope passes" {
    run_script "feat: add thing"
    [ "$status" -eq 0 ]
}

@test "fix with scope passes" {
    run_script "fix(ci): correct build path"
    [ "$status" -eq 0 ]
}

@test "fix with breaking-change marker passes" {
    run_script "fix!: drop legacy API"
    [ "$status" -eq 0 ]
}

@test "feat with scope and breaking-change marker passes" {
    run_script "feat(api)!: redesign surface"
    [ "$status" -eq 0 ]
}

@test "perf passes" {
    run_script "perf(runtime): faster container boot"
    [ "$status" -eq 0 ]
}

@test "refactor passes" {
    run_script "refactor(desktop): extract hub logic"
    [ "$status" -eq 0 ]
}

@test "docs passes" {
    run_script "docs: update ADR index"
    [ "$status" -eq 0 ]
}

@test "ci passes" {
    run_script "ci: bump action version"
    [ "$status" -eq 0 ]
}

@test "test passes" {
    run_script "test(cli): cover edge case"
    [ "$status" -eq 0 ]
}

@test "build passes" {
    run_script "build: update toolchain"
    [ "$status" -eq 0 ]
}

@test "style passes" {
    run_script "style: format Rust sources"
    [ "$status" -eq 0 ]
}

@test "revert passes" {
    run_script "revert: undo feat(runtime): bad change"
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Exempt branches — pass regardless of title (even with chore)
# ---------------------------------------------------------------------------

@test "release-please branch is exempt even with chore title" {
    run_script "chore(main): release 1.2.3" "release-please--branches--main"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Release-please PR"* ]]
}

@test "release-please branch is exempt with empty title" {
    run_script "" "release-please--branches--main--components--root"
    [ "$status" -eq 0 ]
}

@test "backmerge branch is exempt with chore title" {
    run_script "chore: backmerge main into dev after v1.2.3" "chore/backmerge-v1.2.3"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Backmerge PR"* ]]
}

# ---------------------------------------------------------------------------
# Error paths — the regression guard for issue #371
# ---------------------------------------------------------------------------

@test "chore with scope is REJECTED (issue #371 regression)" {
    run_script "chore(deps): bump dependencies"
    [ "$status" -eq 1 ]
    [[ "$output" == *"'chore' is NOT allowed"* ]]
    [[ "$output" == *"#371"* ]]
}

@test "chore without scope is REJECTED" {
    run_script "chore: cleanup"
    [ "$status" -eq 1 ]
    [[ "$output" == *"'chore' is NOT allowed"* ]]
}

@test "chore with breaking-change marker is REJECTED" {
    run_script "chore!: big cleanup"
    [ "$status" -eq 1 ]
    [[ "$output" == *"'chore' is NOT allowed"* ]]
}

@test "chore error message suggests feat/fix alternative" {
    run_script "chore(deps): bump"
    [ "$status" -eq 1 ]
    [[ "$output" == *"feat(...)"* ]]
    [[ "$output" == *"fix(...)"* ]]
}

# ---------------------------------------------------------------------------
# Edge cases — malformed titles
# ---------------------------------------------------------------------------

@test "empty title is REJECTED" {
    run_script ""
    [ "$status" -eq 1 ]
}

@test "title without type is REJECTED" {
    run_script "add logging"
    [ "$status" -eq 1 ]
}

@test "title with unknown type is REJECTED" {
    run_script "wip: in progress"
    [ "$status" -eq 1 ]
}

@test "title without colon is REJECTED" {
    run_script "feat add thing"
    [ "$status" -eq 1 ]
}

@test "title without description after colon is REJECTED" {
    run_script "feat: "
    [ "$status" -eq 1 ]
}

@test "title with only type and colon is REJECTED" {
    run_script "feat:"
    [ "$status" -eq 1 ]
}

@test "feat-ish but misspelled is REJECTED" {
    run_script "feet(runtime): add logging"
    [ "$status" -eq 1 ]
}

@test "uppercase type is REJECTED" {
    run_script "FEAT: add thing"
    [ "$status" -eq 1 ]
}
