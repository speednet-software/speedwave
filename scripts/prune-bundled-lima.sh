#!/usr/bin/env bash

set -euo pipefail


root="${1:-$(cd "$(dirname "$0")/.." && pwd)/desktop/src-tauri}"
rm -f "$root"/lima/share/lima/lima-guestagent.Darwin-*.gz
