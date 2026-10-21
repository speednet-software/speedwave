#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCKFILE="${WASM_BINDGEN_LOCKFILE:-$REPO_ROOT/Cargo.lock}"
RELEASES_URL="https://github.com/wasm-bindgen/wasm-bindgen/releases/download"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

locked_version() {
  awk '
    $0 == "name = \"wasm-bindgen\"" { found = 1; next }
    found && /^version = / { split($0, parts, "\""); print parts[2]; exit }
  ' "$LOCKFILE"
}

host_target() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo aarch64-apple-darwin ;;
    Darwin-x86_64) echo x86_64-apple-darwin ;;
    *) fail "no prebuilt wasm-bindgen is mapped for $(uname -s) $(uname -m)" ;;
  esac
}

[ -f "$LOCKFILE" ] || fail "lockfile not found: $LOCKFILE"
version="$(locked_version)"
[ -n "$version" ] || fail "wasm-bindgen is not in $LOCKFILE"
target="$(host_target)"
name="wasm-bindgen-$version-$target"
dest="${1:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/wasm-bindgen-$version}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL --retry 3 -o "$work/$name.tar.gz" "$RELEASES_URL/$version/$name.tar.gz"
curl -fsSL --retry 3 -o "$work/$name.tar.gz.sha256sum" "$RELEASES_URL/$version/$name.tar.gz.sha256sum"

expected="$(awk '{ print $1 }' "$work/$name.tar.gz.sha256sum")"
actual="$(bash "$REPO_ROOT/scripts/sha256.sh" "$work/$name.tar.gz")"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  fail "sha256 mismatch for $name.tar.gz: release says '$expected', downloaded file is '$actual'"
fi

mkdir -p "$dest"
tar -xzf "$work/$name.tar.gz" -C "$dest" --strip-components=1 "$name/wasm-bindgen"

installed="$("$dest/wasm-bindgen" --version)"
[ "$installed" = "wasm-bindgen $version" ] || fail "$dest/wasm-bindgen reports '$installed', expected 'wasm-bindgen $version'"

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$dest" >>"$GITHUB_PATH"
fi
echo "$dest"
