#!/usr/bin/env bats
# Alignment guard: every standalone cargo workspace (own Cargo.lock) must sit in the single
# cargo entry of dependabot.yml, grouped by dependency name, or a shared-manifest bump splits
# into per-directory half-PRs that leave the other lockfiles stale.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
DEPENDABOT="$REPO_ROOT/.github/dependabot.yml"

# Lines of the cargo `updates` entry, from its `- package-ecosystem: cargo` line to the next entry.
_cargo_entry() {
    awk '
        /^  - package-ecosystem:/ { in_cargo = ($3 == "cargo") }
        in_cargo { print }
    ' "$DEPENDABOT"
}

# `directories` items of the cargo entry, quotes stripped.
_cargo_directories() {
    _cargo_entry | awk '
        /^    directories:/ { in_dirs = 1; next }
        in_dirs && /^      - / { sub(/^      - /, ""); gsub(/"/, ""); print; next }
        in_dirs { in_dirs = 0 }
    ' | sort
}

# Repo-relative directories holding a Cargo.lock (`/` for the root workspace).
_cargo_lock_dirs() {
    (
        cd "$REPO_ROOT" &&
            find . -name Cargo.lock \
                -not -path '*/target/*' -not -path '*/node_modules/*' -not -path './.claude/*' |
            sed 's|/Cargo.lock$||; s|^\.$|/|; s|^\./|/|' | sort
    )
}

# Names of cargo groups lacking `group-by: dependency-name`.
_cargo_groups_without_group_by() {
    _cargo_entry | awk '
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

@test "dependabot.yml has exactly one cargo entry" {
    count="$(grep -c '^  - package-ecosystem: cargo$' "$DEPENDABOT")"
    if [ "$count" -ne 1 ]; then
        echo "Found $count cargo entries; a second entry re-creates duplicate half-PRs per directory."
        return 1
    fi
}

@test "cargo entry lists workspaces under the plural directories key" {
    if _cargo_entry | grep -q '^    directory:'; then
        echo "The cargo entry uses the singular 'directory:' key; use 'directories:' so one PR spans every workspace."
        return 1
    fi
    _cargo_entry | grep -q '^    directories:$'
}

@test "every cargo workspace with its own Cargo.lock is a Dependabot cargo directory" {
    lock_dirs="$(_cargo_lock_dirs)"
    echo "$lock_dirs" | grep -qx '/'
    listed="$(_cargo_directories)"
    [ -n "$listed" ]

    missing="$(comm -23 <(echo "$lock_dirs") <(echo "$listed"))"
    if [ -n "$missing" ]; then
        echo "Cargo.lock directories missing from dependabot.yml cargo directories:"
        echo "$missing"
        return 1
    fi
}

@test "every Dependabot cargo directory holds a Cargo.lock" {
    listed="$(_cargo_directories)"
    [ -n "$listed" ]
    lock_dirs="$(_cargo_lock_dirs)"

    stale="$(comm -13 <(echo "$lock_dirs") <(echo "$listed"))"
    if [ -n "$stale" ]; then
        echo "dependabot.yml cargo directories without a Cargo.lock (remove or fix the path):"
        echo "$stale"
        return 1
    fi
}

@test "every cargo group is grouped across directories by dependency name" {
    group_count="$(_cargo_entry | grep -c '^      [A-Za-z0-9_-]*:[[:space:]]*$')"
    [ "$group_count" -ge 1 ]

    ungrouped="$(_cargo_groups_without_group_by)"
    if [ -n "$ungrouped" ]; then
        echo "Cargo groups without 'group-by: dependency-name' (they would open one PR per directory):"
        echo "$ungrouped"
        return 1
    fi
}
