
param(
  [ValidateSet('full', 'runtime')]
  [string]$Mode = 'full',
  [string]$InstDir,
  [string]$DataDir
)

$ErrorActionPreference = 'Stop'

$instDir = if ($InstDir) { $InstDir } else { $env:SPW_INSTDIR }
if (-not $instDir) { [Console]::Error.WriteLine('SPW_INSTDIR not set'); exit 2 }
$dataDir = if ($DataDir) { $DataDir } else { $env:SPW_DATA_DIR }
if (-not $dataDir) { [Console]::Error.WriteLine('SPW_DATA_DIR not set'); exit 2 }

$separators = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$dataDir = $dataDir.TrimEnd($separators)

$nodePrefix = [System.IO.Path]::Combine($instDir, 'nodejs') + [System.IO.Path]::DirectorySeparatorChar
$nodeExe = [System.IO.Path]::Combine($instDir, 'nodejs', 'node.exe')
$desktopExe = [System.IO.Path]::Combine($instDir, 'speedwave-desktop.exe')

$instance = (Split-Path $dataDir -Leaf) -replace '^\.+', ''
if ($instance -eq 'speedwave') {
  $cliName = 'speedwave.exe'
} else {
  $cliName = 'speedwave-' + ($instance -replace '^speedwave-', '') + '.exe'
}
$cliExe = [System.IO.Path]::Combine($dataDir, 'bin', $cliName)

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
  [Console]::Error.WriteLine('sweep enumeration failed: ' + $_)
  exit 3
}

if ($includeWorkers) {
  $targets = @($desktopExe, $nodeExe, $cliExe)
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
[Console]::Error.WriteLine('targets still locked after 20 s')
exit 4
