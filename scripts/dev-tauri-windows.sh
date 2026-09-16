#!/usr/bin/env bash
set -euo pipefail

cd desktop/src-tauri
export SPEEDWAVE_RESOURCES_DIR="$(pwd)"
export SPEEDWAVE_ALLOW_UNSIGNED=1
export TAURI_CONFIG="${DEV_TAURI_CONFIG:?DEV_TAURI_CONFIG must be exported by the Makefile; run make dev}"

exec env -u PORT cargo tauri dev --config "$TAURI_CONFIG"
