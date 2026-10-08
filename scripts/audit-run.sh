#!/usr/bin/env bash
set -euo pipefail

# Single source of the audited lockfile paths and the npm severity threshold:
# `make audit-rust`/`audit-mcp`/`audit-desktop`, scripts/audit-diff.sh (PR lane)
# and scripts/audit-issue.sh (daily schedule) all shell out to this script
# instead of repeating the cargo-audit/npm-audit invocations.

usage() {
    echo "usage: audit-run.sh TARGET OUT_JSON [ROOT]" >&2
    echo "  TARGET: cargo-root | cargo-desktop | npm-mcp | npm-desktop" >&2
    exit 64
}

[ "$#" -ge 2 ] || usage
TARGET="$1"
OUT_JSON="$2"
DEFAULT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${3:-$DEFAULT_ROOT}"
NPM_AUDIT_LEVEL="${NPM_AUDIT_LEVEL:-$(python3 "$DEFAULT_ROOT/scripts/audit-gate.py" print-npm-default-severity)}"

run_cargo() {
    local lockfile="$1" out="$2" err="$2.stderr"
    cargo audit --json --file "$lockfile" >"$out" 2>"$err" || true
    if [ ! -s "$out" ]; then
        echo "audit-run: cargo audit produced no output for $lockfile, it likely failed to run:" >&2
        cat "$err" >&2
        rm -f "$err"
        exit 1
    fi
    rm -f "$err"
}

run_npm() {
    local dir="$1" out="$2" err="$2.stderr"
    (cd "$dir" && npm audit --omit=dev --audit-level="$NPM_AUDIT_LEVEL" --package-lock-only --json) >"$out" 2>"$err" || true
    if [ ! -s "$out" ]; then
        echo "audit-run: npm audit produced no output for $dir, it likely failed to run:" >&2
        cat "$err" >&2
        rm -f "$err"
        exit 1
    fi
    rm -f "$err"
}

case "$TARGET" in
    cargo-root) run_cargo "$ROOT/Cargo.lock" "$OUT_JSON" ;;
    cargo-desktop) run_cargo "$ROOT/desktop/src-tauri/Cargo.lock" "$OUT_JSON" ;;
    npm-mcp) run_npm "$ROOT/mcp-servers" "$OUT_JSON" ;;
    npm-desktop) run_npm "$ROOT/desktop/src" "$OUT_JSON" ;;
    *)
        echo "audit-run: unknown target '$TARGET' (expected cargo-root, cargo-desktop, npm-mcp or npm-desktop)" >&2
        usage
        ;;
esac
