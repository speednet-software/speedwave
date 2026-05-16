#!/usr/bin/env bash
# e2e-vm-setup.sh — Provisions E2E testing environments.
#
# Windows: provisions a remote machine via SSH to WSL2 (SPEEDWAVE_WINDOWS_HOST).
# macOS:   provisions a remote machine via SSH (SPEEDWAVE_MACOS_HOST).
#
# Prerequisites:
#   - Windows: SSH key-based auth to WSL2 on SPEEDWAVE_WINDOWS_HOST (port 2222),
#     WSL2 with powershell.exe interop working
#   - macOS: SSH key-based auth to SPEEDWAVE_MACOS_HOST, Xcode CLI Tools available
#
# Usage:
#   scripts/e2e-vm-setup.sh              # provision all environments
#   scripts/e2e-vm-setup.sh windows      # provision Windows only (SSH)
#   scripts/e2e-vm-setup.sh macos        # provision macOS only (SSH)

set -euo pipefail

# -- Configuration (shared) ----------------------------------------------------

# shellcheck source=e2e-common.sh
source "$(dirname "$0")/e2e-common.sh"

# -- Helper functions ----------------------------------------------------------

# Run a PowerShell script on the Windows host via SSH.
# Writes the script to a .ps1 temp file via scp, then executes via -File.
# This is necessary because `powershell.exe -Command -` (reading from stdin)
# ignores $ErrorActionPreference and does not propagate non-zero exit codes.
windows_ps() {
    local ps_script tmpname tmpfile_win tmpfile_local
    ps_script=$(cat)
    tmpname="e2e-setup-$$.ps1"
    tmpfile_win="C:\\Windows\\Temp\\${tmpname}"
    tmpfile_local=$(mktemp)
    # UTF-8 BOM — PowerShell on Windows defaults to the system locale
    # (e.g., Windows-1252) when reading .ps1 files without a BOM.
    printf '\xEF\xBB\xBF%s\n' "$ps_script" > "$tmpfile_local"
    # shellcheck disable=SC2086
    scp -q -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
        -P "$WINDOWS_SSH_PORT" "$tmpfile_local" "${WINDOWS_HOST}:C:\\Windows\\Temp\\${tmpname}"
    rm -f "$tmpfile_local"
    # shellcheck disable=SC2086
    ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"${tmpfile_win}\""
    local exit_code=$?
    # shellcheck disable=SC2086
    ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" "del \"${tmpfile_win}\"" 2>/dev/null || true
    return $exit_code
}

# -- Ubuntu (SSH) --------------------------------------------------------------


setup_windows() {
    echo "[windows] Checking SSH connectivity to $WINDOWS_HOST (port $WINDOWS_SSH_PORT)..."
    windows_ssh "echo ready" || { echo "[windows] ERROR: cannot connect via SSH"; return 1; }

    echo "[windows] Checking PowerShell availability..."
    windows_ssh "powershell.exe -Command 'Write-Host ready'" || { echo "[windows] ERROR: powershell.exe not reachable"; return 1; }

    echo "[windows] Installing Node.js 24..."
    windows_ps <<'SCRIPT'
$ErrorActionPreference = 'Stop'
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq 'ARM64') { $msiArch = 'arm64' } else { $msiArch = 'x64' }
$url = "https://nodejs.org/dist/v24.14.0/node-v24.14.0-$msiArch.msi"
Write-Host "Downloading $url..."
Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\node-installer.msi"
Start-Process -Wait msiexec -ArgumentList '/i',"$env:TEMP\node-installer.msi",'/qn','/norestart'
Remove-Item "$env:TEMP\node-installer.msi"
SCRIPT

    echo "[windows] Installing Visual Studio Build Tools (MSVC)..."
    windows_ps <<'SCRIPT'
$ErrorActionPreference = 'Stop'
Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vs_BuildTools.exe' -OutFile "$env:TEMP\vs_buildtools.exe"
$arch = $env:PROCESSOR_ARCHITECTURE
$installArgs = '--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
if ($arch -eq 'ARM64') { $installArgs += ' --add Microsoft.VisualStudio.Component.VC.Tools.ARM64' }
Write-Host "Running: vs_buildtools.exe $installArgs"
Start-Process -Wait -FilePath "$env:TEMP\vs_buildtools.exe" -ArgumentList $installArgs
Remove-Item "$env:TEMP\vs_buildtools.exe"
SCRIPT

    echo "[windows] Installing CMake (Kitware — required by whisper-rs-sys)..."
    windows_ps <<'SCRIPT'
