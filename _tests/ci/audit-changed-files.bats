#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/audit-changed-files.sh"

_init_repo() {
  FIXTURE="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$FIXTURE"
  git -C "$FIXTURE" init -q
  git -C "$FIXTURE" config user.email ci-test-no-reply.invalid
  git -C "$FIXTURE" config user.name test
}

@test "lists only the paths changed between two commits, as a JSON array" {
  _init_repo
  mkdir -p "$FIXTURE/mcp-servers"
  echo '{}' >"$FIXTURE/mcp-servers/package-lock.json"
  echo "a" >"$FIXTURE/README.md"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -q -m base
  BASE="$(git -C "$FIXTURE" rev-parse HEAD)"

  echo '{"changed":true}' >"$FIXTURE/mcp-servers/package-lock.json"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -q -m head
  HEAD_SHA="$(git -C "$FIXTURE" rev-parse HEAD)"

  out="$BATS_TEST_TMPDIR/changed.json"
  run bash -c "cd '$FIXTURE' && '$SCRIPT' '$BASE' '$HEAD_SHA' '$out'"
  [ "$status" -eq 0 ]
  [ -f "$out" ]
  run python3 -c "import json; d=json.load(open('$out')); print(d)"
  [ "$status" -eq 0 ]
  [ "$output" = "['mcp-servers/package-lock.json']" ]
}

@test "an unchanged tree yields an empty JSON array" {
  _init_repo
  echo "a" >"$FIXTURE/README.md"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -q -m base
  BASE="$(git -C "$FIXTURE" rev-parse HEAD)"

  echo "a" >"$FIXTURE/other.md"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -q -m head-touching-other-file
  HEAD_SHA="$(git -C "$FIXTURE" rev-parse HEAD)"

  out="$BATS_TEST_TMPDIR/changed.json"
  run bash -c "cd '$FIXTURE' && '$SCRIPT' '$BASE' '$HEAD_SHA' '$out'"
  [ "$status" -eq 0 ]
  touched="$(python3 "$REPO_ROOT/scripts/audit-gate.py" lockfiles-touched --changed "$out")"
  [ "$touched" = "false" ]
}

@test "feeding the changed list straight into lockfiles-touched reports true on a Cargo.lock change" {
  _init_repo
  echo "a" >"$FIXTURE/README.md"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -q -m base
  BASE="$(git -C "$FIXTURE" rev-parse HEAD)"

  echo "lockdata" >"$FIXTURE/Cargo.lock"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -q -m head-cargo-lock
  HEAD_SHA="$(git -C "$FIXTURE" rev-parse HEAD)"

  out="$BATS_TEST_TMPDIR/changed.json"
  run bash -c "cd '$FIXTURE' && '$SCRIPT' '$BASE' '$HEAD_SHA' '$out'"
  [ "$status" -eq 0 ]
  touched="$(python3 "$REPO_ROOT/scripts/audit-gate.py" lockfiles-touched --changed "$out")"
  [ "$touched" = "true" ]
}

@test "usage error when an argument is missing" {
  run "$SCRIPT" "" "" ""
  [ "$status" -ne 0 ]
}
