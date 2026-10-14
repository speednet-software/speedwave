#!/usr/bin/env bats

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-node-version.sh"
PIN="$(cat "$REPO_ROOT/.node-version")"

setup() {
    STUB_DIR="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$STUB_DIR"
    IFS=. read -r PIN_MAJOR PIN_MINOR PIN_PATCH <<<"$PIN"
}

stub_node() {
    printf '#!/usr/bin/env bash\necho "%s"\n' "$1" >"$STUB_DIR/node"
    chmod +x "$STUB_DIR/node"
}

run_check() {
    PATH="$STUB_DIR:/usr/bin:/bin" run bash "$CHECK" "$PIN"
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
