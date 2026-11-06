#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?GH_REPO required (owner/name)}"
: "${GITHUB_SHA:=unknown}" "${GITHUB_SERVER_URL:=https://github.com}" "${GITHUB_REPOSITORY:=$GH_REPO}" "${GITHUB_RUN_ID:=0}"

TITLE="audit-schedule: known vulnerabilities on dev"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$REPO_ROOT/scripts/audit-gate.py"
AUDIT_RUN="$REPO_ROOT/scripts/audit-run.sh"
EXCEPTIONS="${AUDIT_EXCEPTIONS:-$REPO_ROOT/scripts/audit-exceptions.json}"
NPM_AUDIT_LEVEL="${NPM_AUDIT_LEVEL:-$(python3 "$GATE" print-npm-default-severity)}"
export NPM_AUDIT_LEVEL

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cd "$REPO_ROOT"

REPORT_ARGS=()
while read -r target kind _; do
    "$AUDIT_RUN" "$target" "$WORKDIR/$target.json"
    REPORT_ARGS+=(--report "$kind:$WORKDIR/$target.json")
done < <("$AUDIT_RUN" --list)

set +e
python3 "$GATE" absolute \
    --exceptions "$EXCEPTIONS" \
    --npm-min-severity "$NPM_AUDIT_LEVEL" \
    "${REPORT_ARGS[@]}" \
    --markdown-out "$WORKDIR/report.md"
GATE_STATUS=$?
set -e

if [ "$GATE_STATUS" -eq 0 ]; then
    STATUS=green
else
    STATUS=red
fi

# --search scopes the query to this exact title (GitHub's `in:title` search
# qualifier) instead of listing every open issue in the repo: a repo with
# more than 100 open issues no longer risks missing an older duplicate past
# a plain `gh issue list --limit 100`.
gh issue list --repo "$GH_REPO" --state open --search "\"$TITLE\" in:title" --limit 100 \
    --json number,title,state >"$WORKDIR/existing.json"

PLAN="$(python3 "$GATE" issue-plan --status "$STATUS" --existing "$WORKDIR/existing.json" --title "$TITLE")"
ACTION="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["action"])' "$PLAN")"

case "$ACTION" in
    create)
        NUMBER="$(gh issue create --repo "$GH_REPO" --title "$TITLE" --body-file "$WORKDIR/report.md" | grep -oE '[0-9]+$')"
        CLOSE_COMMENT="Duplicate of the single audit-schedule issue, superseded by #$NUMBER."
        ;;
    update)
        NUMBER="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["number"])' "$PLAN")"
        gh issue edit "$NUMBER" --repo "$GH_REPO" --body-file "$WORKDIR/report.md"
        CLOSE_COMMENT="Duplicate of the single audit-schedule issue, superseded by #$NUMBER."
        ;;
    close)
        CLOSE_COMMENT="Audit green on dev at ${GITHUB_SHA:0:7}, run $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
        ;;
esac

python3 -c 'import json,sys; print("\n".join(str(n) for n in json.loads(sys.argv[1])["close"]))' "$PLAN" |
    while IFS= read -r number; do
        [ -n "$number" ] || continue
        gh issue close "$number" --repo "$GH_REPO" --comment "$CLOSE_COMMENT"
    done

if [ "$STATUS" = red ]; then
    echo "Audit red: advisories without a valid exception, see the audit-schedule issue." >&2
    exit 1
fi
echo "No known advisories without a valid exception."
