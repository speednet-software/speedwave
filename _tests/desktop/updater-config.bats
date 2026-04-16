#!/usr/bin/env bats
# Static checks on desktop/src-tauri/tauri.conf.json and updater.rs to prevent
# silent regressions in the Tauri updater pipeline. See issue #26.
#
# The original silent-update-break (fixed before this file existed) was caused
# by missing `bundle.createUpdaterArtifacts` in tauri.conf.json — tauri-action
# built per-bundle .sig files but skipped the updater archives and latest.json.
# The createUpdaterArtifacts test plus the release-time check in
# desktop-release.yml (publish-release) both guard against that specific regression.
#
# Runtime SSOT for the update endpoint is `STABLE_ENDPOINT` in updater.rs.
# The endpoint-match test asserts the JSON value in tauri.conf.json matches it
# (anti-drift for documentation-level metadata — JSON is NOT the runtime endpoint).
#
# Version SSOT is `.release-please-manifest.json["."]`. The manifest test
# enforces that every extra-file listed in release-please-config.json equals it.
#
# This file runs under `make test-desktop-build` via the `desktop` CI job.

setup() {
    command -v python3 >/dev/null 2>&1 || skip "python3 is required for updater-config.bats"
    export TAURI_CONF="$BATS_TEST_DIRNAME/../../desktop/src-tauri/tauri.conf.json"
    export UPDATER_RS="$BATS_TEST_DIRNAME/../../desktop/src-tauri/src/updater.rs"
    export RELEASE_PLEASE_CFG="$BATS_TEST_DIRNAME/../../release-please-config.json"
    export RELEASE_PLEASE_MANIFEST="$BATS_TEST_DIRNAME/../../.release-please-manifest.json"
    export REPO_ROOT="$BATS_TEST_DIRNAME/../.."
}

@test "tauri.conf.json exists" {
    [ -f "$TAURI_CONF" ]
}

@test "tauri.conf.json is valid JSON" {
    run python3 -c "import json, os; json.load(open(os.environ['TAURI_CONF']))"
    [ "$status" -eq 0 ]
}

@test "bundle.createUpdaterArtifacts is \"v1Compatible\"" {
    run python3 -c '
import json, os, sys
conf = json.load(open(os.environ["TAURI_CONF"]))
val = conf.get("bundle", {}).get("createUpdaterArtifacts")
if val != "v1Compatible":
    print(f"expected 'v1Compatible', got: {val!r}. Missing/wrong = auto-update broken silently.")
    sys.exit(1)
'
    [ "$status" -eq 0 ]
}

@test "plugins.updater.endpoints is non-empty array" {
    run python3 -c '
import json, os, sys
conf = json.load(open(os.environ["TAURI_CONF"]))
endpoints = conf.get("plugins", {}).get("updater", {}).get("endpoints")
if not isinstance(endpoints, list) or len(endpoints) == 0:
    print(f"plugins.updater.endpoints must be a non-empty array, got: {endpoints!r}")
    sys.exit(1)
'
    [ "$status" -eq 0 ]
}

@test "plugins.updater.endpoints[0] is a valid HTTPS URL" {
    run python3 -c '
import json, os, sys
from urllib.parse import urlparse
conf = json.load(open(os.environ["TAURI_CONF"]))
endpoints = conf.get("plugins", {}).get("updater", {}).get("endpoints", [])
if not endpoints:
    print("plugins.updater.endpoints is empty")
    sys.exit(1)
url = endpoints[0]
parsed = urlparse(url)
if parsed.scheme != "https":
    print(f"endpoints[0] scheme is {parsed.scheme!r}, expected https")
    sys.exit(1)
if not parsed.netloc:
    print(f"endpoints[0] has empty netloc: {url!r}")
    sys.exit(1)
'
    [ "$status" -eq 0 ]
}

@test "plugins.updater.endpoints[0] matches STABLE_ENDPOINT in updater.rs" {
    run python3 -c '
import json, re, os, sys
conf = json.load(open(os.environ["TAURI_CONF"]))
endpoints = conf.get("plugins", {}).get("updater", {}).get("endpoints", [])
if not endpoints:
    print("plugins.updater.endpoints is empty")
    sys.exit(1)
json_endpoint = endpoints[0]
updater_rs = os.environ["UPDATER_RS"]
try:
    content = open(updater_rs).read()
except FileNotFoundError:
    print("Could not open " + updater_rs)
    sys.exit(1)
m = re.search(r"const STABLE_ENDPOINT:\s*&str\s*=\s*\"([^\"]+)\"", content, re.DOTALL)
if not m:
    print("Could not find STABLE_ENDPOINT in updater.rs")
    sys.exit(1)
rust_endpoint = m.group(1)
if json_endpoint != rust_endpoint:
    print(f"tauri.conf.json endpoint {json_endpoint!r} != STABLE_ENDPOINT {rust_endpoint!r}")
    sys.exit(1)
'
    [ "$status" -eq 0 ]
}

