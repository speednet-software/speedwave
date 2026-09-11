#!/usr/bin/env bash
# Helper: launch `cargo tauri dev` on Windows — GnuWin32 make 3.81 mishandles complex
# quoting inline, so this wrapper isolates the bash logic and make just invokes it.
set -euo pipefail

cd desktop/src-tauri
export SPEEDWAVE_RESOURCES_DIR="$(pwd)"
export SPEEDWAVE_ALLOW_UNSIGNED=1
# Built by the Makefile from DEV_INSTANCE/DEV_PORT and exported to us. No default
# here: a second copy of the JSON is a second thing to keep in sync.
export TAURI_CONFIG="${DEV_TAURI_CONFIG:?DEV_TAURI_CONFIG must be exported by the Makefile; run make dev}"

exec env -u PORT cargo tauri dev --config "$TAURI_CONFIG"
