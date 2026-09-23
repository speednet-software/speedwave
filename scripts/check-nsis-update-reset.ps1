param(
    [Parameter(Mandatory = $true)]
    [string]$BundleDir
)

$ErrorActionPreference = 'Stop'

$conf = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..\desktop\src-tauri\tauri.conf.json') | ConvertFrom-Json
$installer = Join-Path $BundleDir ($conf.productName + '_' + $conf.version + '_x64-setup.exe')
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "the build did not produce $installer"
}
$installDir = Join-Path $env:LOCALAPPDATA $conf.productName
$hubSrc = Join-Path $installDir 'build-context\mcp-servers\hub\src'
$shipped = Join-Path $hubSrc 'index.ts'
$dropped = Join-Path $hubSrc 'dropped-by-this-release.ts'
$outside = Join-Path ([System.IO.Path]::GetTempPath()) 'speedwave-reset-junction-target'
$sentinel = Join-Path $outside 'sentinel.txt'
$junction = Join-Path $installDir 'build-context\junction-to-outside'
$spacedTemp = Join-Path ([System.IO.Path]::GetTempPath()) 'speedwave update temp'

function Invoke-Installer {
    param([string[]]$Switches)
    $run = Start-Process -FilePath $installer -ArgumentList ($Switches + "/D=$installDir") -Wait -PassThru
    if ($run.ExitCode -ne 0) {
        throw "$installer $($Switches -join ' ') exited $($run.ExitCode)"
    }
}

Invoke-Installer -Switches '/S'
if (-not (Test-Path -LiteralPath $shipped -PathType Leaf)) {
    throw "the first install did not lay down $shipped"
}
foreach ($tree in 'containers', 'mcp-servers') {
    $treeDir = Join-Path $installDir "build-context\$tree"
    $listed = @(Get-Content -LiteralPath (Join-Path $treeDir '.speedwave-shipped-files'))
    $installed = @(Get-ChildItem -LiteralPath $treeDir -Recurse -Force -File |
        ForEach-Object { $_.FullName.Substring($treeDir.Length + 1).Replace('\', '/') } |
        Where-Object { $_ -ne '.speedwave-shipped-files' })
    if ($listed.Count -eq 0 -or (Compare-Object $listed $installed)) {
        throw "the files installed in $treeDir differ from its .speedwave-shipped-files"
    }
}
Set-Content -LiteralPath $dropped -Value 'export {};'
New-Item -ItemType Directory -Path $outside -Force | Out-Null
Set-Content -LiteralPath $sentinel -Value 'outside the install dir'
New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null

New-Item -ItemType Directory -Path $spacedTemp -Force | Out-Null
$savedTemp = $env:TEMP
$savedTmp = $env:TMP
$env:TEMP = $spacedTemp
$env:TMP = $spacedTemp
try {
    Invoke-Installer -Switches '/P', '/UPDATE'
} finally {
    $env:TEMP = $savedTemp
    $env:TMP = $savedTmp
}
if (Test-Path -LiteralPath $dropped) {
    throw "the /P /UPDATE install from a TEMP of '$spacedTemp' kept $dropped, a file this release does not ship"
}
if (-not (Test-Path -LiteralPath $sentinel -PathType Leaf)) {
    throw "the /P /UPDATE install deleted $sentinel through the junction $junction"
}
if (-not (Test-Path -LiteralPath $shipped -PathType Leaf)) {
    throw "the /P /UPDATE install did not lay down $shipped"
}
Write-Output "the /P /UPDATE install from a TEMP of '$spacedTemp' removed a file this release does not ship, left the junction target alone, and laid down $shipped"