$ErrorActionPreference = 'Stop'
# whisper-rs-sys uses the `cmake` Rust crate to drive a real cmake invocation
# (Visual Studio's bundled cmake is not on PATH and the crate spawns
# `cmake.exe` from PATH, not from VS's private layout). Install the official
# Kitware build so `cmake.exe` lives in `C:\Program Files\CMake\bin` and is
# on the Machine PATH for every process started afterwards.
# Idempotent: skip if cmake.exe already present at the expected path.
$cmakeBin = 'C:\Program Files\CMake\bin'
if (Test-Path "$cmakeBin\cmake.exe") {
    Write-Host "CMake already installed: $cmakeBin"
} else {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq 'ARM64') {
        $url = 'https://github.com/Kitware/CMake/releases/download/v3.31.5/cmake-3.31.5-windows-arm64.msi'
    } else {
        $url = 'https://github.com/Kitware/CMake/releases/download/v3.31.5/cmake-3.31.5-windows-x86_64.msi'
    }
    Write-Host "Downloading $url..."
    Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\cmake-installer.msi"
    # ADD_CMAKE_TO_PATH=System adds cmake.exe to the Machine PATH automatically.
    Start-Process -Wait msiexec -ArgumentList '/i',"$env:TEMP\cmake-installer.msi",'/qn','/norestart','ADD_CMAKE_TO_PATH=System'
    Remove-Item "$env:TEMP\cmake-installer.msi"
    if (-not (Test-Path "$cmakeBin\cmake.exe")) {
        Write-Error "CMake installation completed but cmake.exe not found at $cmakeBin"
        exit 1
    }
}
# Belt-and-braces: ensure Machine PATH contains the cmake bin (the msi flag
# usually does this, but verify so subsequent SSH sessions inherit it).
$currentPath = [System.Environment]::GetEnvironmentVariable('Path','Machine')
if (-not $currentPath.Contains($cmakeBin)) {
    [System.Environment]::SetEnvironmentVariable('Path', "$currentPath;$cmakeBin", 'Machine')
    Write-Host "Added $cmakeBin to Machine PATH"
}
SCRIPT

    echo "[windows] Installing LLVM (libclang for bindgen / whisper-rs-sys)..."
    windows_ps <<'SCRIPT'
$ErrorActionPreference = 'Stop'
# whisper-rs-sys (ADR-056) uses bindgen, which requires libclang.dll.
# Idempotent: skip if libclang.dll already present at the expected path.
$llvmBin = 'C:\Program Files\LLVM\bin'
if (Test-Path "$llvmBin\libclang.dll") {
    Write-Host "LLVM already installed: $llvmBin"
} else {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq 'ARM64') {
        $url = 'https://github.com/llvm/llvm-project/releases/download/llvmorg-18.1.8/LLVM-18.1.8-woa64.exe'
    } else {
        $url = 'https://github.com/llvm/llvm-project/releases/download/llvmorg-18.1.8/LLVM-18.1.8-win64.exe'
    }
    Write-Host "Downloading $url..."
    Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\llvm-installer.exe"
    Start-Process -Wait -FilePath "$env:TEMP\llvm-installer.exe" -ArgumentList '/S'
    Remove-Item "$env:TEMP\llvm-installer.exe"
    if (-not (Test-Path "$llvmBin\libclang.dll")) {
        Write-Error "LLVM installation completed but libclang.dll not found at $llvmBin"
        exit 1
    }
}
# bindgen reads LIBCLANG_PATH at build time to locate libclang.dll.
[System.Environment]::SetEnvironmentVariable('LIBCLANG_PATH', $llvmBin, 'Machine')
Write-Host "LIBCLANG_PATH set to $llvmBin"
SCRIPT

    echo "[windows] Configuring MSVC environment (PATH, INCLUDE, LIB)..."
    windows_ps <<'SCRIPT'
$ErrorActionPreference = 'Stop'
$arch = $env:PROCESSOR_ARCHITECTURE

