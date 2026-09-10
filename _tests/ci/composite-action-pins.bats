#!/usr/bin/env bats
# Alignment guard: composite actions under .github/actions pin the same action refs as the
# workflows, and Dependabot's github-actions entry scans them (a bare `/` covers workflows only).

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
DEPENDABOT="$REPO_ROOT/.github/dependabot.yml"
COMPOSITE_GLOB="/.github/actions/*"

# Lines of the github-actions `updates` entry, from its `- package-ecosystem:` line to the next entry.
_actions_entry() {
    awk '
        /^  - package-ecosystem:/ { in_entry = ($3 == "github-actions") }
        in_entry { print }
    ' "$DEPENDABOT"
}

# `directories` items of the github-actions entry, quotes stripped.
_actions_directories() {
    _actions_entry | awk '
        /^    directories:/ { in_dirs = 1; next }
        in_dirs && /^      - / { sub(/^      - /, ""); gsub(/"/, ""); print; next }
        in_dirs { in_dirs = 0 }
    ' | sort
}

# Repo-relative directories of tracked composite actions, e.g. `/.github/actions/setup-toolchain`.
_composite_dirs() {
    git -C "$REPO_ROOT" ls-files -- '.github/actions/*/action.yml' '.github/actions/*/action.yaml' |
        sed -E 's|/action\.ya?ml$||; s|^|/|' | sort -u
}

# Names of github-actions groups lacking `group-by: dependency-name`.
_actions_groups_without_group_by() {
    _actions_entry | awk '
        /^    groups:/ { in_groups = 1; next }
        in_groups && /^    [a-z]/ { in_groups = 0 }
        in_groups && /^      [A-Za-z0-9_-]+:[[:space:]]*$/ {
            if (name != "" && !ok) print name
            name = $1; sub(/:$/, "", name); ok = 0; next
        }
        in_groups && /^        group-by: dependency-name[[:space:]]*$/ { ok = 1 }
        END { if (name != "" && !ok) print name }
    '
}

# `owner/repo[/path]<TAB>ref` for every external `uses:` in workflows and composite actions.
_external_uses() {
    grep -h -o -E 'uses:[[:space:]]+[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[A-Za-z0-9_./-]+)?@[^[:space:]]+' \
        "$REPO_ROOT"/.github/workflows/*.yml "$REPO_ROOT"/.github/actions/*/action.yml |
        sed -E 's/^uses:[[:space:]]+//; s/@/\t/' | sort -u
}

@test "composite action guard is not vacuous: setup-toolchain is a tracked composite action" {
    _composite_dirs | grep -qx '/.github/actions/setup-toolchain'
}

@test "dependabot.yml has exactly one github-actions entry" {
    count="$(grep -c '^  - package-ecosystem: github-actions$' "$DEPENDABOT")"
    if [ "$count" -ne 1 ]; then
        echo "Found $count github-actions entries; overlapping entries are rejected by Dependabot."
        return 1
    fi
}

@test "github-actions entry lists locations under the plural directories key" {
    if _actions_entry | grep -q '^    directory:'; then
        echo "The github-actions entry uses the singular 'directory:' key; use 'directories:' so composite actions are scanned too."
        return 1
    fi
    _actions_entry | grep -q '^    directories:$'
}

@test "github-actions entry still scans the workflows directory" {
    _actions_directories | grep -qx '/'
}

@test "every composite action directory is scanned by the github-actions entry" {
    listed="$(_actions_directories)"
    [ -n "$listed" ]
    if echo "$listed" | grep -qxF "$COMPOSITE_GLOB"; then
        return 0
    fi

    missing="$(comm -23 <(_composite_dirs) <(echo "$listed"))"
    if [ -n "$missing" ]; then
        echo "Composite action directories missing from the github-actions directories (list them or add '$COMPOSITE_GLOB'):"
        echo "$missing"
        return 1
    fi
}

@test "every github-actions group is grouped across directories by dependency name" {
    group_count="$(_actions_entry | grep -c '^      [A-Za-z0-9_-]*:[[:space:]]*$')"
    [ "$group_count" -ge 1 ]

    ungrouped="$(_actions_groups_without_group_by)"
    if [ -n "$ungrouped" ]; then
        echo "github-actions groups without 'group-by: dependency-name' (a bump would land as per-directory half-PRs):"
        echo "$ungrouped"
        return 1
    fi
}

@test "github-actions groups cover both minor/patch and major bumps" {
    _actions_entry | grep -q '^          - patch$'
    _actions_entry | grep -q '^          - major$'
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
