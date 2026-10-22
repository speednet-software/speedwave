#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

_make() {
    env -u MAKEFLAGS -u MFLAGS -u MAKELEVEL make --no-print-directory -C "$REPO_ROOT" "$@"
}

_project_with_lockfile() {
    PROJECT="$BATS_TEST_TMPDIR/project"
    mkdir -p "$PROJECT"
    printf '{}\n' >"$PROJECT/package-lock.json"
}

_installed_at() {
    mkdir -p "$PROJECT/node_modules"
    printf '{}\n' >"$PROJECT/node_modules/.package-lock.json"
    touch -t "$1" "$PROJECT/node_modules/.package-lock.json"
}

@test "an install older than package-lock.json runs npm ci in its project" {
    _project_with_lockfile
    _installed_at 202001010000
    run _make -n "$PROJECT/node_modules/.package-lock.json"
    [ "$status" -eq 0 ]
    [ "$output" = "cd $PROJECT && npm ci" ]
}

@test "a project that was never installed runs npm ci" {
    _project_with_lockfile
    run _make -n "$PROJECT/node_modules/.package-lock.json"
    [ "$status" -eq 0 ]
    [ "$output" = "cd $PROJECT && npm ci" ]
}

@test "an install newer than package-lock.json is left alone" {
    _project_with_lockfile
    touch -t 202001010000 "$PROJECT/package-lock.json"
    _installed_at 202101010000
    run _make -q "$PROJECT/node_modules/.package-lock.json"
    [ "$status" -eq 0 ]
}

@test "every target that runs npm or npx in desktop/src or mcp-servers installs that project first" {
    pairs="$(awk '
        /^[A-Za-z0-9_.-]+:/ { target = $1; sub(/:.*/, "", target) }
        /^\t/ && match($0, /cd (desktop\/src|mcp-servers)(\/[^ ]*)? && \$\((NPM|NPX)\)/) {
            project = substr($0, RSTART + 3, 11) == "desktop/src" ? "desktop/src" : "mcp-servers"
            print target, project
        }' "$REPO_ROOT/Makefile" | sort -u)"
    [ "$(printf '%s\n' "$pairs" | grep -c .)" -ge 10 ]
    while read -r target project; do
        run _make -n -W "$project/package-lock.json" "$target"
        [ "$status" -eq 0 ] && [[ "$output" == *"cd $project && npm ci"* ]] || {
            echo "make $target does not run npm ci in $project first ($status): $output"
            return 1
        }
    done <<<"$pairs"
}

@test "make dev installs desktop/src first on macOS and on Windows" {
    for os in "" Windows_NT; do
        run _make -pq OS="$os" dev-config
        dev_rule="$(printf '%s\n' "$output" | grep -E '^dev:')"
        [[ "$dev_rule" == *" desktop/src/node_modules/.package-lock.json"* ]] || {
            echo "OS='$os' dev rule: $dev_rule"
            return 1
        }
    done
}
