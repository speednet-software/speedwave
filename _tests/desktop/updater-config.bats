#!/usr/bin/env bats
# Static validation of critical updater config fields in tauri.conf.json.
# Each test runs against the real file (expect PASS) and against a matching
# fixture (expect FAIL with asserted stderr substring).
#
# Set TAURI_CONF_OVERRIDE to use a different config file.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
REAL_CONF="$REPO_ROOT/desktop/src-tauri/tauri.conf.json"
UPDATER_RS="$REPO_ROOT/desktop/src-tauri/src/updater.rs"
FIXTURES="$REPO_ROOT/_tests/desktop/fixtures"

conf_file() {
  echo "${TAURI_CONF_OVERRIDE:-$REAL_CONF}"
}

# ── Test 1: bundle.createUpdaterArtifacts ───────────────────────────────────

@test "bundle.createUpdaterArtifacts equals v1Compatible (real file)" {
  run python3 - "$(conf_file)" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    c = json.load(f)
val = c.get("bundle", {}).get("createUpdaterArtifacts")
if val != "v1Compatible":
    sys.exit(f"bundle.createUpdaterArtifacts is {val!r}, expected 'v1Compatible'")
PY
  [ "$status" -eq 0 ]
}

@test "bundle.createUpdaterArtifacts equals v1Compatible (fixture: missing)" {
  run python3 - "$FIXTURES/tauri.conf.missing-updater-artifacts.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    c = json.load(f)
val = c.get("bundle", {}).get("createUpdaterArtifacts")
if val != "v1Compatible":
    sys.exit(f"bundle.createUpdaterArtifacts is {val!r}, expected 'v1Compatible'")
PY
  [ "$status" -ne 0 ]
  [[ "$output" =~ "createUpdaterArtifacts" ]]
}

# ── Test 2: plugins.updater.endpoints non-empty and starts with https:// ───

@test "plugins.updater.endpoints non-empty and first starts with https:// (real file)" {
  run python3 - "$(conf_file)" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    c = json.load(f)
eps = c.get("plugins", {}).get("updater", {}).get("endpoints", [])
if not eps:
    sys.exit("plugins.updater.endpoints is empty")
if not eps[0].startswith("https://"):
    sys.exit(f"endpoints[0] does not start with https://: {eps[0]!r}")
PY
  [ "$status" -eq 0 ]
}

@test "plugins.updater.endpoints non-empty and first starts with https:// (fixture: empty)" {
  run python3 - "$FIXTURES/tauri.conf.empty-endpoints.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    c = json.load(f)
eps = c.get("plugins", {}).get("updater", {}).get("endpoints", [])
if not eps:
    sys.exit("plugins.updater.endpoints is empty")
if not eps[0].startswith("https://"):
    sys.exit(f"endpoints[0] does not start with https://: {eps[0]!r}")
PY
  [ "$status" -ne 0 ]
  [[ "$output" =~ "endpoints" ]]
}

# ── Test 3: pubkey non-empty, base64-decodable, begins with minisign header ─

@test "plugins.updater.pubkey is valid minisign public key (real file)" {
  run python3 - "$(conf_file)" <<'PY'
import json, sys, base64
with open(sys.argv[1]) as f:
    c = json.load(f)
pubkey = c.get("plugins", {}).get("updater", {}).get("pubkey", "")
if not pubkey:
    sys.exit("plugins.updater.pubkey is empty")
try:
    decoded = base64.b64decode(pubkey)
except Exception as e:
    sys.exit(f"pubkey is not valid base64: {e}")
expected_header = b"untrusted comment: minisign public key:"
if not decoded.startswith(expected_header):
    sys.exit(f"pubkey decoded bytes do not begin with minisign header")
PY
  [ "$status" -eq 0 ]
}

