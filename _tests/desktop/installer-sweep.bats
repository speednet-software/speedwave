#!/usr/bin/env bats

REPO_ROOT="$BATS_TEST_DIRNAME/../.."
SWEEP="$REPO_ROOT/desktop/src-tauri/windows/sweep.ps1"

setup() {
    if ! command -v pwsh >/dev/null 2>&1; then
        [ -z "${CI:-}" ] || {
            echo "pwsh is required in CI to run sweep.ps1" >&2
            return 1
        }
        skip "pwsh is not installed"
    fi
    WORK="$(mktemp -d)"
    INST="$WORK/Local/Speedwave"
    DATA="$WORK/profile/.speedwave"
    mkdir -p "$INST/nodejs" "$DATA/bin"
    touch "$INST/speedwave-desktop.exe" "$INST/nodejs/node.exe" "$DATA/bin/speedwave.exe"
    cat >"$WORK/stubbed-sweep.ps1" <<'EOF'
param([string]$Sweep, [string]$Mode = 'full', [string]$Running = '', [switch]$EnumerationFails)
function Get-CimInstance {
  param($ClassName, $ErrorAction)
  if ($EnumerationFails) { throw 'the process list is unavailable' }
  foreach ($entry in @($Running -split ';' | Where-Object { $_ })) {
    $id, $path = $entry -split '=', 2
    [pscustomobject]@{ ProcessId = [int]$id; ExecutablePath = $path }
  }
}
function Stop-Process {
  param($Id, [switch]$Force, $ErrorAction)
  Write-Output ('stopped ' + $Id)
}
& $Sweep -Mode $Mode
exit $LASTEXITCODE
EOF
}

teardown() {
    [ -z "${HOLDER_PID:-}" ] || kill "$HOLDER_PID" 2>/dev/null || true
    [ -z "${WORK:-}" ] || rm -rf "$WORK"
}

run_sweep() {
    run env SPW_INSTDIR="$INST" SPW_DATA_DIR="$DATA" \
        pwsh -NoProfile -NonInteractive -File "$WORK/stubbed-sweep.ps1" -Sweep "$SWEEP" "$@"
}

stopped() {
    grep '^stopped ' <<<"$output" | sort | tr '\n' ' '
}

@test "sweep.ps1 lets an update proceed at once when nothing runs from the install" {
    run_sweep
    [ "$status" -eq 0 ]
    [[ "$output" == *"all targets unlocked"* ]]
}

@test "sweep.ps1 stops the desktop, the workers and the CLI of this install and nothing else" {
    run_sweep -Running "11=$INST/speedwave-desktop.exe;12=$INST/nodejs/node.exe;13=$DATA/bin/speedwave.exe;14=$INST/NODEJS/Node.exe;21=$WORK/other/nodejs/node.exe;22=$INST/nodejs-old/node.exe;23=/usr/local/bin/node"
    [ "$status" -eq 0 ]
    [ "$(stopped)" = "stopped 11 stopped 12 stopped 13 stopped 14 " ]
}

@test "sweep.ps1 in runtime mode stops only the CLI" {
    run_sweep -Mode runtime -Running "11=$INST/speedwave-desktop.exe;12=$INST/nodejs/node.exe;13=$DATA/bin/speedwave.exe"
    [ "$status" -eq 0 ]
    [ "$(stopped)" = "stopped 13 " ]
}

@test "sweep.ps1 stops the CLI of a named instance, not the production one" {
    DATA="$WORK/profile/.speedwave-dev"
    run_sweep -Mode runtime -Running "13=$DATA/bin/speedwave-dev.exe;14=$WORK/profile/.speedwave/bin/speedwave.exe"
    [ "$status" -eq 0 ]
    [ "$(stopped)" = "stopped 13 " ]
}

@test "sweep.ps1 waits for a target another process holds and then fails with exit 4" {
    pwsh -NoProfile -NonInteractive -Command "\$held = [System.IO.File]::Open('$INST/nodejs/node.exe', 'Open', 'Write', 'None'); New-Item -ItemType File -Path '$WORK/holding' | Out-Null; Start-Sleep -Seconds 60" 3>&- &
    HOLDER_PID=$!
    for _ in $(seq 1 50); do
        [ -e "$WORK/holding" ] && break
        sleep 0.2
    done
    [ -e "$WORK/holding" ]
    run_sweep
    [ "$status" -eq 4 ]
    [[ "$output" == *"targets still locked after 20 s"* ]]
}

@test "sweep.ps1 fails with exit 3 when it cannot list processes" {
    run_sweep -EnumerationFails
    [ "$status" -eq 3 ]
    [[ "$output" == *"sweep enumeration failed"* ]]
}

@test "sweep.ps1 fails with exit 2 without the install dir" {
    run env -u SPW_INSTDIR SPW_DATA_DIR="$DATA" \
        pwsh -NoProfile -NonInteractive -File "$WORK/stubbed-sweep.ps1" -Sweep "$SWEEP"
    [ "$status" -eq 2 ]
    [[ "$output" == *"SPW_INSTDIR not set"* ]]
}

@test "sweep.ps1 fails with exit 2 without the data dir" {
    run env -u SPW_DATA_DIR SPW_INSTDIR="$INST" \
        pwsh -NoProfile -NonInteractive -File "$WORK/stubbed-sweep.ps1" -Sweep "$SWEEP"
    [ "$status" -eq 2 ]
    [[ "$output" == *"SPW_DATA_DIR not set"* ]]
}
