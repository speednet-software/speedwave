#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/pr-title.yml"
CONFIG="$REPO_ROOT/commitlint.config.js"

@test "pr-title.yml still names its job validate" {
    run grep -cE '^  validate:[[:space:]]*$' "$WORKFLOW"
    [ "$output" = "1" ]
}

@test "pr-title.yml triggers on pull_request and merge_group, never push" {
    run grep -cE '^  pull_request:[[:space:]]*$' "$WORKFLOW"
    [ "$output" = "1" ]
    run grep -cE '^  merge_group:[[:space:]]*$' "$WORKFLOW"
    [ "$output" = "1" ]
    run grep -c '^  push:' "$WORKFLOW"
    [ "$output" = "0" ]
}

@test "pr-title.yml runs commitlint instead of the hand-rolled regex" {
    run grep -c 'npx --no -- commitlint' "$WORKFLOW"
    [ "$output" -ge 1 ]
    run grep -c "PATTERN='\^(feat" "$WORKFLOW"
    [ "$output" = "0" ]
}

@test "pr-title.yml resolves the message through the shared script" {
    run grep -c 'scripts/resolve-pr-title-message.sh' "$WORKFLOW"
    [ "$output" = "1" ]
    [ -x "$REPO_ROOT/scripts/resolve-pr-title-message.sh" ]
}

@test "pr-title.yml reads merge_group.head_commit.message and head_ref for the fallback" {
    run grep -c 'github.event.merge_group.head_commit.message' "$WORKFLOW"
    [ "$output" = "1" ]
    run grep -c 'github.event.merge_group.head_ref' "$WORKFLOW"
    [ "$output" = "1" ]
}

@test "pr-title.yml grants pull-requests read for the merge_group API fallback" {
    run grep -c 'pull-requests: read' "$WORKFLOW"
    [ "$output" = "1" ]
}

@test "commitlint scope-enum accepts the release scope" {
    run grep -c "^ *'release',\$" "$CONFIG"
    [ "$output" = "1" ]
}

@test "commitlint stays a devDependency after the hooks removal" {
    run grep -c '"@commitlint/cli"' "$REPO_ROOT/package.json"
    [ "$output" = "1" ]
}
