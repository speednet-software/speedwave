#!/usr/bin/env bash

set -euo pipefail

main() {
  [ "$#" -eq 1 ] || usage
  [ -f "$1" ] || fail "no such file: $1"
  digest "$1" | awk '{ print tolower($1) }'
}

usage() {
  echo "usage: $0 <file>" >&2
  exit 2
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1"
  else
    fail "neither sha256sum nor shasum is on PATH"
  fi
}

main "$@"
