#!/usr/bin/env bats
# Structural tests for e2e-vm.sh: shared rsync/tar exclude array and
# PowerShell single-quote escaping of injected secrets (ps_squote).

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/e2e-vm.sh"

@test "E2E_RSYNC_EXCLUDES array is defined at script top level" {
    grep -q '^E2E_RSYNC_EXCLUDES=' "$SCRIPT"
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
    for asset in lima nodejs wsl cli mcp-os THIRD-PARTY-LICENSES; do
        echo "$excludes" | grep -q "desktop/src-tauri/${asset}" || {
            echo "missing desktop/src-tauri/${asset}"; return 1
        }
    done
}

@test "ps_squote doubles single quotes for PowerShell literals" {
    eval "$(sed -n '/^ps_squote()/,/^}/p' "$SCRIPT")"
    [ "$(ps_squote "plain")" = "plain" ]
    [ "$(ps_squote "")" = "" ]
    [ "$(ps_squote "o'brien")" = "o''brien" ]
    [ "$(ps_squote "a'b'c")" = "a''b''c" ]
    # Breakout attempt: '; calc; ' stays a single PS literal after doubling.
    [ "$(ps_squote "'; calc; '")" = "''; calc; ''" ]
}

@test "every windows_ps env injection goes through ps_squote" {
    local body assignments squoted
    body="$(sed -n '/^windows_ps()/,/^}/p' "$SCRIPT")"
    assignments="$(echo "$body" | grep -c "= '")"
    squoted="$(echo "$body" | grep -c "= '\$(ps_squote ")"
    [ "$assignments" -gt 0 ]
    [ "$assignments" -eq "$squoted" ]
}
