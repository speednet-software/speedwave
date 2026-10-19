#!/usr/bin/env bash
set -euo pipefail

# Single source of the audited lockfile paths and the npm severity threshold:
# the `make audit-*` targets, scripts/audit-diff.sh (PR lane) and
# scripts/audit-issue.sh (daily schedule) all shell out to this script
# instead of repeating the cargo-audit/npm-audit invocations.

list_targets() {
    cat <<'LIST'
cargo-root cargo Cargo.lock
cargo-desktop cargo desktop/src-tauri/Cargo.lock
npm-root npm package-lock.json
npm-mcp npm mcp-servers/package-lock.json
npm-playwright npm mcp-servers/playwright/package-lock.json
npm-desktop npm desktop/src/package-lock.json
npm-e2e npm desktop/e2e/package-lock.json
LIST
}

usage() {
    echo "usage: audit-run.sh TARGET OUT_JSON [ROOT]" >&2
    echo "       audit-run.sh --list   (one \"TARGET KIND LOCKFILE\" line per audited target)" >&2
    echo "  TARGET: $(list_targets | cut -d' ' -f1 | paste -sd'|' - | sed 's/|/ | /g')" >&2
    exit 64
}

if [ "${1:-}" = "--list" ]; then
    list_targets
    exit 0
fi

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
    (cd "$dir" && npm audit --audit-level="$NPM_AUDIT_LEVEL" --package-lock-only --json) >"$out" 2>"$err" || true
    if [ ! -s "$out" ]; then
        echo "audit-run: npm audit produced no output for $dir, it likely failed to run:" >&2
        cat "$err" >&2
        rm -f "$err"
        exit 1
    fi
    rm -f "$err"
}

ENTRY="$(list_targets | awk -v t="$TARGET" '$1 == t')"
if [ -z "$ENTRY" ]; then
    echo "audit-run: unknown target '$TARGET' (expected one of: $(list_targets | cut -d' ' -f1 | paste -sd' ' -))" >&2
    usage
fi
KIND="$(echo "$ENTRY" | cut -d' ' -f2)"
LOCKFILE="$(echo "$ENTRY" | cut -d' ' -f3)"

case "$KIND" in
    cargo) run_cargo "$ROOT/$LOCKFILE" "$OUT_JSON" ;;
    npm) run_npm "$(cd "$ROOT/$(dirname "$LOCKFILE")" && pwd)" "$OUT_JSON" ;;
esac
