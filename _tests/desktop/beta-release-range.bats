#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/beta-release-range.sh"

commit() {
  echo "$1" >> file
  git add file
  git -c user.name=t -c user.email=t@t commit -qm "$1"
}

setup() {
  WORK="$BATS_TEST_TMPDIR/work"
  git init -q "$WORK"
  cd "$WORK"
  commit first
}

@test "HEAD that already carries a beta tag is skipped" {
  git tag 'v0.21.0+1'
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$output" = "skip=true" ]
}

@test "new commits after a beta start the range at that beta" {
  git tag 'v0.21.0+1'
  commit second
  commit third
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$output" = $'skip=false\nsince=v0.21.0+1' ]
}

@test "the nearest beta wins over an older one" {
  git tag 'v0.21.0+1'
  commit second
  git tag 'v0.21.0+2'
  commit third
  run bash "$SCRIPT"
  [ "$output" = $'skip=false\nsince=v0.21.0+2' ]
}

@test "a stable tag without build metadata on HEAD does not skip" {
  git tag v0.20.0
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$output" = $'skip=false\nsince=v0.20.0' ]
}

@test "without any beta the range starts at the nearest stable tag" {
  git tag v0.20.0
  commit second
  run bash "$SCRIPT"
  [ "$output" = $'skip=false\nsince=v0.20.0' ]
}

@test "a beta tag on a commit that is not an ancestor of HEAD is ignored" {
  git tag v0.20.0
  git checkout -qb side
  commit side
  git tag 'v0.21.0+9'
  git checkout -q -
  commit second
  run bash "$SCRIPT"
  [ "$output" = $'skip=false\nsince=v0.20.0' ]
}

@test "no v* tag in the history fails with a named error" {
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "::error::no v* tag is an ancestor of HEAD" ]]
}
