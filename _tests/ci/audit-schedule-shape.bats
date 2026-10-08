#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
TEST_WORKFLOW="$REPO_ROOT/.github/workflows/test.yml"
SCHEDULE_WORKFLOW="$REPO_ROOT/.github/workflows/audit-schedule.yml"

@test "audit-schedule.yml exists and carries a schedule trigger" {
  [ -f "$SCHEDULE_WORKFLOW" ]
  grep -q '^\s*schedule:' "$SCHEDULE_WORKFLOW"
  grep -Eq "cron: '[^']+'" "$SCHEDULE_WORKFLOW"
}

@test "the time-dependent absolute audit never runs inside test.yml (PR lane stays a diff)" {
  ! grep -q 'audit-schedule' "$TEST_WORKFLOW"
  ! grep -q 'audit-issue.sh' "$TEST_WORKFLOW"
  grep -q 'audit-diff.sh' "$TEST_WORKFLOW"
}

@test "audit-schedule.yml never triggers on pull_request or merge_group" {
  on_block="$(awk '/^on:/ { f=1; next } f && /^[A-Za-z]/ { exit } f { print }' "$SCHEDULE_WORKFLOW")"
  [[ "$on_block" != *"pull_request"* ]]
  [[ "$on_block" != *"merge_group"* ]]
}

@test "audit-schedule.yml creates or updates exactly one GitHub issue on red, via audit-issue.sh" {
  grep -q 'issues: write' "$SCHEDULE_WORKFLOW"
  grep -q 'scripts/audit-issue.sh' "$SCHEDULE_WORKFLOW"
}
