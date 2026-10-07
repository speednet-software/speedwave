#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/check-version-pinned.py"


@test "real repo passes once every tracked file is pinned to 0.0.0" {
  run python3 "$SCRIPT" "$REPO_ROOT"
  [ "$status" -eq 0 ]
}


@test "standalone speedwave-version Cargo.toml not pinned to 0.0.0 detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"
  _seed_pinned_fixture "$fixture_root"

  mkdir -p "$fixture_root/crates/speedwave-version"
  printf '[package]\nname = "speedwave-version"\nversion = "9.9.9"\n' \
    > "$fixture_root/crates/speedwave-version/Cargo.toml"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "speedwave-version/Cargo.toml" ]]
  [[ "$output" =~ "not pinned to 0.0.0" ]]
}


@test "standalone speedwave-version Cargo.toml is skipped when absent from a fixture root" {
  local fixture_root
  fixture_root="$(mktemp -d)"
  _seed_pinned_fixture "$fixture_root"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -eq 0 ]
}


@test "Cargo.toml version not pinned to 0.0.0 detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"
  _seed_pinned_fixture "$fixture_root"

  printf '[package]\nname = "speedwave-runtime"\nversion = "9.9.9"\n' \
    > "$fixture_root/crates/speedwave-runtime/Cargo.toml"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "speedwave-runtime/Cargo.toml" ]]
  [[ "$output" =~ "not pinned to 0.0.0" ]]
}


@test "package.json version not pinned to 0.0.0 detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"
  _seed_pinned_fixture "$fixture_root"

  printf '{"name": "hub", "version": "9.9.9"}\n' \
    > "$fixture_root/mcp-servers/hub/package.json"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "mcp-servers/hub/package.json" ]]
  [[ "$output" =~ "not pinned to 0.0.0" ]]
}


@test "missing Cargo.toml glob target fails with 'no matches for glob' message" {
  local fixture_root
  fixture_root="$(mktemp -d)"
  _seed_pinned_fixture "$fixture_root"
  rm -f "$fixture_root/crates/speedwave-cli/Cargo.toml"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "no matches for glob" ]]
  [[ "$output" =~ "speedwave-cli" ]]
}


@test "empty version string in Cargo.toml fails with file name" {
  local fixture_root
  fixture_root="$(mktemp -d)"
  _seed_pinned_fixture "$fixture_root"

  printf '[package]\nname = "speedwave-runtime"\nversion = ""\n' \
    > "$fixture_root/crates/speedwave-runtime/Cargo.toml"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Cargo.toml" ]]
  [[ "$output" =~ "empty version" ]]
}


@test "generic plist pinned to 0.0.0 passes" {
  local fixture_root
  fixture_root="$(mktemp -d)"
  _seed_pinned_fixture "$fixture_root"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -eq 0 ]
}

@test "generic plist version not pinned to 0.0.0 detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"
  _seed_pinned_fixture "$fixture_root"

  printf '<string>9.9.8</string> <!-- x-release-please-version -->\n' \
    > "$fixture_root/native/macos/calendar/Resources/Info.plist"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Info.plist" ]]
  [[ "$output" =~ "not pinned to 0.0.0" ]]
}

@test "generic plist missing marker detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"
  _seed_pinned_fixture "$fixture_root"

  printf '<string>0.0.0</string>\n' \
    > "$fixture_root/native/macos/calendar/Resources/Info.plist"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "marker" ]]
}

@test "generic plist superstring of 0.0.0 detected (exact match)" {
  local fixture_root
  fixture_root="$(mktemp -d)"
  _seed_pinned_fixture "$fixture_root"

  printf '<string>10.0.0</string> <!-- x-release-please-version -->\n' \
    > "$fixture_root/native/macos/calendar/Resources/Info.plist"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "10.0.0" ]]
}


@test "generic plist file missing causes read error" {
  local fixture_root
  fixture_root="$(mktemp -d)"
  _seed_pinned_fixture "$fixture_root"
  rm -f "$fixture_root/native/macos/calendar/Resources/Info.plist"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Info.plist" ]]
}


@test "generic plist marker without string tag causes extraction error" {
  local fixture_root
  fixture_root="$(mktemp -d)"
  _seed_pinned_fixture "$fixture_root"

  printf '9.9.9 <!-- x-release-please-version -->\n' \
    > "$fixture_root/native/macos/calendar/Resources/Info.plist"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Info.plist" ]]
}


@test "tauri.conf.json version not pinned to 0.0.0 detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"
  _seed_pinned_fixture "$fixture_root"

  printf '{"version": "9.9.9"}\n' > "$fixture_root/desktop/src-tauri/tauri.conf.json"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "tauri.conf.json" ]]
  [[ "$output" =~ "not pinned to 0.0.0" ]]
}


# Seeds a fixture root with every file the script hardcodes, all pinned to
# 0.0.0, so a single test can mutate one file and still get a clean baseline
# for every other pinned source.
_seed_pinned_fixture() {
  local root="$1"

  local json_files=(
    package.json
    desktop/src/package.json
    desktop/src-tauri/tauri.conf.json
    desktop/src/package-lock.json
    mcp-servers/hub/package.json
    mcp-servers/shared/package.json
    mcp-servers/policies/package.json
    mcp-servers/slack/package.json
    mcp-servers/sharepoint/package.json
    mcp-servers/redmine/package.json
    mcp-servers/gitlab/package.json
    mcp-servers/github/package.json
    mcp-servers/atlassian/package.json
    mcp-servers/office/package.json
    mcp-servers/os/package.json
    mcp-servers/oauth/package.json
    mcp-servers/context7/package.json
    mcp-servers/playwright/package.json
  )
  for f in "${json_files[@]}"; do
    mkdir -p "$root/$(dirname "$f")"
    printf '{"version": "0.0.0"}\n' > "$root/$f"
  done

  local toml_files=(
    crates/speedwave-runtime/Cargo.toml
    crates/speedwave-cli/Cargo.toml
    desktop/src-tauri/Cargo.toml
  )
  for f in "${toml_files[@]}"; do
    mkdir -p "$root/$(dirname "$f")"
    printf '[package]\nname = "x"\nversion = "0.0.0"\n' > "$root/$f"
  done

  local plist_files=(
    native/macos/calendar/Resources/Info.plist
    native/macos/reminders/Resources/Info.plist
    native/macos/mail/Resources/Info.plist
    native/macos/notes/Resources/Info.plist
    native/macos/audio-capture/Resources/Info.plist
  )
  for f in "${plist_files[@]}"; do
    mkdir -p "$root/$(dirname "$f")"
    printf '<string>0.0.0</string> <!-- x-release-please-version -->\n' > "$root/$f"
  done
}