@test "plugins.updater.pubkey is non-empty string" {
    run python3 -c '
import json, os, sys
conf = json.load(open(os.environ["TAURI_CONF"]))
pubkey = conf.get("plugins", {}).get("updater", {}).get("pubkey")
if not isinstance(pubkey, str) or not pubkey.strip():
    print(f"plugins.updater.pubkey must be a non-empty string, got: {pubkey!r}")
    sys.exit(1)
'
    [ "$status" -eq 0 ]
}

@test "plugins.updater.pubkey is base64-decodable" {
    run python3 -c '
import base64, json, os, sys
conf = json.load(open(os.environ["TAURI_CONF"]))
pubkey = conf.get("plugins", {}).get("updater", {}).get("pubkey", "")
try:
    decoded = base64.b64decode(pubkey, validate=True)
except Exception as e:
    print(f"pubkey is not valid base64: {e}")
    sys.exit(1)
if not decoded:
    print("pubkey decoded to empty bytes")
    sys.exit(1)
'
    [ "$status" -eq 0 ]
}

@test "plugins.updater.pubkey is a well-formed minisign Ed25519 key" {
    # Minisign key format: https://jedisct1.github.io/minisign/
    # base64-decoded payload = two newline-separated lines:
    #   Line 1: "untrusted comment: minisign public key:<keyid>"
    #   Line 2: base64 of 42 bytes = 2-byte algo ID (0x45 0x64 = "Ed") +
    #            8-byte key ID + 32-byte Ed25519 public key
    run python3 -c '
import base64, json, os, sys
conf = json.load(open(os.environ["TAURI_CONF"]))
pubkey = conf.get("plugins", {}).get("updater", {}).get("pubkey", "")
try:
    decoded = base64.b64decode(pubkey, validate=True).decode("utf-8")
except Exception as e:
    print(f"pubkey decode failed: {e}")
    sys.exit(1)
lines = decoded.split("\n")
if not lines[0].startswith("untrusted comment: minisign public key:"):
    print(f"line 1 does not start with expected prefix, got: {lines[0]!r}")
    sys.exit(1)
if len(lines) < 2 or not lines[1].strip():
    print("line 2 (key material) is missing or empty")
    sys.exit(1)
try:
    key_bytes = base64.b64decode(lines[1].strip(), validate=True)
except Exception as e:
    print(f"line 2 is not valid base64: {e}")
    sys.exit(1)
if len(key_bytes) != 42:
    print(f"key material must be 42 bytes (2+8+32), got {len(key_bytes)}")
    sys.exit(1)
if key_bytes[0] != 0x45 or key_bytes[1] != 0x64:
    print(f"expected Ed25519 magic bytes 0x45 0x64 (Ed), got {key_bytes[0]:#04x} {key_bytes[1]:#04x}")
    sys.exit(1)
'
    [ "$status" -eq 0 ]
}

@test "all release-please-managed files match .release-please-manifest.json version" {
    run python3 -c '
import json, re, os, sys

manifest = json.load(open(os.environ["RELEASE_PLEASE_MANIFEST"]))
expected = manifest["."]

cfg = json.load(open(os.environ["RELEASE_PLEASE_CFG"]))
extra_files = cfg["packages"]["."]["extra-files"]

repo_root = os.environ["REPO_ROOT"]
mismatches = []

for entry in extra_files:
    if isinstance(entry, str):
        path = repo_root + "/" + entry
        try:
            data = json.load(open(path))
        except Exception as e:
            mismatches.append(f"  {entry}: could not parse JSON: {e}")
            continue
        actual = data.get("version")
        if actual != expected:
            mismatches.append(f"  {entry}: got {actual!r}, expected {expected!r}")
    elif isinstance(entry, dict) and entry.get("type") == "toml":
        path = repo_root + "/" + entry["path"]
        try:
            content = open(path).read()
        except Exception as e:
            mismatches.append("  " + entry["path"] + ": could not read: " + str(e))
            continue
        m = re.search(r"^\[package\].*?^version\s*=\s*\"([^\"]+)\"", content, re.MULTILINE | re.DOTALL)
        if not m:
            mismatches.append("  " + entry["path"] + ": could not find version in [package] section")
            continue
        actual = m.group(1)
        if actual != expected:
            mismatches.append(f"  {entry['path']}: got {actual!r}, expected {expected!r}")

if mismatches:
    print(f"Version mismatch (expected {expected!r} from .release-please-manifest.json):")
    for line in mismatches:
        print(line)
    sys.exit(1)
'
    [ "$status" -eq 0 ]
}
