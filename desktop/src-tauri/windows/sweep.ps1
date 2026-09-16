
param(
  [ValidateSet('full', 'runtime')]
  [string]$Mode = 'full',
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

$nodePrefix = $instDir + '\nodejs\'
$desktopExe = $instDir + '\Speedwave.exe'

$instance = (Split-Path $dataDir -Leaf) -replace '^\.+', ''
if ($instance -eq 'speedwave') {
  $cliName = 'speedwave.exe'
} else {
  $cliName = 'speedwave-' + ($instance -replace '^speedwave-', '') + '.exe'
}
$cliExe = $dataDir + '\bin\' + $cliName

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
