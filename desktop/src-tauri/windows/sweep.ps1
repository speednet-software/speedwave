# SSOT: process sweep for Speedwave Windows upgrades.
# Consumed by: NSIS PREINSTALL hook, WiX CustomAction, setup_wizard::link_cli.
# Env: SPW_INSTDIR (Tauri app dir) + SPW_DATA_DIR (speedwave data dir).
# Args: -Mode full|runtime
#   full    (default; install-time): kill Speedwave.exe + nodejs\*.exe + bin\speedwave.exe.
#   runtime (Tauri Desktop pre-link): kill only bin\speedwave.exe — Tauri must NOT
#           target its own workers or itself or the sweep deadlocks on its own locks.
# Exits: 0 ok, 2 missing env, 3 enum failed, 4 lock timeout.
# See ADR-048 for design constraints (string concat, OrdinalIgnoreCase, CIM).

param(
  [ValidateSet('full', 'runtime')]
  [string]$Mode = 'full',
  # Params override env; the WiX CA passes paths as args (never interpolated
  # into a -Command literal) while NSIS/Tauri callers still use env vars.
  [string]$InstDir,
  [string]$DataDir
)

$ErrorActionPreference = 'Stop'

$instDir = if ($InstDir) { $InstDir } else { $env:SPW_INSTDIR }
if (-not $instDir) { Write-Error 'SPW_INSTDIR not set'; exit 2 }
$dataDir = if ($DataDir) { $DataDir } else { $env:SPW_DATA_DIR }
if (-not $dataDir) { Write-Error 'SPW_DATA_DIR not set'; exit 2 }

$instDir = $instDir.TrimEnd('\')
$dataDir = $dataDir.TrimEnd('\')

# String concat per ADR-048.
$nodePrefix = $instDir + '\nodejs\'
$desktopExe = $instDir + '\Speedwave.exe'
$cliExe = $dataDir + '\bin\speedwave.exe'

# Runtime mode: scope to the CLI binary only (Tauri Desktop is itself running
# the sweep — killing its own workers / self deadlocks the lock-poll).
$includeWorkers = ($Mode -eq 'full')

try {
  $procs = Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue
  $victims = $procs | Where-Object {
    $_.ExecutablePath -and (
      ($includeWorkers -and $_.ExecutablePath.StartsWith($nodePrefix, [System.StringComparison]::OrdinalIgnoreCase)) -or
      ($includeWorkers -and $_.ExecutablePath.Equals($desktopExe, [System.StringComparison]::OrdinalIgnoreCase)) -or
      $_.ExecutablePath.Equals($cliExe, [System.StringComparison]::OrdinalIgnoreCase)
    )
  }
  foreach ($v in $victims) {
    Write-Output ('killing PID ' + $v.ProcessId + ' ' + $v.ExecutablePath)
    Stop-Process -Id $v.ProcessId -Force -ErrorAction SilentlyContinue
  }
} catch {
  Write-Error ('sweep enumeration failed: ' + $_)
  exit 3
}

# Poll write access. Returns when all targets unlock, or 20 s timeout.
if ($includeWorkers) {
  $targets = @($desktopExe, $nodePrefix + 'node.exe', $cliExe)
} else {
  $targets = @($cliExe)
}
for ($i = 0; $i -lt 20; $i++) {
  $locked = $false
  foreach ($t in $targets) {
    if (-not (Test-Path -LiteralPath $t)) { continue }
    try {
      $fs = [System.IO.File]::Open($t, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      $fs.Close()
    } catch {
      $locked = $true
      break
    }
  }
  if (-not $locked) { Write-Output 'all targets unlocked'; exit 0 }
  Start-Sleep -Milliseconds 1000
}
Write-Error 'targets still locked after 20 s'
exit 4
