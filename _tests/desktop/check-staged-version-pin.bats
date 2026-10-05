#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

_init_fixture_repo() {
  local dir="$1"
  git -C "$dir" init -q -b dev
  git -C "$dir" config user.email "t@t"
  git -C "$dir" config user.name "t"
  cat > "$dir/release-please-config.json" <<'JSON'
{
  "packages": {
    ".": {
      "extra-files": [
        {"type": "toml", "path": "crates/fake/Cargo.toml"}
      ]
    }
  }
}
JSON
  printf '{".": "0.0.0"}\n' > "$dir/.release-please-manifest.json"
  mkdir -p "$dir/crates/fake"
  printf '[package]\nname = "fake"\nversion = "0.0.0"\n' > "$dir/crates/fake/Cargo.toml"
  mkdir -p "$dir/scripts"
  cp "$REPO_ROOT/scripts/check-version-pinned.py" "$dir/scripts/check-version-pinned.py"
  cp "$REPO_ROOT/scripts/check-staged-version-pin.sh" "$dir/scripts/check-staged-version-pin.sh"
  chmod +x "$dir/scripts/check-staged-version-pin.sh"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m init
}

@test "the bash parser is gone — the hook is a thin python3 call" {
  grep -qF "check-version-pinned.py" "$REPO_ROOT/scripts/check-staged-version-pin.sh"
  grep -qF -- "--staged" "$REPO_ROOT/scripts/check-staged-version-pin.sh"
  ! grep -qE "extract_toml_version|extract_generic_version" "$REPO_ROOT/scripts/check-staged-version-pin.sh"
}

@test "hook passes when nothing is staged" {
  local dir
  dir="$(mktemp -d)"
  _init_fixture_repo "$dir"

  run bash "$dir/scripts/check-staged-version-pin.sh"
  [ "$status" -eq 0 ]
  rm -rf "$dir"
}

@test "hook passes when a staged tracked file stays pinned to 0.0.0" {
  local dir
  dir="$(mktemp -d)"
  _init_fixture_repo "$dir"
  printf '[package]\nname = "fake"\nversion = "0.0.0"\nedition = "2021"\n' \
    > "$dir/crates/fake/Cargo.toml"
  git -C "$dir" add crates/fake/Cargo.toml

  run bash "$dir/scripts/check-staged-version-pin.sh"
  [ "$status" -eq 0 ]
  rm -rf "$dir"
}

@test "hook rejects a staged tracked file moved away from 0.0.0" {
  local dir
  dir="$(mktemp -d)"
  _init_fixture_repo "$dir"
  printf '[package]\nname = "fake"\nversion = "9.9.9"\n' > "$dir/crates/fake/Cargo.toml"
  git -C "$dir" add crates/fake/Cargo.toml

  run bash "$dir/scripts/check-staged-version-pin.sh"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Cargo.toml" ]]
  [[ "$output" =~ "not pinned to 0.0.0" ]]
  rm -rf "$dir"
}

@test "hook ignores an unstaged working-tree change to a tracked file" {
  local dir
  dir="$(mktemp -d)"
  _init_fixture_repo "$dir"
  printf '[package]\nname = "fake"\nversion = "9.9.9"\n' > "$dir/crates/fake/Cargo.toml"

  run bash "$dir/scripts/check-staged-version-pin.sh"
  [ "$status" -eq 0 ]
  rm -rf "$dir"
}

@test "hook rejects a staged manifest root version moved away from 0.0.0" {
  local dir
  dir="$(mktemp -d)"
  _init_fixture_repo "$dir"
  printf '{".": "9.9.9"}\n' > "$dir/.release-please-manifest.json"
  git -C "$dir" add .release-please-manifest.json

  run bash "$dir/scripts/check-staged-version-pin.sh"
  [ "$status" -ne 0 ]
  [[ "$output" =~ ".release-please-manifest.json" ]]
  rm -rf "$dir"
}

@test "hook covers crates/speedwave-version/Cargo.toml when staged" {
  local dir
  dir="$(mktemp -d)"
  _init_fixture_repo "$dir"
  mkdir -p "$dir/crates/speedwave-version"
  printf '[package]\nname = "speedwave-version"\nversion = "9.9.9"\n' \
    > "$dir/crates/speedwave-version/Cargo.toml"
  git -C "$dir" add crates/speedwave-version/Cargo.toml

  run bash "$dir/scripts/check-staged-version-pin.sh"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "speedwave-version/Cargo.toml" ]]
  [[ "$output" =~ "not pinned to 0.0.0" ]]
  rm -rf "$dir"
}
