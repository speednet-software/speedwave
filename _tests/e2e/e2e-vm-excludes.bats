#!/usr/bin/env bats
# Structural test: verifies that rsync/tar transfer functions in e2e-vm.sh
# use a shared exclude array and contain required excludes.

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/e2e-vm.sh"

@test "E2E_RSYNC_EXCLUDES array is defined at script top level" {
    grep -q '^E2E_RSYNC_EXCLUDES=' "$SCRIPT"
}

@test "linux_rsync_to references E2E_RSYNC_EXCLUDES" {
    local body
    body="$(sed -n '/^linux_rsync_to()/,/^}/p' "$SCRIPT")"
    echo "$body" | grep -q 'E2E_RSYNC_EXCLUDES'
}

@test "macos_rsync_to references E2E_RSYNC_EXCLUDES" {
    local body
    body="$(sed -n '/^macos_rsync_to()/,/^}/p' "$SCRIPT")"
    echo "$body" | grep -q 'E2E_RSYNC_EXCLUDES'
}

@test "windows_rsync_to references E2E_RSYNC_EXCLUDES" {
    local body
    body="$(sed -n '/^windows_rsync_to()/,/^}/p' "$SCRIPT")"
    echo "$body" | grep -q 'E2E_RSYNC_EXCLUDES'
}

@test "shared excludes contain .angular and .build" {
    local excludes
    excludes="$(sed -n '/^E2E_RSYNC_EXCLUDES=(/,/)/p' "$SCRIPT")"
    echo "$excludes" | grep -q '\.angular' || { echo "missing .angular"; return 1; }
    echo "$excludes" | grep -q '\.build' || { echo "missing .build"; return 1; }
}

@test "shared excludes contain desktop/src-tauri bundled asset dirs" {
    local excludes
    excludes="$(sed -n '/^E2E_RSYNC_EXCLUDES=(/,/)/p' "$SCRIPT")"
    for asset in lima nerdctl-full nodejs wsl cli mcp-os THIRD-PARTY-LICENSES; do
        echo "$excludes" | grep -q "desktop/src-tauri/${asset}" || {
            echo "missing desktop/src-tauri/${asset}"; return 1
        }
    done
}
