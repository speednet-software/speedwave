#!/usr/bin/env bash
# Verifies a draft GitHub Release contains every expected updater asset.
# Idempotent, read-only. Safe to retry. Runs portable Bash (no Bash-4 builtins
# like `mapfile`) so BATS tests work on macOS default bash 3.2.
#
# Expected asset names are derived from `assetNamePattern` in
# .github/workflows/desktop-release.yml (tauri-apps/tauri-action pin).
# If either changes, update both files in the same PR.
#
# `latest.json.version` MUST be bare semver (no `v` prefix) — if tauri-action
# ever changes this, update the Python assertion below and the BATS fixture.
#
# Required env: VERSION REPO RID TAG_NAME GH_TOKEN (latter read by gh)
set -euo pipefail

: "${VERSION:?VERSION required}"
: "${REPO:?REPO required}"
: "${RID:?RID required}"
: "${TAG_NAME:?TAG_NAME required}"

V="$VERSION"

SIGNED_ASSETS=(
  "Speedwave_${V}_macOS_Apple_Silicon.app.tar.gz"
  "Speedwave_${V}_macOS_Intel.app.tar.gz"
  "Speedwave_${V}_x64-setup.exe"
  "Speedwave_${V}_x64-setup.nsis.zip"
  "Speedwave_${V}_x64_en-US.msi"
  "Speedwave_${V}_x64_en-US.msi.zip"
)

UNSIGNED_ASSETS=(
  "latest.json"
  "Speedwave_${V}_macOS_Apple_Silicon.dmg"
  "Speedwave_${V}_macOS_Intel.dmg"
  "Speedwave_${V}_amd64.deb"
  "speedwave-v${V}-aarch64-apple-darwin.tar.gz"
  "speedwave-v${V}-x86_64-apple-darwin.tar.gz"
  "speedwave-v${V}-x86_64-unknown-linux-gnu.tar.gz"
  "speedwave-v${V}-x86_64-pc-windows-msvc.zip"
)

fail() {
  echo "::error::$1" >&2
  echo "::error::To publish anyway: gh api --method PATCH repos/${REPO}/releases/${RID} -f draft=false" >&2
  exit 1
}

# Portable array load (no mapfile — works on macOS Bash 3.2).
PRESENT=()
while IFS= read -r line; do
  PRESENT+=("$line")
done < <(gh api "repos/${REPO}/releases/${RID}/assets" --jq '.[].name')

has_asset() {
  local needle="$1" a
  for a in "${PRESENT[@]}"; do
    [ "$a" = "$needle" ] && return 0
  done
  return 1
}

for name in "${UNSIGNED_ASSETS[@]}" "${SIGNED_ASSETS[@]}"; do
  has_asset "$name" || fail "missing release asset: $name"
done
for name in "${SIGNED_ASSETS[@]}"; do
  has_asset "${name}.sig" || fail "missing signature: ${name}.sig"
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

gh release download "$TAG_NAME" --repo "$REPO" --pattern "latest.json" --dir "$TMP"
python3 - "$TMP/latest.json" "$V" "$REPO" <<'PY' 2> "$TMP/py.err" || { sed 's/^/::error::/' "$TMP/py.err" >&2; fail "latest.json validation failed"; }
import json, sys
path, expected, repo = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    data = json.load(f)
for field in ("version", "notes", "pub_date", "platforms"):
    if field not in data:
        sys.exit(f"latest.json missing field: {field}")
# Bare semver expected — no `v` prefix. If tauri-action ever prefixes, update here.
if data["version"] != expected:
    sys.exit(f"latest.json version '{data['version']}' != expected '{expected}'")
platforms = data["platforms"]
if not isinstance(platforms, dict) or not platforms:
    sys.exit("latest.json platforms is empty")
# Linux is excluded: updater.rs disables auto-update on Linux.
# Missing keys = auto-update broken for that platform. Extra keys are allowed.
required_keys = (
    "darwin-x86_64", "darwin-x86_64-app",
    "darwin-aarch64", "darwin-aarch64-app",
    "windows-x86_64", "windows-x86_64-msi", "windows-x86_64-nsis",
)
url_prefix = f"https://github.com/{repo}/releases/"
for key in required_keys:
    entry = platforms.get(key)
    if not entry:
        sys.exit(f"latest.json missing required platform key: {key}")
    if not entry.get("signature"):
        sys.exit(f"latest.json platforms.{key}.signature is empty")
    url = entry.get("url", "")
    if not url:
        sys.exit(f"latest.json platforms.{key}.url is empty")
    if not url.startswith(url_prefix):
        sys.exit(f"latest.json platforms.{key}.url does not start with {url_prefix}: {url}")
PY

# Download each .sig explicitly by name — never a glob, never `*.sig`.
for name in "${SIGNED_ASSETS[@]}"; do
  sig="${name}.sig"
  gh release download "$TAG_NAME" --repo "$REPO" --pattern "$sig" --dir "$TMP"
  [ -s "$TMP/$sig" ] || fail "signature file empty: $sig"
done

echo "Verified ${#UNSIGNED_ASSETS[@]} unsigned + ${#SIGNED_ASSETS[@]} signed assets; all signatures non-empty"