# Configure MSVC environment permanently (link.exe, INCLUDE, LIB)
$msvcBase = (Get-ChildItem "C:\Program Files*\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC" -Directory | Select-Object -First 1).FullName
if (-not $msvcBase) { Write-Error "MSVC not found — VS Build Tools installation may have failed"; exit 1 }
$msvcDir = (Get-ChildItem $msvcBase -Directory | Where-Object { $_.Name -match '^\d+\.' } | Sort-Object Name -Descending | Select-Object -First 1).FullName
if (-not $msvcDir) { $msvcDir = $msvcBase }
Write-Host "MSVC dir: $msvcDir"

$sdkBase = "C:\Program Files (x86)\Windows Kits\10"
if (-not (Test-Path "$sdkBase\Include")) { Write-Error "Windows SDK not found at $sdkBase"; exit 1 }
$sdkVer = (Get-ChildItem "$sdkBase\Include" -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name
Write-Host "SDK version: $sdkVer"

# Determine host/target architecture for linker and libs
if ($arch -eq 'ARM64') {
    $linkDir = "$msvcDir\bin\Hostarm64\x64"
    $libArch = 'x64'
} else {
    $linkDir = "$msvcDir\bin\Hostx64\x64"
    $libArch = 'x64'
}
Write-Host "Link dir: $linkDir"

$currentPath = [System.Environment]::GetEnvironmentVariable('Path','Machine')
if (-not $currentPath.Contains($linkDir)) {
    [System.Environment]::SetEnvironmentVariable('Path', "$currentPath;$linkDir", 'Machine')
}
[System.Environment]::SetEnvironmentVariable('INCLUDE', "$msvcDir\include;$sdkBase\Include\$sdkVer\ucrt;$sdkBase\Include\$sdkVer\um;$sdkBase\Include\$sdkVer\shared", 'Machine')
[System.Environment]::SetEnvironmentVariable('LIB', "$msvcDir\lib\$libArch;$sdkBase\Lib\$sdkVer\ucrt\$libArch;$sdkBase\Lib\$sdkVer\um\$libArch", 'Machine')
Write-Host "MSVC environment configured"
SCRIPT

    echo "[windows] Installing Rust..."
    windows_ps <<'SCRIPT'
$ErrorActionPreference = 'Stop'
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq 'ARM64') { $url = 'https://win.rustup.rs/aarch64' } else { $url = 'https://win.rustup.rs/x86_64' }
Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\rustup-init.exe"
Start-Process -Wait -FilePath "$env:TEMP\rustup-init.exe" -ArgumentList '-y'
Remove-Item "$env:TEMP\rustup-init.exe"
SCRIPT

    echo "[windows] Installing tauri-cli..."
    windows_ps <<'SCRIPT'
$ErrorActionPreference = 'Stop'
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
$env:INCLUDE = [System.Environment]::GetEnvironmentVariable('INCLUDE','Machine')
$env:LIB = [System.Environment]::GetEnvironmentVariable('LIB','Machine')
# Use a non-temp directory for cargo builds to avoid AppLocker blocking
# executables in %TEMP% (Windows Application Control error 4551).
$env:CARGO_TARGET_DIR = 'C:\cargo-build'
New-Item -ItemType Directory -Path $env:CARGO_TARGET_DIR -Force | Out-Null
cargo install tauri-cli --locked
SCRIPT

    echo "[windows] Installing WSL2 distro $WINDOWS_WSL_DISTRO..."
    local wsl_distro="$WINDOWS_WSL_DISTRO"
    windows_ps <<SCRIPT
