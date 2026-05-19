#!/usr/bin/env bash
# Pre-fetches the sherpa-onnx Windows static-lib prebuilt in its MD-Release
# (dynamic CRT) variant so cargo's sherpa-onnx-sys build skips its hard-coded
# MT-Release download. Used by both CI (download-sherpa-onnx composite action)
# and Windows E2E (e2e-vm.sh). Prints the absolute path of the lib/ directory
# on stdout — caller must export that as SHERPA_ONNX_LIB_DIR.
#
# See ADR-061 for the architecture rationale.

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

# checksum.txt format today: <filename>\t<sha256>  (tab-separated, filename first).
# Defensive: also accept the standard `sha256sum` ordering <sha256>  <filename>
# in case k2-fsa flips the format on a future release.
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

# Extract under OUT_ROOT — tarball top-level is ${EXTRACTED_TOP}/
rm -rf "${OUT_ROOT:?}/${EXTRACTED_TOP}"
tar -xjf "$ARCHIVE_PATH" -C "$OUT_ROOT"

if [ ! -d "$LIB_DIR" ] || [ ! -f "${LIB_DIR}/sherpa-onnx-c-api.lib" ]; then
  echo "::error::extraction produced no lib/ with sherpa-onnx-c-api.lib at ${LIB_DIR}" >&2
  exit 1
fi

rm -f "$ARCHIVE_PATH" "$CHECKSUM_PATH"
printf '%s\n' "$LIB_DIR"
