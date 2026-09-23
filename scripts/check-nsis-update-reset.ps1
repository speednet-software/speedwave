param(
    [Parameter(Mandatory = $true)]
    [string]$BundleDir
)

$ErrorActionPreference = 'Stop'

$installers = @(Get-ChildItem -LiteralPath $BundleDir -File | Where-Object Name -Like '*-setup.exe')
if ($installers.Count -ne 1) {
    throw "expected exactly one NSIS installer in $BundleDir, found $($installers.Count)"
}
$installer = $installers[0].FullName
$hubSrc = Join-Path $env:LOCALAPPDATA 'Speedwave\build-context\mcp-servers\hub\src'
$shipped = Join-Path $hubSrc 'index.ts'
$dropped = Join-Path $hubSrc 'dropped-by-this-release.ts'

function Invoke-Installer {
    param([string[]]$Switches)
    $run = Start-Process -FilePath $installer -ArgumentList $Switches -Wait -PassThru
    if ($run.ExitCode -ne 0) {
        throw "$installer $($Switches -join ' ') exited $($run.ExitCode)"
    }
}

Invoke-Installer -Switches '/S'
if (-not (Test-Path -LiteralPath $shipped -PathType Leaf)) {
    throw "the first install did not lay down $shipped"
}
Set-Content -LiteralPath $dropped -Value 'export {};'
if (-not (Test-Path -LiteralPath $dropped -PathType Leaf)) {
    throw "could not plant $dropped"
}

Invoke-Installer -Switches '/S', '/UPDATE'
if (Test-Path -LiteralPath $dropped) {
    throw "the /UPDATE install kept $dropped, a file this release does not ship"
}
if (-not (Test-Path -LiteralPath $shipped -PathType Leaf)) {
    throw "the /UPDATE install did not lay down $shipped"
}
Write-Output "the /UPDATE install removed a file this release does not ship and laid down $shipped"