\$ErrorActionPreference = 'Stop'
\$distro = '${wsl_distro}'
# wsl.exe -l -q emits UTF-16 LE. PowerShell over SSH receives the raw bytes
# as null-interlaced ASCII (e.g. "U\0b\0u\0n\0t\0u\0"), so a naive -match
# against the plain distro name never hits. Strip nulls before matching.
\$installed = (wsl.exe -l -q 2>\$null) -replace "\`0","" | Where-Object { \$_ -match [regex]::Escape(\$distro) }
if (\$installed) {
    Write-Host "WSL2 distro \$distro already installed"
} else {
    Write-Host "Installing \$distro..."
    # --no-launch skips first-boot user creation. This is fine — the E2E
    # scripts only use this distro for file operations via /mnt/c.
    wsl.exe --install -d \$distro --no-launch
    if (\$LASTEXITCODE -ne 0) { Write-Error "Failed to install WSL2 distro \$distro"; exit 1 }
    Write-Host "WSL2 distro \$distro installed"
}
SCRIPT

    echo "[windows] Verifying installation..."
    windows_ps <<'SCRIPT'
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
Write-Host "Node: $(node --version)"
Write-Host "npm:  $(npm --version)"
Write-Host "Rust: $(rustc --version)"
Write-Host "Cargo: $(cargo --version)"
Write-Host "tauri-cli: $(cargo tauri --version 2>&1)"
Write-Host "cmake: $(cmake --version 2>&1 | Select-Object -First 1)"
Write-Host "LIBCLANG_PATH: $([System.Environment]::GetEnvironmentVariable('LIBCLANG_PATH','Machine'))"
Write-Host "Arch: $env:PROCESSOR_ARCHITECTURE"
SCRIPT

    echo "[windows] DONE"
}

setup_macos() {
    echo "[macos] Checking SSH connectivity to $MACOS_HOST..."
    macos_ssh "echo ready" || { echo "[macos] ERROR: cannot connect via SSH"; return 1; }

    echo "[macos] Installing Xcode CLI Tools..."
    macos_ssh bash <<'SCRIPT'
if xcode-select -p >/dev/null 2>&1; then
    echo "Xcode CLI Tools already installed"
else
    xcode-select --install 2>/dev/null || true
    until xcode-select -p >/dev/null 2>&1; do sleep 5; done
fi
SCRIPT

    echo "[macos] Installing Homebrew and Node.js..."
    macos_ssh bash <<'SCRIPT'
set -euo pipefail
if command -v brew >/dev/null 2>&1; then
    echo "Homebrew already installed: $(brew --version | head -1)"
else
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/opt/homebrew/bin/brew shellenv)"
brew install node@24
brew link node@24 --overwrite --force 2>/dev/null || true
# cmake — required by whisper-rs-sys build script (ADR-056 meeting transcription)
command -v cmake >/dev/null 2>&1 || brew install cmake
SCRIPT

    echo "[macos] Installing Rust and tauri-cli..."
    macos_ssh bash <<'SCRIPT'
if command -v rustc >/dev/null 2>&1; then
    echo "Rust already installed: $(rustc --version)"
else
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi
export PATH="$HOME/.cargo/bin:$PATH"
cargo install tauri-cli --locked
SCRIPT

    echo "[macos] Installing rsync (if missing)..."
    macos_ssh bash <<'SCRIPT'
eval "$(/opt/homebrew/bin/brew shellenv)"
command -v rsync >/dev/null 2>&1 || brew install rsync
SCRIPT

    echo "[macos] Verifying installation..."
    macos_ssh bash <<'SCRIPT'
export PATH="$HOME/.cargo/bin:$PATH"
eval "$(/opt/homebrew/bin/brew shellenv)"
echo "Node: $(node --version)"
echo "npm:  $(npm --version)"
echo "Rust: $(rustc --version)"
echo "Cargo: $(cargo --version)"
echo "tauri-cli: $(cargo tauri --version 2>/dev/null || echo 'not found')"
echo "cmake: $(cmake --version 2>/dev/null | head -1 || echo 'not found')"
echo "Arch: $(uname -m)"
echo "macOS: $(sw_vers -productVersion)"
SCRIPT

    echo "[macos] DONE"
}

# -- Main ----------------------------------------------------------------------

TARGET="${1:-all}"

case "$TARGET" in
    windows|win)    setup_windows ;;
    macos|mac)      setup_macos ;;
    all)
        PIDS=()
        for fn in setup_windows setup_macos; do
            $fn &
            PIDS+=($!)
        done
        FAILED=0
        for pid in "${PIDS[@]}"; do
            if ! wait "$pid"; then FAILED=$((FAILED + 1)); fi
        done
        if [ "$FAILED" -ne 0 ]; then
            echo "$FAILED platform(s) failed to provision" >&2
            exit 1
        fi
        ;;
    *)
        echo "Usage: $0 [windows|macos|all]" >&2
        exit 1
        ;;
esac

echo ""
echo "Provisioning complete."
echo "Run 'make test-e2e-all' or 'scripts/e2e-vm.sh <platform>' to start testing."
