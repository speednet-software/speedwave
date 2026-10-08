#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

: "${AUDIT_BASE_SHA:?AUDIT_BASE_SHA required (target branch commit)}"

NPM_AUDIT_LEVEL="${NPM_AUDIT_LEVEL:-high}"
EXCEPTIONS="${AUDIT_EXCEPTIONS:-$REPO_ROOT/scripts/audit-exceptions.json}"
GATE="$REPO_ROOT/scripts/audit-gate.py"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

"$REPO_ROOT/scripts/audit-changed-files.sh" "$AUDIT_BASE_SHA" "HEAD" "$WORKDIR/changed.json"

if [ "$(python3 "$GATE" lockfiles-touched --changed "$WORKDIR/changed.json")" = "false" ]; then
    echo "No package-lock.json or Cargo.lock in the diff, green without auditing."
    exit 0
fi

fetch_base_file() {
    local ref_path="$1" out="$2"
    git show "${AUDIT_BASE_SHA}:${ref_path}" >"$out"
}

mkdir -p "$WORKDIR/base-mcp" "$WORKDIR/base-desktop"
fetch_base_file "Cargo.lock" "$WORKDIR/base-cargo-root.lock"
fetch_base_file "desktop/src-tauri/Cargo.lock" "$WORKDIR/base-cargo-desktop.lock"
fetch_base_file "mcp-servers/package.json" "$WORKDIR/base-mcp/package.json"
fetch_base_file "mcp-servers/package-lock.json" "$WORKDIR/base-mcp/package-lock.json"
fetch_base_file "desktop/src/package.json" "$WORKDIR/base-desktop/package.json"
fetch_base_file "desktop/src/package-lock.json" "$WORKDIR/base-desktop/package-lock.json"

cargo audit --json --file "$WORKDIR/base-cargo-root.lock" >"$WORKDIR/base-cargo-root.json" || true
cargo audit --json --file "$WORKDIR/base-cargo-desktop.lock" >"$WORKDIR/base-cargo-desktop.json" || true
cargo audit --json >"$WORKDIR/head-cargo-root.json" || true
cargo audit --json --file desktop/src-tauri/Cargo.lock >"$WORKDIR/head-cargo-desktop.json" || true

(cd "$WORKDIR/base-mcp" && npm audit --omit=dev --audit-level="$NPM_AUDIT_LEVEL" --package-lock-only --json) \
    >"$WORKDIR/base-npm-mcp.json" || true
(cd "$WORKDIR/base-desktop" && npm audit --omit=dev --audit-level="$NPM_AUDIT_LEVEL" --package-lock-only --json) \
    >"$WORKDIR/base-npm-desktop.json" || true
(cd mcp-servers && npm audit --omit=dev --audit-level="$NPM_AUDIT_LEVEL" --package-lock-only --json) \
    >"$WORKDIR/head-npm-mcp.json" || true
(cd desktop/src && npm audit --omit=dev --audit-level="$NPM_AUDIT_LEVEL" --package-lock-only --json) \
    >"$WORKDIR/head-npm-desktop.json" || true

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
