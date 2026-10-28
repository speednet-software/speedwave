#!/usr/bin/env bash

set -euo pipefail

command -v jq >/dev/null 2>&1 || {
    echo "::error::ci-gate: jq is required"
    exit 1
}

NEEDS_JSON="${NEEDS_JSON:-}"

if [[ -z "$NEEDS_JSON" ]] || ! jq -e 'type == "object"' <<<"$NEEDS_JSON" >/dev/null 2>&1; then
    echo "::error::ci-gate: NEEDS_JSON must be the workflow's toJSON(needs) object (got: ${NEEDS_JSON:-<empty>})"
    exit 1
fi

jobs="$(jq -r '
    to_entries
    | map({key, result: (.value.result? // "missing"), group: (.key | sub("-[0-9]+$"; ""))})
    | group_by(.group)[]
    | if length == 1 and .[0].key == .[0].group then
        "\(.[0].key)\tjob\t\(.[0].result)"
      else
        "\(.[0].group)\tattempts\t\(sort_by(.key | capture("-(?<n>[0-9]+)$").n | tonumber) | map(.result) | join(", "))"
      end
' <<<"$NEEDS_JSON")"
if [[ -z "$jobs" ]]; then
    echo "::error::ci-gate: no jobs to gate — every test.yml job must be listed in ci-gate's needs"
    exit 1
fi

failed=0
while IFS=$'\t' read -r job kind result; do
    if [[ "$kind" == "attempts" ]]; then
        if [[ ", $result," == *", success,"* ]]; then
            echo "✅ $job: success (attempts: $result)"
        elif [[ ", $result," =~ ^(,\ (cancelled|abandoned|skipped))+,$ && "$result" != skipped* ]]; then
            echo "::error::ci-gate: $job: none of its attempts got a runner (attempts: $result)"
            failed=1
        else
            echo "::error::ci-gate: $job: no attempt succeeded (attempts: $result)"
            failed=1
        fi
    elif [[ "$result" == "success" ]]; then
        echo "✅ $job: $result"
    else
        echo "::error::ci-gate: $job finished with result '$result' (required: success)"
        failed=1
    fi
done <<<"$jobs"

if [[ "$failed" -ne 0 ]]; then
    echo "::error::ci-gate: a job did not succeed — the PR stays blocked until every job is green"
    exit 1
fi
echo "✅ ci-gate: every job succeeded"
