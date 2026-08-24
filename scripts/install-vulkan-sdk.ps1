# Installs the pinned LunarG Vulkan SDK + redistributable loader (ADR-085) — required to build
# the Windows whisper Vulkan backend (headers + vulkan-1.lib + glslc) and to bundle vulkan-1.dll
# next to the exe. Idempotent; needs elevation (HKLM env, VC redist), matching setup-dev-windows.
$ErrorActionPreference = 'Stop'

# Version + artifact SHA256s are pinned like the nerdctl download pins (see alignments rules);
# bumping the SDK = updating all three together.
$Version = '1.4.357.0'
$Sha256 = '81f474711e9042f4cd22b31b2f7a8870db2e428b21586fb43dd80150be97310d'
$RuntimeSha256 = 'a14672efed15aafc7f5a16572d35cd3a3416eadf670aeee3cdf50ee32d5fbf83'
$Root = Join-Path 'C:\VulkanSDK' $Version

function Get-Verified([string]$Path, [string]$Url, [string]$Expected, [string]$What) {
    if (-not (Test-Path $Path) -or (Get-FileHash -Algorithm SHA256 $Path).Hash -ne $Expected) {
        Write-Output "Downloading $What..."
        curl.exe -fsSL -o $Path $Url
        if ($LASTEXITCODE -ne 0) { throw "$What download failed (exit $LASTEXITCODE)" }
    }
    $hash = (Get-FileHash -Algorithm SHA256 $Path).Hash
    if ($hash -ne $Expected) {
        Remove-Item -Force $Path
        throw "$What SHA256 mismatch: got $hash, expected $Expected"
    }
}

if (-not ((Test-Path (Join-Path $Root 'Lib\vulkan-1.lib')) -and (Test-Path (Join-Path $Root 'Bin\glslc.exe')))) {
    $installer = Join-Path $env:TEMP "vulkan_sdk-$Version.exe"
    Get-Verified $installer "https://sdk.lunarg.com/sdk/download/$Version/windows/vulkan_sdk.exe" $Sha256 "Vulkan SDK $Version"
    Write-Output "Installing Vulkan SDK $Version to $Root..."
    & $installer --root $Root --accept-licenses --default-answer --confirm-command install
    if (-not ((Test-Path (Join-Path $Root 'Lib\vulkan-1.lib')) -and (Test-Path (Join-Path $Root 'Bin\glslc.exe')))) {
        throw "Vulkan SDK install did not produce Lib\vulkan-1.lib + Bin\glslc.exe under $Root"
    }
}

# The redistributable loader ships separately (vulkan-runtime-components); Speedwave bundles the
# x64 DLL next to the exe because the ggml Vulkan backend is a load-time import (ADR-085).
$runtimeDll = Join-Path $Root 'runtime\x64\vulkan-1.dll'
if (-not (Test-Path $runtimeDll)) {
    $rtZip = Join-Path $env:TEMP "vulkan-runtime-$Version.zip"
    Get-Verified $rtZip "https://sdk.lunarg.com/sdk/download/$Version/windows/vulkan-runtime-components.zip" $RuntimeSha256 "Vulkan runtime components $Version"
    $rtTmp = Join-Path $env:TEMP "vulkan-runtime-$Version"
    if (Test-Path $rtTmp) { Remove-Item -Recurse -Force $rtTmp }
    Expand-Archive -Path $rtZip -DestinationPath $rtTmp
    $extracted = Get-ChildItem -Path $rtTmp -Recurse -Filter 'vulkan-1.dll' |
        Where-Object { $_.Directory.Name -eq 'x64' } | Select-Object -First 1
    if ($null -eq $extracted) { throw "vulkan-runtime-components.zip carried no x64\vulkan-1.dll" }
    New-Item -ItemType Directory -Force (Split-Path $runtimeDll) | Out-Null
    Copy-Item $extracted.FullName $runtimeDll -Force
    Remove-Item -Recurse -Force $rtTmp
}

# Persist for future shells; the current shell still needs `$env:VULKAN_SDK = ...`. Callers
# parse the final VULKAN_SDK=... line, so it must stay the last output.
[Environment]::SetEnvironmentVariable('VULKAN_SDK', $Root, 'Machine')
Write-Output "VULKAN_SDK=$Root"
