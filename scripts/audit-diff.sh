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

AUDIT_LOCKFILES=()
while read -r _ _ lockfile; do
    AUDIT_LOCKFILES+=("$lockfile")
done < <("$AUDIT_RUN" --list)

if [ "$(python3 "$GATE" lockfiles-touched --changed "$WORKDIR/changed.json" "${AUDIT_LOCKFILES[@]}")" = "false" ]; then
    echo "No package-lock.json or Cargo.lock in the diff, green without auditing."
    exit 0
fi

fetch_base_file() {
    local ref_path="$1" out="$2"
    mkdir -p "$(dirname "$out")"
    git show "${AUDIT_BASE_SHA}:${ref_path}" >"$out"
}

BASE_ROOT="$WORKDIR/base"
TARGETS=()
KINDS=()
while read -r target kind lockfile; do
    TARGETS+=("$target")
    KINDS+=("$kind")
    fetch_base_file "$lockfile" "$BASE_ROOT/$lockfile"
    if [ "$kind" = "npm" ]; then
        manifest="$(dirname "$lockfile")/package.json"
        fetch_base_file "$manifest" "$BASE_ROOT/$manifest"
    fi
done < <("$AUDIT_RUN" --list)

GATE_ARGS=()
for i in "${!TARGETS[@]}"; do
    target="${TARGETS[$i]}"
    "$AUDIT_RUN" "$target" "$WORKDIR/base-$target.json" "$BASE_ROOT"
    "$AUDIT_RUN" "$target" "$WORKDIR/head-$target.json"
    GATE_ARGS+=(--base "${KINDS[$i]}:$WORKDIR/base-$target.json" --head "${KINDS[$i]}:$WORKDIR/head-$target.json")
done

python3 "$GATE" diff \
    --exceptions "$EXCEPTIONS" \
    --npm-min-severity "$NPM_AUDIT_LEVEL" \
    "${GATE_ARGS[@]}"
