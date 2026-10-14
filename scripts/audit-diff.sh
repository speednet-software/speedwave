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

NPM_TARGETS=(npm-root npm-mcp npm-playwright npm-desktop npm-e2e)
CARGO_TARGETS=(cargo-root cargo-desktop)
NPM_DIRS=("." mcp-servers mcp-servers/playwright desktop/src desktop/e2e)

BASE_ROOT="$WORKDIR/base"
fetch_base_file "Cargo.lock" "$BASE_ROOT/Cargo.lock"
fetch_base_file "desktop/src-tauri/Cargo.lock" "$BASE_ROOT/desktop/src-tauri/Cargo.lock"
for dir in "${NPM_DIRS[@]}"; do
    fetch_base_file "${dir#./}/package.json" "$BASE_ROOT/${dir#./}/package.json"
    fetch_base_file "${dir#./}/package-lock.json" "$BASE_ROOT/${dir#./}/package-lock.json"
done

GATE_ARGS=()
for target in "${CARGO_TARGETS[@]}" "${NPM_TARGETS[@]}"; do
    "$AUDIT_RUN" "$target" "$WORKDIR/base-$target.json" "$BASE_ROOT"
    "$AUDIT_RUN" "$target" "$WORKDIR/head-$target.json"
done

for target in "${CARGO_TARGETS[@]}"; do
    GATE_ARGS+=(--base "cargo:$WORKDIR/base-$target.json" --head "cargo:$WORKDIR/head-$target.json")
done
for target in "${NPM_TARGETS[@]}"; do
    GATE_ARGS+=(--base "npm:$WORKDIR/base-$target.json" --head "npm:$WORKDIR/head-$target.json")
done

python3 "$GATE" diff \
    --exceptions "$EXCEPTIONS" \
    --npm-min-severity "$NPM_AUDIT_LEVEL" \
    "${GATE_ARGS[@]}"
