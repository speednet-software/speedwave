#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

_composite_dirs() {
    git -C "$REPO_ROOT" ls-files -- '.github/actions/*/action.yml' '.github/actions/*/action.yaml' |
        sed -E 's|/action\.ya?ml$||; s|^|/|' | sort -u
}

_external_uses() {
    grep -h -o -E 'uses:[[:space:]]+[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[A-Za-z0-9_./-]+)?@[^[:space:]]+' \
        "$REPO_ROOT"/.github/workflows/*.yml "$REPO_ROOT"/.github/actions/*/action.yml |
        sed -E 's/^uses:[[:space:]]+//; s/@/\t/' | sort -u
}

@test "composite action guard is not vacuous: setup-toolchain is a tracked composite action" {
    _composite_dirs | grep -qx '/.github/actions/setup-toolchain'
}

@test "every external action is pinned to one ref across workflows and composite actions" {
    uses="$(_external_uses)"
    [ -n "$uses" ]
    echo "$uses" | grep -q '^actions/setup-node'

    drifted="$(echo "$uses" | cut -f1 | uniq -d)"
    if [ -n "$drifted" ]; then
        echo "Actions pinned to more than one ref (align .github/actions/*/action.yml with the workflows):"
        while IFS= read -r action; do
            echo "$uses" | grep "^${action}"$'\t'
        done <<< "$drifted"
        return 1
    fi
}
