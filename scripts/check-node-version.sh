#!/usr/bin/env bash
# Fails unless the `node` on PATH is at least the pinned version (`.node-version` is the SSOT).
# Usage: check-node-version.sh <required-version>
set -euo pipefail

required="${1:?usage: $0 <required-version>}"

if ! command -v node >/dev/null 2>&1; then
    echo "  ❌ node not found"
    echo "     Install Node.js ${required} (.node-version): nvm install ${required} or https://nodejs.org"
    exit 1
fi

actual="$(node --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
if [ -z "$actual" ]; then
    echo "  ❌ node version unreadable from 'node --version'"
    exit 1
fi

lowest="$(printf '%s\n%s\n' "$required" "$actual" | sort -V | head -1)"
if [ "$lowest" != "$required" ]; then
    echo "  ❌ node ${actual} (requires ${required}+, see .node-version)"
    echo "     Install: nvm install ${required} or https://nodejs.org"
    exit 1
fi

echo "  ✅ node ${actual}"
