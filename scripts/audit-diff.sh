#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

: "${AUDIT_BASE_SHA:?AUDIT_BASE_SHA required (target branch commit)}"

EXCEPTIONS="${AUDIT_EXCEPTIONS:-$REPO_ROOT/scripts/audit-exceptions.json}"
GATE="$REPO_ROOT/scripts/audit-gate.py"
AUDIT_RUN="$REPO_ROOT/scripts/audit-run.sh"
NPM_AUDIT_LEVEL="${NPM_AUDIT_LEVEL:-$(python3 "$GATE" print-npm-default-severity)}"
export NPM_AUDIT_LEVEL

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

"$REPO_ROOT/scripts/audit-changed-files.sh" "$AUDIT_BASE_SHA" "HEAD" "$WORKDIR/changed.json"

if [ "$(python3 "$GATE" lockfiles-touched --changed "$WORKDIR/changed.json")" = "false" ]; then
    echo "No package-lock.json or Cargo.lock in the diff, green without auditing."
    exit 0
fi

fetch_base_file() {
    local ref_path="$1" out="$2"
    mkdir -p "$(dirname "$out")"
    git show "${AUDIT_BASE_SHA}:${ref_path}" >"$out"
}

BASE_ROOT="$WORKDIR/base"
fetch_base_file "Cargo.lock" "$BASE_ROOT/Cargo.lock"
fetch_base_file "desktop/src-tauri/Cargo.lock" "$BASE_ROOT/desktop/src-tauri/Cargo.lock"
fetch_base_file "mcp-servers/package.json" "$BASE_ROOT/mcp-servers/package.json"
fetch_base_file "mcp-servers/package-lock.json" "$BASE_ROOT/mcp-servers/package-lock.json"
fetch_base_file "desktop/src/package.json" "$BASE_ROOT/desktop/src/package.json"
fetch_base_file "desktop/src/package-lock.json" "$BASE_ROOT/desktop/src/package-lock.json"

"$AUDIT_RUN" cargo-root "$WORKDIR/base-cargo-root.json" "$BASE_ROOT"
"$AUDIT_RUN" cargo-desktop "$WORKDIR/base-cargo-desktop.json" "$BASE_ROOT"
"$AUDIT_RUN" npm-mcp "$WORKDIR/base-npm-mcp.json" "$BASE_ROOT"
"$AUDIT_RUN" npm-desktop "$WORKDIR/base-npm-desktop.json" "$BASE_ROOT"

"$AUDIT_RUN" cargo-root "$WORKDIR/head-cargo-root.json"
"$AUDIT_RUN" cargo-desktop "$WORKDIR/head-cargo-desktop.json"
"$AUDIT_RUN" npm-mcp "$WORKDIR/head-npm-mcp.json"
"$AUDIT_RUN" npm-desktop "$WORKDIR/head-npm-desktop.json"

python3 "$GATE" diff \
    --exceptions "$EXCEPTIONS" \
    --npm-min-severity "$NPM_AUDIT_LEVEL" \
    --base "cargo:$WORKDIR/base-cargo-root.json" \
    --base "cargo:$WORKDIR/base-cargo-desktop.json" \
    --base "npm:$WORKDIR/base-npm-mcp.json" \
    --base "npm:$WORKDIR/base-npm-desktop.json" \
    --head "cargo:$WORKDIR/head-cargo-root.json" \
    --head "cargo:$WORKDIR/head-cargo-desktop.json" \
    --head "npm:$WORKDIR/head-npm-mcp.json" \
    --head "npm:$WORKDIR/head-npm-desktop.json"
