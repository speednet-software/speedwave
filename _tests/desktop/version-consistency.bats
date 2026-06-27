#!/usr/bin/env bats
# Verifies that every version-bearing file listed in release-please-config.json
# agrees with .release-please-manifest.json["."].

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
FIXTURES="$REPO_ROOT/_tests/desktop/fixtures/version-consistency"
SCRIPT="$REPO_ROOT/scripts/check-version-consistency.py"

# Minimal release-please-config with a single toml extra-file at the given path.
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

# Minimal release-please-config with a single plain string extra-file.
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

# Minimal release-please-config with a single generic (plist) extra-file.
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

# ── Happy path ──────────────────────────────────────────────────────────────

@test "all version files match .release-please-manifest.json (real repo)" {
  run python3 "$SCRIPT" "$REPO_ROOT"
  [ "$status" -eq 0 ]
}

# ── Error: Cargo.toml version mismatch ───────────────────────────────────────

@test "Cargo.toml version mismatch detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  # manifest says 9.9.9; Cargo.toml fixture has 9.9.8.
  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_toml_config "$fixture_root" "crates/speedwave-runtime/Cargo.toml"
  mkdir -p "$fixture_root/crates/speedwave-runtime"
  cp "$FIXTURES/Cargo.toml.fixture.mismatched" "$fixture_root/crates/speedwave-runtime/Cargo.toml"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Cargo.toml" ]]
}

# ── Error: package.json version mismatch ─────────────────────────────────────

@test "package.json version mismatch detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  # manifest says 9.9.9; package.json fixture has 9.9.8.
  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_string_config "$fixture_root" "mcp-servers/hub/package.json"
  mkdir -p "$fixture_root/mcp-servers/hub"
  cp "$FIXTURES/package.fixture.mismatched.json" "$fixture_root/mcp-servers/hub/package.json"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "package.json" ]]
}

# ── Edge: glob with zero matches fails explicitly ────────────────────────────

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

# ── Boundary: empty version string fails ─────────────────────────────────────

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

# ── Generic (Info.plist) marker coverage ─────────────────────────────────────

@test "generic plist matching version passes" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_generic_config "$fixture_root" "native/macos/x/Resources/Info.plist"
  mkdir -p "$fixture_root/native/macos/x/Resources"
  printf '<string>9.9.9</string> <!-- x-release-please-version -->\n' \
    > "$fixture_root/native/macos/x/Resources/Info.plist"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -eq 0 ]
}

@test "generic plist mismatched version detected" {
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

# A superstring of the expected version must NOT pass (exact, not substring).
@test "generic plist superstring version detected (exact match)" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  # manifest 9.9.9; plist 19.9.9 contains "9.9.9" as a substring.
  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_generic_config "$fixture_root" "native/macos/x/Resources/Info.plist"
  mkdir -p "$fixture_root/native/macos/x/Resources"
  printf '<string>19.9.9</string> <!-- x-release-please-version -->\n' \
    > "$fixture_root/native/macos/x/Resources/Info.plist"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "19.9.9" ]]
}

# ── Error: generic plist cannot be read (missing file) ───────────────────────

@test "generic plist file missing causes read error" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_generic_config "$fixture_root" "native/macos/x/Resources/Info.plist"
  # Intentionally do NOT create the plist file.

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Info.plist" ]]
}

# ── Error: generic plist marker line has no <string>…</string> ───────────────

@test "generic plist marker without string tag causes extraction error" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  _write_generic_config "$fixture_root" "native/macos/x/Resources/Info.plist"
  mkdir -p "$fixture_root/native/macos/x/Resources"
  # Marker present but no <string>…</string> on that line.
  printf '9.9.9 <!-- x-release-please-version -->\n' \
    > "$fixture_root/native/macos/x/Resources/Info.plist"

  run python3 "$SCRIPT" "$fixture_root"
  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Info.plist" ]]
}

# ── Unknown extra-file type must fail loudly (not be silently skipped) ────────

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
