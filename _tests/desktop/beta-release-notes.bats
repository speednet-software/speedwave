#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/beta-release-notes.sh"

@test "git-cliff notes pass through unchanged" {
  BODY=$'### Bug Fixes\n- Fix a thing (#1)' run bash "$SCRIPT" 'v0.21.0+139'
  [ "$status" -eq 0 ]
  [ "$output" = $'body<<SPEEDWAVE_NOTES_EOF\n### Bug Fixes\n- Fix a thing (#1)\nSPEEDWAVE_NOTES_EOF' ]
}

@test "empty notes fall back to a no-user-facing-changes line" {
  BODY='' run bash "$SCRIPT" 'v0.21.0+139'
  [ "$status" -eq 0 ]
  [ "$output" = $'body<<SPEEDWAVE_NOTES_EOF\nNo user-facing changes since v0.21.0+139.\nSPEEDWAVE_NOTES_EOF' ]
}

@test "whitespace-only notes fall back too" {
  BODY=$'  \n\n ' run bash "$SCRIPT" 'v0.21.0+139'
  [ "$output" = $'body<<SPEEDWAVE_NOTES_EOF\nNo user-facing changes since v0.21.0+139.\nSPEEDWAVE_NOTES_EOF' ]
}

@test "unset notes fall back too" {
  run env -u BODY bash "$SCRIPT" 'v0.21.0+139'
  [ "$status" -eq 0 ]
  [ "${lines[1]}" = 'No user-facing changes since v0.21.0+139.' ]
}

@test "missing since argument fails with a named error" {
  BODY='' run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "::error::usage: beta-release-notes.sh <since-tag>" ]]
}
