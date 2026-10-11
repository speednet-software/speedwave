#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

@test "the repo-root Angular build cache is ignored" {
    run git -C "$REPO_ROOT" check-ignore -q .angular/cache/build
    [ "$status" -eq 0 ]
}

@test "Playwright MCP session output at the repo root is ignored" {
    run git -C "$REPO_ROOT" check-ignore -q .playwright-mcp/page-snapshot.yml
    [ "$status" -eq 0 ]
}
