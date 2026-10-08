#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?GH_REPO required (owner/name)}"

TITLE="audit-schedule: known vulnerabilities on dev"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$REPO_ROOT/scripts/audit-gate.py"
EXCEPTIONS="${AUDIT_EXCEPTIONS:-$REPO_ROOT/scripts/audit-exceptions.json}"
NPM_AUDIT_LEVEL="${NPM_AUDIT_LEVEL:-high}"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cd "$REPO_ROOT"

cargo audit --json >"$WORKDIR/cargo-root.json" || true
cargo audit --json --file desktop/src-tauri/Cargo.lock >"$WORKDIR/cargo-desktop.json" || true
(cd mcp-servers && npm audit --omit=dev --audit-level="$NPM_AUDIT_LEVEL" --package-lock-only --json) \
    >"$WORKDIR/npm-mcp.json" || true
(cd desktop/src && npm audit --omit=dev --audit-level="$NPM_AUDIT_LEVEL" --package-lock-only --json) \
    >"$WORKDIR/npm-desktop.json" || true

set +e
python3 "$GATE" absolute \
    --exceptions "$EXCEPTIONS" \
    --npm-min-severity "$NPM_AUDIT_LEVEL" \
    --report "cargo:$WORKDIR/cargo-root.json" \
    --report "cargo:$WORKDIR/cargo-desktop.json" \
    --report "npm:$WORKDIR/npm-mcp.json" \
    --report "npm:$WORKDIR/npm-desktop.json" \
    --markdown-out "$WORKDIR/report.md"
GATE_STATUS=$?
set -e

if [ "$GATE_STATUS" -eq 0 ]; then
    echo "No known advisories without a valid exception, nothing to report."
    exit 0
fi

gh issue list --repo "$GH_REPO" --state open --limit 100 \
    --json number,title,state >"$WORKDIR/existing.json"

PLAN="$(python3 "$GATE" issue-plan --existing "$WORKDIR/existing.json" --title "$TITLE")"
ACTION="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["action"])' "$PLAN")"

if [ "$ACTION" = "create" ]; then
    gh issue create --repo "$GH_REPO" --title "$TITLE" --body-file "$WORKDIR/report.md"
else
    NUMBER="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["number"])' "$PLAN")"
    gh issue edit "$NUMBER" --repo "$GH_REPO" --body-file "$WORKDIR/report.md"
fi
