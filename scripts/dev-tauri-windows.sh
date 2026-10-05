#!/usr/bin/env bash
set -euo pipefail

cd desktop/src-tauri
export SPEEDWAVE_RESOURCES_DIR="$(pwd)"
export SPEEDWAVE_ALLOW_UNSIGNED=1
base_tauri_config="${DEV_TAURI_CONFIG:?DEV_TAURI_CONFIG must be exported by the Makefile; run make dev}"

app_version="${SPEEDWAVE_VERSION:-$(cd ../.. && cargo run --quiet -p speedwave-version --bin speedwave-version -- version 2>/dev/null || echo 0.0.0)}"
export SPEEDWAVE_VERSION="$app_version"
export TAURI_CONFIG="$(printf '%s' "$base_tauri_config" | sed "s/^{/{\"version\":\"$app_version\",/")"

exec env -u PORT cargo tauri dev --config "$TAURI_CONFIG"