@test "plugins.updater.pubkey is valid minisign public key (fixture: bad pubkey)" {
  run python3 - "$FIXTURES/tauri.conf.bad-pubkey.json" <<'PY'
import json, sys, base64
with open(sys.argv[1]) as f:
    c = json.load(f)
pubkey = c.get("plugins", {}).get("updater", {}).get("pubkey", "")
if not pubkey:
    sys.exit("plugins.updater.pubkey is empty")
try:
    decoded = base64.b64decode(pubkey)
except Exception as e:
    sys.exit(f"pubkey is not valid base64: {e}")
expected_header = b"untrusted comment: minisign public key:"
if not decoded.startswith(expected_header):
    sys.exit(f"pubkey decoded bytes do not begin with minisign header")
PY
  [ "$status" -ne 0 ]
  [[ "$output" =~ "minisign" ]]
}

# ── Test 4: endpoints[0] equals STABLE_ENDPOINT from updater.rs ─────────────

@test "endpoints[0] equals STABLE_ENDPOINT from updater.rs (real file)" {
  run python3 - "$(conf_file)" "$UPDATER_RS" <<'PY'
import json, sys, re
conf_path, rs_path = sys.argv[1], sys.argv[2]
with open(rs_path) as f:
    content = f.read()
matches = re.findall(r'^const STABLE_ENDPOINT:\s*&str\s*=\s*"([^"]+)"', content, re.MULTILINE)
if len(matches) == 0:
    sys.exit("STABLE_ENDPOINT not found in updater.rs — renamed or removed?")
if len(matches) > 1:
    sys.exit(f"STABLE_ENDPOINT defined {len(matches)} times in updater.rs — duplicate?")
stable = matches[0]
with open(conf_path) as f:
    c = json.load(f)
eps = c.get("plugins", {}).get("updater", {}).get("endpoints", [])
if not eps:
    sys.exit("endpoints is empty")
if eps[0] != stable:
    sys.exit(f"endpoints[0] {eps[0]!r} != STABLE_ENDPOINT {stable!r}")
PY
  [ "$status" -eq 0 ]
}

@test "endpoints[0] equals STABLE_ENDPOINT from updater.rs (fixture: wrong endpoint)" {
  run python3 - "$FIXTURES/tauri.conf.wrong-endpoint.json" "$UPDATER_RS" <<'PY'
import json, sys, re
conf_path, rs_path = sys.argv[1], sys.argv[2]
with open(rs_path) as f:
    content = f.read()
matches = re.findall(r'^const STABLE_ENDPOINT:\s*&str\s*=\s*"([^"]+)"', content, re.MULTILINE)
if len(matches) == 0:
    sys.exit("STABLE_ENDPOINT not found in updater.rs — renamed or removed?")
if len(matches) > 1:
    sys.exit(f"STABLE_ENDPOINT defined {len(matches)} times in updater.rs — duplicate?")
stable = matches[0]
with open(conf_path) as f:
    c = json.load(f)
eps = c.get("plugins", {}).get("updater", {}).get("endpoints", [])
if not eps:
    sys.exit("endpoints is empty")
if eps[0] != stable:
    sys.exit(f"endpoints[0] {eps[0]!r} != STABLE_ENDPOINT {stable!r}")
PY
  [ "$status" -ne 0 ]
  [[ "$output" =~ "STABLE_ENDPOINT" ]]
}

# ── Test 5: bundle.targets contains all required targets ────────────────────

@test "bundle.targets contains deb nsis msi app dmg (real file)" {
  run python3 - "$(conf_file)" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    c = json.load(f)
targets = c.get("bundle", {}).get("targets", [])
required = {"deb", "nsis", "msi", "app", "dmg"}
missing = required - set(targets)
if missing:
    sys.exit(f"bundle.targets missing: {sorted(missing)}")
PY
  [ "$status" -eq 0 ]
}

@test "bundle.targets contains deb nsis msi app dmg (fixture: missing dmg)" {
  run python3 - "$FIXTURES/tauri.conf.missing-dmg.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    c = json.load(f)
targets = c.get("bundle", {}).get("targets", [])
required = {"deb", "nsis", "msi", "app", "dmg"}
missing = required - set(targets)
if missing:
    sys.exit(f"bundle.targets missing: {sorted(missing)}")
PY
  [ "$status" -ne 0 ]
  [[ "$output" =~ "dmg" ]]
}
