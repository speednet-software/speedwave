#!/usr/bin/env bash
# Helper: launch `cargo tauri dev` with sherpa-onnx env on Windows.
# GnuWin32 make 3.81 mishandles complex quoting inline.
set -euo pipefail

SHERPA_LIB_CACHE="${1:?missing cache file path}"

if [ ! -f "$SHERPA_LIB_CACHE" ]; then
  echo "❌ sherpa-onnx cache file not found: $SHERPA_LIB_CACHE" >&2
  echo "   Run: make download-sherpa-onnx" >&2
  exit 1
fi

export SHERPA_ONNX_LIB_DIR="$(cat "$SHERPA_LIB_CACHE")"

if [ ! -d "$SHERPA_ONNX_LIB_DIR" ]; then
  echo "❌ SHERPA_ONNX_LIB_DIR does not exist: $SHERPA_ONNX_LIB_DIR" >&2
  echo "   Re-run: make download-sherpa-onnx" >&2
  exit 1
fi

cd desktop/src-tauri
export SPEEDWAVE_RESOURCES_DIR="$(pwd)"
export SPEEDWAVE_ALLOW_UNSIGNED=1
export TAURI_CONFIG='{"identifier":"pl.speedwave.desktop.dev","productName":"Speedwave Dev"}'

exec cargo tauri dev
