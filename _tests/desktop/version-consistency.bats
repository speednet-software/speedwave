#!/usr/bin/env bats
# Verifies that every version-bearing file listed in release-please-config.json
# agrees with .release-please-manifest.json["."].
#
# Set REPO_ROOT_OVERRIDE to redirect all file resolution to a test fixture tree
# instead of the real repo root.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
FIXTURES="$REPO_ROOT/_tests/desktop/fixtures/version-consistency"

get_root() {
  echo "${REPO_ROOT_OVERRIDE:-$REPO_ROOT}"
}

# ── Happy path ──────────────────────────────────────────────────────────────

@test "all version files match .release-please-manifest.json (real repo)" {
  run python3 - "$(get_root)" <<'PY'
import json, sys, re, pathlib

root = pathlib.Path(sys.argv[1])
manifest_path = root / ".release-please-manifest.json"
config_path = root / "release-please-config.json"

with open(manifest_path) as f:
    manifest = json.load(f)
expected = manifest["."]

with open(config_path) as f:
    config = json.load(f)

extra_files = config["packages"]["."]["extra-files"]

errors = []

for entry in extra_files:
    if isinstance(entry, str):
        path = root / entry
        try:
            with open(path) as f:
                data = json.load(f)
        except Exception as e:
            errors.append(f"{path}: failed to parse JSON: {e}")
            continue
        actual = data.get("version", "")
        if actual != expected:
            errors.append(f"{path}: version '{actual}' != manifest '{expected}'")
    elif isinstance(entry, dict) and entry.get("type") == "toml":
        pattern = entry["path"]
        matches = list(root.glob(pattern))
        if not matches:
            errors.append(f"no matches for glob: {pattern}")
            continue
        for toml_path in matches:
            try:
                content = toml_path.read_text()
            except Exception as e:
                errors.append(f"{toml_path}: read error: {e}")
                continue
            # Extract version from [package] section using regex (works on Python < 3.11)
            pkg_section = re.search(r'\[package\](.*?)(?:\n\[|\Z)', content, re.DOTALL)
            if not pkg_section:
                errors.append(f"{toml_path}: no [package] section found")
                continue
            m = re.search(r'^version\s*=\s*"([^"]*)"', pkg_section.group(1), re.MULTILINE)
            if not m:
                errors.append(f"{toml_path}: no version field in [package]")
                continue
            actual = m.group(1)
            if not actual:
                errors.append(f"{toml_path}: empty version string")
                continue
            if actual != expected:
                errors.append(f"{toml_path}: version '{actual}' != manifest '{expected}'")

# Also check tauri.conf.json explicitly (it is in extra-files as a plain string, covered above)

if errors:
    for e in errors:
        print(e, file=sys.stderr)
    sys.exit(1)
PY
  [ "$status" -eq 0 ]
}

# ── Error: Cargo.toml version mismatch ───────────────────────────────────────

@test "Cargo.toml version mismatch detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  # Lay out fixture tree from checked-in fixtures:
  # manifest says 9.9.9; config points at crates/speedwave-runtime/Cargo.toml;
  # the mismatched Cargo.toml has version 9.9.8.
  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  cat > "$fixture_root/release-please-config.json" <<'JSON'
{
  "packages": {
    ".": {
      "extra-files": [
        {"type": "toml", "path": "crates/speedwave-runtime/Cargo.toml"}
      ]
    }
  }
}
JSON
  mkdir -p "$fixture_root/crates/speedwave-runtime"
  cp "$FIXTURES/Cargo.toml.fixture.mismatched" "$fixture_root/crates/speedwave-runtime/Cargo.toml"

  REPO_ROOT_OVERRIDE="$fixture_root" run python3 - "$fixture_root" <<'PY'
import json, sys, re, pathlib

root = pathlib.Path(sys.argv[1])
manifest_path = root / ".release-please-manifest.json"
config_path = root / "release-please-config.json"

with open(manifest_path) as f:
    manifest = json.load(f)
expected = manifest["."]

with open(config_path) as f:
    config = json.load(f)

extra_files = config["packages"]["."]["extra-files"]
errors = []

for entry in extra_files:
    if isinstance(entry, dict) and entry.get("type") == "toml":
        pattern = entry["path"]
        matches = list(root.glob(pattern))
        if not matches:
            errors.append(f"no matches for glob: {pattern}")
            continue
        for toml_path in matches:
            content = toml_path.read_text()
            pkg_section = re.search(r'\[package\](.*?)(?:\n\[|\Z)', content, re.DOTALL)
            if not pkg_section:
                errors.append(f"{toml_path}: no [package] section found")
                continue
            m = re.search(r'^version\s*=\s*"([^"]*)"', pkg_section.group(1), re.MULTILINE)
            if not m:
                errors.append(f"{toml_path}: no version field in [package]")
                continue
            actual = m.group(1)
            if not actual:
                errors.append(f"{toml_path}: empty version string")
                continue
            if actual != expected:
                errors.append(f"{toml_path}: version '{actual}' != manifest '{expected}'")

if errors:
    for e in errors:
        print(e, file=sys.stderr)
    sys.exit(1)
PY

  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Cargo.toml" ]]
}

# ── Error: package.json version mismatch ─────────────────────────────────────

