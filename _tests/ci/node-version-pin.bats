#!/usr/bin/env bats
# `.node-version` is the only Node pin: every CI setup reads it, no `.nvmrc` shadow copy exists,
# the Makefile carries no literal fallback, and scripts/check-node-version.sh gates `make setup-dev`.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-node-version.sh"
PIN="$(cat "$REPO_ROOT/.node-version")"

setup() {
    STUB_DIR="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$STUB_DIR"
    IFS=. read -r PIN_MAJOR PIN_MINOR PIN_PATCH <<<"$PIN"
}

# Fake `node` on PATH whose `node --version` prints the given text.
stub_node() {
    printf '#!/usr/bin/env bash\necho "%s"\n' "$1" >"$STUB_DIR/node"
    chmod +x "$STUB_DIR/node"
}

# Runs the check with the stub dir first on PATH; a bare PATH so a missing stub means no `node`.
run_check() {
    PATH="$STUB_DIR:/usr/bin:/bin" run bash "$CHECK" "$PIN"
}

@test "pin is a bare semver (Makefile builds nodejs.org URLs from it)" {
    [[ "$PIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

@test "no .nvmrc shadow copy is tracked" {
    run git -C "$REPO_ROOT" ls-files -- .nvmrc
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "every CI node-version-file points at .node-version and no workflow inlines a version" {
    run grep -rn --include='*.yml' --include='*.yaml' -E 'node-version(-file)?:' "$REPO_ROOT/.github"
    [ "$status" -eq 0 ]
    while IFS= read -r line; do
        [[ "$line" == *"node-version-file: .node-version"* ]] || {
            echo "unexpected Node pin: $line"
            return 1
        }
    done <<<"$output"
}

@test "Makefile reads NODE_VERSION from .node-version without a literal fallback" {
    run grep -cE '^NODE_VERSION := \$\(shell cat \.node-version\)$' "$REPO_ROOT/Makefile"
    [ "$output" = "1" ]
    run grep -n 'REQUIRED_NODE_MAJOR' "$REPO_ROOT/Makefile"
    [ "$status" -ne 0 ]
}

@test "make setup-dev delegates the Node check to the script with the pin" {
    grep -q 'bash scripts/check-node-version.sh "$(NODE_VERSION)"' "$REPO_ROOT/Makefile"
}

@test "check passes on the exact pin" {
    stub_node "v$PIN"
    run_check
    [ "$status" -eq 0 ]
    [[ "$output" == *"✅ node $PIN"* ]]
}

@test "check passes on a newer patch and a newer major" {
    stub_node "v${PIN_MAJOR}.${PIN_MINOR}.$((PIN_PATCH + 1))"
    run_check
    [ "$status" -eq 0 ]
    stub_node "v$((PIN_MAJOR + 1)).0.0"
    run_check
    [ "$status" -eq 0 ]
}

@test "check fails on an older minor and names the pin" {
    if [ "$PIN_MINOR" -gt 0 ]; then
        older="${PIN_MAJOR}.$((PIN_MINOR - 1)).99"
    else
        older="$((PIN_MAJOR - 1)).99.99"
    fi
    stub_node "v$older"
    run_check
    [ "$status" -eq 1 ]
    [[ "$output" == *"❌ node $older"* ]]
    [[ "$output" == *"requires ${PIN}+"* ]]
}

@test "check fails when node is missing and names the pin" {
    run_check
    [ "$status" -eq 1 ]
    [[ "$output" == *"node not found"* ]]
    [[ "$output" == *"$PIN"* ]]
}

@test "check fails on unreadable node output" {
    stub_node "not a version"
    run_check
    [ "$status" -eq 1 ]
    [[ "$output" == *"unreadable"* ]]
}
