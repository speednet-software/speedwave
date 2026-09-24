param(
  [string]$InstDir,
  [string]$DataDir,
  [string]$DefaultInstDir,
  [string]$DesktopProcess = 'speedwave-desktop'
)

$ErrorActionPreference = 'Stop'

$instDir = if ($InstDir) { $InstDir } else { $env:SPW_INSTDIR }
$dataDir = if ($DataDir) { $DataDir } else { $env:SPW_DATA_DIR }
$defaultInstDir = if ($DefaultInstDir) { $DefaultInstDir } else { $env:SPW_DEFAULT_INSTDIR }
if (-not $instDir -or -not $dataDir -or -not $defaultInstDir) {
  [Console]::Error.WriteLine('SPW_INSTDIR, SPW_DATA_DIR and SPW_DEFAULT_INSTDIR must all be set')
  exit 2
}

$separators = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
function Get-NormalizedPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path).TrimEnd($separators)
}

$instDir = Get-NormalizedPath $instDir
if (-not $instDir.Equals((Get-NormalizedPath $defaultInstDir), [System.StringComparison]::OrdinalIgnoreCase)) {
  Write-Output ('skipped: ' + $instDir + ' is not the default install dir')
  exit 10
}
if ($instDir.Equals((Get-NormalizedPath $dataDir), [System.StringComparison]::OrdinalIgnoreCase)) {
  Write-Output ('skipped: ' + $instDir + ' is also the Speedwave data dir')
  exit 11
}
if (Get-Process -Name $DesktopProcess -ErrorAction SilentlyContinue) {
  Write-Output ('skipped: ' + $DesktopProcess + ' is still running')
  exit 12
}

$trees = @('build-context', 'mcp-os', 'oauth', 'THIRD-PARTY-LICENSES', 'host_exec')
$failed = 0
foreach ($tree in $trees) {
  $path = [System.IO.Path]::Combine($instDir, $tree)
  if (-not [System.IO.Directory]::Exists($path)) { continue }
  try {
    [System.IO.Directory]::Delete($path, $true)
    Write-Output ('removed ' + $path)
  } catch {
    Write-Output ('could not remove ' + $path + ': ' + $_.Exception.Message)
    $failed++
  }
}
if ($failed -gt 0) { exit 3 }
exit 0
