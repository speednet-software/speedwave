#!/usr/bin/env bash
# Pre-fetches the sherpa-onnx Windows static-lib MD-Release prebuilt (ADR-061).
# Prints the lib/ absolute path on stdout; caller exports it as SHERPA_ONNX_LIB_DIR.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION_FILE="${REPO_ROOT}/.sherpa-onnx-version"
OUT_ROOT="${SHERPA_ONNX_FETCH_DIR:-${RUNNER_TEMP:-/tmp}/sherpa-onnx-md}"

if [ ! -f "$VERSION_FILE" ]; then
  echo "::error::missing $VERSION_FILE" >&2
  exit 1
fi

VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
ARCHIVE="sherpa-onnx-v${VERSION}-win-x64-static-MD-Release-lib.tar.bz2"
EXTRACTED_TOP="sherpa-onnx-v${VERSION}-win-x64-static-MD-Release-lib"
BASE_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}"
ARCHIVE_URL="${BASE_URL}/${ARCHIVE}"
CHECKSUM_URL="${BASE_URL}/checksum.txt"

mkdir -p "$OUT_ROOT"
ARCHIVE_PATH="${OUT_ROOT}/${ARCHIVE}"
LIB_DIR="${OUT_ROOT}/${EXTRACTED_TOP}/lib"

if [ "${SHERPA_ONNX_FETCH_FORCE:-0}" = "0" ] && [ -d "$LIB_DIR" ] && [ -f "${LIB_DIR}/sherpa-onnx-c-api.lib" ]; then
  echo "sherpa-onnx MD prebuilt already extracted at ${LIB_DIR} — skipping download" >&2
  printf '%s\n' "$LIB_DIR"
  exit 0
fi

echo "Fetching ${ARCHIVE_URL}" >&2
curl -fsSL "$ARCHIVE_URL" -o "$ARCHIVE_PATH"
echo "Fetching ${CHECKSUM_URL}" >&2
CHECKSUM_PATH="${OUT_ROOT}/checksum.txt"
curl -fsSL "$CHECKSUM_URL" -o "$CHECKSUM_PATH"

# checksum.txt is <filename>\t<sha256>; awk also accepts <sha256>\t<filename>.
EXPECTED="$(awk -v f="$ARCHIVE" '$1 == f { print $2 } $2 == f { print $1 }' "$CHECKSUM_PATH")"
if [ -z "$EXPECTED" ]; then
  echo "::error::no SHA256 for ${ARCHIVE} in checksum.txt" >&2
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
else
  # MSYS2 sha256sum (Git Bash on windows-latest) prefixes the hash with `\`
  # when the path contained backslashes — strip it so the compare matches.
  ACTUAL="$(sha256sum "$ARCHIVE_PATH" | awk '{ sub(/^\\/, "", $1); print $1 }')"
fi

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "::error::SHA256 mismatch for ${ARCHIVE}: expected ${EXPECTED}, got ${ACTUAL}" >&2
  exit 1
fi
echo "SHA256 verified (${ACTUAL})" >&2

# cd $OUT_ROOT + relative archive name keeps the drive-letter colon out of
# tar's argv (MSYS2 tar reads a `:` in a native path as SSH user@host:path).
rm -rf "${OUT_ROOT:?}/${EXTRACTED_TOP}"
(cd "$OUT_ROOT" && tar -xjf "$ARCHIVE")

if [ ! -d "$LIB_DIR" ] || [ ! -f "${LIB_DIR}/sherpa-onnx-c-api.lib" ]; then
  echo "::error::extraction produced no lib/ with sherpa-onnx-c-api.lib at ${LIB_DIR}" >&2
  exit 1
fi

rm -f "$ARCHIVE_PATH" "$CHECKSUM_PATH"
printf '%s\n' "$LIB_DIR"
