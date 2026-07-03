#!/usr/bin/env bash

set -euo pipefail

# Speedwave boots only a Linux guest; the unsigned arm64 Mach-O inside
# lima-guestagent.Darwin-*.gz is unused and breaks macOS notarization.

root="${1:-$(cd "$(dirname "$0")/.." && pwd)/desktop/src-tauri}"
rm -f "$root"/lima/share/lima/lima-guestagent.Darwin-*.gz
