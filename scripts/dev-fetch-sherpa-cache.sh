#!/usr/bin/env bash
# Wrapper for `make download-sherpa-onnx`: fetches the sherpa-onnx MD-Release
# prebuilt and writes the resulting lib dir to a cache file. Exists because
# MSYS2 (Git Bash on Windows) breaks env export propagation when make calls
# `sh -c '... export VAR; bash ...'` — the child bash does not inherit VAR.
# Doing the work in a single bash invocation avoids both nesting bugs.
set -euo pipefail

FETCH_DIR="${1:?missing fetch dir arg}"
CACHE="${2:?missing cache path arg}"

export SHERPA_ONNX_FETCH_DIR="$FETCH_DIR"
LIB_DIR="$(bash scripts/lib/fetch-sherpa-onnx-md.sh | tail -1)"
printf '%s\n' "$LIB_DIR" > "$CACHE"
echo "  ✅ SHERPA_ONNX_LIB_DIR=$LIB_DIR"
