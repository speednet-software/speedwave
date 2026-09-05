#!/usr/bin/env bash
# Helper: launch `cargo tauri dev` on Windows — GnuWin32 make 3.81 mishandles complex
# quoting inline, so this wrapper isolates the bash logic and make just invokes it.
set -euo pipefail

cd desktop/src-tauri
export SPEEDWAVE_RESOURCES_DIR="$(pwd)"
export SPEEDWAVE_ALLOW_UNSIGNED=1
export TAURI_CONFIG='{"identifier":"pl.speedwave.desktop.dev","productName":"Speedwave Dev"}'

exec env -u PORT cargo tauri dev
