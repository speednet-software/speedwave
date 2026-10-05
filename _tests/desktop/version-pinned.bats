#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
FIXTURES="$REPO_ROOT/_tests/desktop/fixtures/version-consistency"
SCRIPT="$REPO_ROOT/scripts/check-version-pinned.py"

_write_toml_config() {
  local dest="$1" path="$2"
  cat > "$dest/release-please-config.json" <<JSON
{
  "packages": {
    ".": {
      "extra-files": [
        {"type": "toml", "path": "${path}"}
      ]
    }
  }
}
JSON
}

_write_string_config() {
  local dest="$1" path="$2"
  cat > "$dest/release-please-config.json" <<JSON
{
  "packages": {
    ".": {
      "extra-files": [
        "${path}"
      ]
    }
  }
}
JSON
}

_write_generic_config() {
  local dest="$1" path="$2"
  cat > "$dest/release-please-config.json" <<JSON
{
  "packages": {
    ".": {
      "extra-files": [
        {"type": "generic", "path": "${path}"}
      ]
    }
  }
}
JSON
}


@test "real repo passes once every tracked file is pinned to 0.0.0" {
  run python3 "$SCRIPT" "$REPO_ROOT"
  [ "$status" -eq 0 ]
}


@test "standalone speedwave-version Cargo.toml not pinned to 0.0.0 detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  printf '{"packages":{".":{"extra-files":[]}}}\n' > "$fixture_root/release-please-config.json"
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

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  printf '{"packages":{".":{"extra-files":[]}}}\n' > "$fixture_root/release-please-config.json"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -eq 0 ]
}


@test "Cargo.toml version not pinned to 0.0.0 detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_toml_config "$fixture_root" "crates/speedwave-runtime/Cargo.toml"
  mkdir -p "$fixture_root/crates/speedwave-runtime"
  cp "$FIXTURES/Cargo.toml.fixture.mismatched" "$fixture_root/crates/speedwave-runtime/Cargo.toml"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Cargo.toml" ]]
  [[ "$output" =~ "not pinned to 0.0.0" ]]
}


@test "package.json version not pinned to 0.0.0 detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_string_config "$fixture_root" "mcp-servers/hub/package.json"
  mkdir -p "$fixture_root/mcp-servers/hub"
  cp "$FIXTURES/package.fixture.mismatched.json" "$fixture_root/mcp-servers/hub/package.json"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "package.json" ]]
  [[ "$output" =~ "not pinned to 0.0.0" ]]
}


@test "empty glob fails with 'no matches for glob' message" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_toml_config "$fixture_root" "crates/nonexistent-crate/Cargo.toml"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "no matches for glob" ]]
}


@test "empty version string in Cargo.toml fails with file name" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_toml_config "$fixture_root" "crates/test-crate/Cargo.toml"
  mkdir -p "$fixture_root/crates/test-crate"
  printf '[package]\nname = "test-crate"\nversion = ""\n' > "$fixture_root/crates/test-crate/Cargo.toml"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Cargo.toml" ]]
  [[ "$output" =~ "empty version" ]]
}


@test "generic plist pinned to 0.0.0 passes" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_generic_config "$fixture_root" "native/macos/x/Resources/Info.plist"
  mkdir -p "$fixture_root/native/macos/x/Resources"
  printf '<string>0.0.0</string> <!-- x-release-please-version -->\n' \
    > "$fixture_root/native/macos/x/Resources/Info.plist"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -eq 0 ]
}

@test "generic plist version not pinned to 0.0.0 detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_generic_config "$fixture_root" "native/macos/x/Resources/Info.plist"
  mkdir -p "$fixture_root/native/macos/x/Resources"
  printf '<string>9.9.8</string> <!-- x-release-please-version -->\n' \
    > "$fixture_root/native/macos/x/Resources/Info.plist"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Info.plist" ]]
  [[ "$output" =~ "not pinned to 0.0.0" ]]
}

@test "generic plist missing marker detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_generic_config "$fixture_root" "native/macos/x/Resources/Info.plist"
  mkdir -p "$fixture_root/native/macos/x/Resources"
  printf '<string>9.9.9</string>\n' \
    > "$fixture_root/native/macos/x/Resources/Info.plist"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "marker" ]]
}

@test "generic plist superstring of 0.0.0 detected (exact match)" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_generic_config "$fixture_root" "native/macos/x/Resources/Info.plist"
  mkdir -p "$fixture_root/native/macos/x/Resources"
  printf '<string>10.0.0</string> <!-- x-release-please-version -->\n' \
    > "$fixture_root/native/macos/x/Resources/Info.plist"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "10.0.0" ]]
}


@test "generic plist file missing causes read error" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_generic_config "$fixture_root" "native/macos/x/Resources/Info.plist"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Info.plist" ]]
}


@test "generic plist marker without string tag causes extraction error" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_generic_config "$fixture_root" "native/macos/x/Resources/Info.plist"
  mkdir -p "$fixture_root/native/macos/x/Resources"
  printf '9.9.9 <!-- x-release-please-version -->\n' \
    > "$fixture_root/native/macos/x/Resources/Info.plist"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Info.plist" ]]
}


@test "unsupported extra-file type is reported" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  cat > "$fixture_root/release-please-config.json" <<'JSON'
{"packages":{".":{"extra-files":[{"type":"xml","path":"some/file.xml"}]}}}
JSON

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "unsupported extra-file type" ]]
}


@test "manifest root version not pinned to 0.0.0 detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  printf '{".": "9.9.9"}\n' > "$fixture_root/.release-please-manifest.json"
  printf '{"packages":{".":{"extra-files":[]}}}\n' > "$fixture_root/release-please-config.json"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ ".release-please-manifest.json" ]]
  [[ "$output" =~ "not pinned to 0.0.0" ]]
}
