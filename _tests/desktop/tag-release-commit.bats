#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/tag-release-commit.sh"

setup() {
  ORIGIN="$BATS_TEST_TMPDIR/origin.git"
  WORK="$BATS_TEST_TMPDIR/work"
  git init -q --bare "$ORIGIN"
  git init -q "$WORK"
  git -C "$WORK" remote add origin "$ORIGIN"
  echo one > "$WORK/file"
  git -C "$WORK" add file
  git -C "$WORK" -c user.name=t -c user.email=t@t commit -qm first
  cd "$WORK"
}

@test "new tag is created and pushed" {
  run bash "$SCRIPT" v1.0.0
  [ "$status" -eq 0 ]
  [ "$(git rev-parse v1.0.0)" = "$(git rev-parse HEAD)" ]
  [ "$(git -C "$ORIGIN" tag -l v1.0.0)" = "v1.0.0" ]
}

@test "tag already on the same commit is reused with --allow-reuse-same-commit" {
  git tag v1.0.0
  run bash "$SCRIPT" --allow-reuse-same-commit v1.0.0
  [ "$status" -eq 0 ]
  [[ "$output" =~ "::notice::tag v1.0.0 already exists on HEAD, reusing it" ]]
}

@test "tag on a different commit is refused with a named error" {
  git tag v1.0.0
  echo two > file
  git add file
  git -c user.name=t -c user.email=t@t commit -qm second

  run bash "$SCRIPT" --allow-reuse-same-commit v1.0.0
  [ "$status" -eq 1 ]
  [[ "$output" =~ "::error::tag v1.0.0 already exists, refusing to move it" ]]
  [ "$(git rev-parse v1.0.0)" != "$(git rev-parse HEAD)" ]
}

@test "tag on the same commit without the reuse flag is still refused" {
  git tag v1.0.0
  run bash "$SCRIPT" v1.0.0
  [ "$status" -eq 1 ]
  [[ "$output" =~ "::error::tag v1.0.0 already exists, refusing to move it" ]]
}

@test "missing tag argument fails with the usage message" {
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "usage: tag-release-commit.sh" ]]
}

@test "push to a local path remote needs no token" {
  unset GH_AUTOMATION_PAT
  run bash "$SCRIPT" v1.0.0
  [ "$status" -eq 0 ]
  [ "$(git -C "$ORIGIN" tag -l v1.0.0)" = "v1.0.0" ]
}

@test "push to an https remote without GH_AUTOMATION_PAT fails with a named error" {
  git remote set-url origin https://github.com/example/example.git
  unset GH_AUTOMATION_PAT
  run bash "$SCRIPT" v1.0.0
  [ "$status" -eq 1 ]
  [[ "$output" =~ "::error::GH_AUTOMATION_PAT is required to push tags to https://github.com/example/example.git" ]]
  [ "$(git -C "$ORIGIN" tag -l v1.0.0)" = "" ]
}