@test "package.json version mismatch detected" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  # Lay out fixture tree from checked-in fixtures:
  # manifest says 9.9.9; config points at mcp-servers/hub/package.json;
  # the mismatched package.json has version 9.9.8.
  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  cat > "$fixture_root/release-please-config.json" <<'JSON'
{
  "packages": {
    ".": {
      "extra-files": [
        "mcp-servers/hub/package.json"
      ]
    }
  }
}
JSON
  mkdir -p "$fixture_root/mcp-servers/hub"
  cp "$FIXTURES/package.fixture.mismatched.json" "$fixture_root/mcp-servers/hub/package.json"

  REPO_ROOT_OVERRIDE="$fixture_root" run python3 - "$fixture_root" <<'PY'
import json, sys, pathlib

root = pathlib.Path(sys.argv[1])
with open(root / ".release-please-manifest.json") as f:
    expected = json.load(f)["."]
with open(root / "release-please-config.json") as f:
    config = json.load(f)

errors = []
for entry in config["packages"]["."]["extra-files"]:
    if isinstance(entry, str):
        path = root / entry
        try:
            with open(path) as f:
                data = json.load(f)
        except Exception as e:
            errors.append(f"{path}: failed to parse JSON: {e}")
            continue
        actual = data.get("version", "")
        if actual != expected:
            errors.append(f"{path}: version '{actual}' != manifest '{expected}'")

if errors:
    for e in errors:
        print(e, file=sys.stderr)
    sys.exit(1)
PY

  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "package.json" ]]
}

# ── Edge: glob with zero matches fails explicitly ────────────────────────────

@test "empty glob fails with 'no matches for glob' message" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  # Lay out fixture tree: manifest says 9.9.9; config points at a glob that
  # matches nothing in the empty fixture dir.
  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  cat > "$fixture_root/release-please-config.json" <<'JSON'
{
  "packages": {
    ".": {
      "extra-files": [
        {"type": "toml", "path": "crates/nonexistent-crate/Cargo.toml"}
      ]
    }
  }
}
JSON

  REPO_ROOT_OVERRIDE="$fixture_root" run python3 - "$fixture_root" <<'PY'
import json, sys, re, pathlib

root = pathlib.Path(sys.argv[1])
with open(root / ".release-please-manifest.json") as f:
    expected = json.load(f)["."]
with open(root / "release-please-config.json") as f:
    config = json.load(f)

errors = []
for entry in config["packages"]["."]["extra-files"]:
    if isinstance(entry, dict) and entry.get("type") == "toml":
        pattern = entry["path"]
        matches = list(root.glob(pattern))
        if not matches:
            errors.append(f"no matches for glob: {pattern}")

if errors:
    for e in errors:
        print(e, file=sys.stderr)
    sys.exit(1)
PY

  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "no matches for glob" ]]
}

# ── Boundary: empty version string fails ─────────────────────────────────────

@test "empty version string in Cargo.toml fails with file name" {
  local fixture_root
  fixture_root="$(mktemp -d)"

  # Lay out fixture tree: manifest says 9.9.9; config points at a Cargo.toml
  # that has an empty version string (checked-in fixture has version = "").
  cp "$FIXTURES/release-please-manifest.fixture.json" "$fixture_root/.release-please-manifest.json"
  cat > "$fixture_root/release-please-config.json" <<'JSON'
{
  "packages": {
    ".": {
      "extra-files": [
        {"type": "toml", "path": "crates/test-crate/Cargo.toml"}
      ]
    }
  }
}
JSON
  mkdir -p "$fixture_root/crates/test-crate"
  printf '[package]\nname = "test-crate"\nversion = ""\n' > "$fixture_root/crates/test-crate/Cargo.toml"

  REPO_ROOT_OVERRIDE="$fixture_root" run python3 - "$fixture_root" <<'PY'
import json, sys, re, pathlib

root = pathlib.Path(sys.argv[1])
with open(root / ".release-please-manifest.json") as f:
    expected = json.load(f)["."]
with open(root / "release-please-config.json") as f:
    config = json.load(f)

errors = []
for entry in config["packages"]["."]["extra-files"]:
    if isinstance(entry, dict) and entry.get("type") == "toml":
        pattern = entry["path"]
        matches = list(root.glob(pattern))
        if not matches:
            errors.append(f"no matches for glob: {pattern}")
            continue
        for toml_path in matches:
            content = toml_path.read_text()
            pkg_section = re.search(r'\[package\](.*?)(?:\n\[|\Z)', content, re.DOTALL)
            if not pkg_section:
                errors.append(f"{toml_path}: no [package] section found")
                continue
            m = re.search(r'^version\s*=\s*"([^"]*)"', pkg_section.group(1), re.MULTILINE)
            if not m:
                errors.append(f"{toml_path}: no version field in [package]")
                continue
            actual = m.group(1)
            if not actual:
                errors.append(f"{toml_path}: empty version string")
                continue
            if actual != expected:
                errors.append(f"{toml_path}: version '{actual}' != manifest '{expected}'")

if errors:
    for e in errors:
        print(e, file=sys.stderr)
    sys.exit(1)
PY

  rm -rf "$fixture_root"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "Cargo.toml" ]]
  [[ "$output" =~ "empty version" ]]
}
