#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS_FILE="${BUILD_TOOL_VERSIONS_FILE:-$REPO_ROOT/scripts/build-tool-versions.env}"
CACHE_DIR="${SPEEDWAVE_TOOL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/speedwave-build-tools}"

fail() {
  echo "python-tool: $*" >&2
  exit 1
}

[ "$#" -ge 1 ] || fail "usage: python-tool.sh TOOL [ARGS...]"
tool="$1"
shift

[ -f "$VERSIONS_FILE" ] || fail "versions file not found: $VERSIONS_FILE"
key="$(echo "$tool" | tr 'a-z-' 'A-Z_')_VERSION"
version="$(awk -F= -v k="$key" '$1 == k { print $2; exit }' "$VERSIONS_FILE")"
[ -n "$version" ] || fail "$key is not set in $VERSIONS_FILE"

venv="$CACHE_DIR/$tool-$version"

tool_path() {
  local candidate
  for candidate in "$venv/bin/$tool" "$venv/Scripts/$tool.exe" "$venv/Scripts/$tool"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
}

pip_path() {
  local candidate
  for candidate in "$venv/bin/pip" "$venv/Scripts/pip.exe"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
}

if [ -z "$(tool_path)" ]; then
  python_bin=""
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
      python_bin="$candidate"
      break
    fi
  done
  [ -n "$python_bin" ] || fail "python3 is required to install $tool"
  rm -rf "$venv"
  mkdir -p "$CACHE_DIR"
  "$python_bin" -m venv "$venv" >&2
  "$(pip_path)" install --quiet --disable-pip-version-check --no-cache-dir "$tool==$version" >&2 \
    || { rm -rf "$venv"; fail "could not install $tool==$version"; }
  [ -n "$(tool_path)" ] || fail "$tool==$version installed no $tool executable in $venv"
fi

exec "$(tool_path)" "$@"
