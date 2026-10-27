#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS_FILE="${BUILD_TOOL_VERSIONS_FILE:-$REPO_ROOT/scripts/build-tool-versions.env}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[ -f "$VERSIONS_FILE" ] || fail "versions file not found: $VERSIONS_FILE"
version="$(awk -F= '$1 == "WASM_PACK_VERSION" { print $2; exit }' "$VERSIONS_FILE")"
[ -n "$version" ] || fail "WASM_PACK_VERSION is not set in $VERSIONS_FILE"

npm_bin=""
if command -v npm >/dev/null 2>&1; then
  npm_bin="$(npm prefix -g 2>/dev/null)/bin" || npm_bin=""
fi
if [ -n "$npm_bin" ]; then
  export PATH="$npm_bin:$PATH"
fi

installed_version() {
  command -v wasm-pack >/dev/null 2>&1 || return 0
  wasm-pack --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true
}

if [ "$(installed_version)" = "$version" ]; then
  echo "wasm-pack $version already installed"
  exit 0
fi

if command -v npm >/dev/null 2>&1 && npm install -g "wasm-pack@$version" >/dev/null 2>&1 \
  && [ "$(installed_version)" = "$version" ]; then
  method=npm
elif command -v cargo >/dev/null 2>&1 && cargo install wasm-pack --version "$version" --locked --force \
  && [ "$(installed_version)" = "$version" ]; then
  method=cargo
else
  fail "could not install wasm-pack $version with npm or cargo"
fi

if [ -n "${GITHUB_PATH:-}" ] && [ -n "$npm_bin" ]; then
  echo "$npm_bin" >>"$GITHUB_PATH"
fi
echo "wasm-pack $version installed ($method)"
