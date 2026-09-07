# setup-dev-windows.ps1 -- installs the Windows dev toolchain via Chocolatey (admin;
# self-elevates) and writes the MSVC/Git Bash config `make dev` needs. Idempotent.

$ErrorActionPreference = 'Stop'

# --- Self-elevate: Chocolatey + VS Build Tools install machine-wide (admin). ----
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    Write-Host "Elevating (Chocolatey + VS Build Tools require admin)..."
    # Absolute System32 path, never a bare 'powershell' PATH lookup: this script itself
    # adds user-writable PATH entries (Chocolatey), and a shadowing powershell.exe here
    # would run as Administrator. Mirrors binary::system_powershell_path.
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $elevated = Start-Process -FilePath $psExe -Verb RunAs -Wait -PassThru -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
    )
    # Propagate the elevated child's result -- a failed install must not report success.
    exit $elevated.ExitCode
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Write-Host "Speedwave Windows dev setup (repo: $repoRoot)"

# --- Chocolatey ----------------------------------------------------------------
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
    Write-Host "== Installing Chocolatey =="
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [System.Net.ServicePointManager]::SecurityProtocol = 3072
    Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: Chocolatey install failed (choco not on PATH afterwards)."
        exit 1
    }
}

# --- Tool locations (static paths; version discovery runs after the installs) --
$vsBase = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools"
$msvcRoot = Join-Path $vsBase 'VC\Tools\MSVC'
$sdkBinRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
$llvmBin = "$env:ProgramFiles\LLVM\bin"

# --- Toolchain install (one guarded package at a time) -------------------------
# A package that is unavailable, or already satisfied by a non-choco install, must never
# strand the phases below -- MSVC env, Vulkan SDK, long paths and target-dir run regardless.

function Test-GnuMake4 {
    $make = Get-Command make -ErrorAction SilentlyContinue
    if (-not $make) { return $false }
    $ver = (& $make.Source --version 2>$null) -join ' '
    if ($ver -match 'GNU Make (\d+)') { return ([int]$Matches[1] -ge 4) }
    return $false
}

# `.node-version` is the pin SSOT (scripts/check-node-version.sh gates the same floor):
# an older node on PATH satisfies a bare presence check and strands `make setup-dev`.
function Test-PinnedNode {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $false }
    $pinFile = Join-Path $repoRoot '.node-version'
    if (-not (Test-Path $pinFile)) { return $true }
    $required = (Get-Content $pinFile -TotalCount 1).Trim()
    if ($required -notmatch '^\d+\.\d+\.\d+$') { return $true }
    if ((& $node.Source --version 2>$null) -notmatch '(\d+\.\d+\.\d+)') { return $false }
    return ([version]$Matches[1] -ge [version]$required)
}

# Have = capability probe re-run after the install; Hint = shown only if it still fails.
# `make` must be GNU Make 4.x (3.81 mis-expands $(VAR)); ninja is cmake-rs's generator.
$packages = @(
    @{ Name = 'git'; Have = { [bool](Get-Command git -ErrorAction SilentlyContinue) } },
    # The pre-commit hook hard-requires it; without it no commit can be made at all.
    @{ Name = 'gitleaks'; Have = { [bool](Get-Command gitleaks -ErrorAction SilentlyContinue) } },
    @{ Name = 'make'; Have = { Test-GnuMake4 };
       Hint = 'GNU Make 4.x must win on PATH -- a GnuWin32 3.81 earlier in PATH shadows it.' },
    @{ Name = 'rustup.install'; Have = { Test-Path (Join-Path $env:USERPROFILE '.cargo\bin\rustup.exe') } },
    # `upgrade`, not `install`: choco install is a no-op on an already-present older node,
    # which would leave the pin unsatisfied and be reported as a failure instead of fixed.
    @{ Name = 'nodejs-lts'; Have = { Test-PinnedNode }; Upgrade = $true;
       Hint = 'node must satisfy the .node-version floor -- check for a second node earlier on PATH.' },
    @{ Name = 'cmake'; Have = { [bool](Get-Command cmake -ErrorAction SilentlyContinue) } },
    # Probed by path, not by `clang` on PATH: msvc-env.sh derives LIBCLANG_PATH from this dir.
    @{ Name = 'llvm'; Have = { Test-Path (Join-Path $llvmBin 'clang.exe') } },
    @{ Name = 'ninja'; Have = { [bool](Get-Command ninja -ErrorAction SilentlyContinue) } },
    @{ Name = 'visualstudio2022buildtools'; Have = { Test-Path $vsBase } },
    @{ Name = 'visualstudio2022-workload-vctools'; Have = { Test-Path (Join-Path $vsBase 'VC\Tools\MSVC') } }
)

function Update-ProcessPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
}

$failedItems = @()
$rebootPending = $false
Write-Host "== choco install toolchain (this is large: VS Build Tools) =="
foreach ($pkg in $packages) {
    if (& $pkg.Have) {
        Write-Host "  present: $($pkg.Name)"
        continue
    }
    # `upgrade` for a repo-pinned tool, `install` otherwise (see Upgrade above).
    $verb = if ($pkg.Upgrade) { 'upgrade' } else { 'install' }
    Write-Host "  ${verb}: $($pkg.Name)"
    choco $verb -y --no-progress $pkg.Name
    $chocoExit = $LASTEXITCODE
    # Verify by capability, never by choco's exit code: choco fails on an already-present
    # non-choco tool and succeeds for a package that put nothing usable on PATH.
    Update-ProcessPath
    if (& $pkg.Have) { continue }
    if ($chocoExit -eq 3010) { $rebootPending = $true; continue }
    $failedItems += $pkg
    Write-Warning "$($pkg.Name) still missing after choco $verb (exit $chocoExit) -- continuing."
}

Update-ProcessPath

# --- Rust toolchain (from rust-toolchain.toml) + cargo-tauri -------------------
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$rustup = Join-Path $cargoBin 'rustup.exe'
$cargo = Join-Path $cargoBin 'cargo.exe'
if (Test-Path $rustup) {
    Write-Host "== Materializing pinned Rust toolchain =="
    Push-Location $repoRoot
    & $rustup show | Out-Null
    $rustupExit = $LASTEXITCODE
    Pop-Location
    if ($rustupExit -ne 0) {
        Write-Host "ERROR: rustup show failed with exit code $rustupExit"
        exit $rustupExit
    }
    if ((Test-Path $cargo) -and -not (Test-Path (Join-Path $cargoBin 'cargo-tauri.exe'))) {
        Write-Host "== cargo install tauri-cli =="
        & $cargo install tauri-cli --locked
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: cargo install tauri-cli failed with exit code $LASTEXITCODE"
            exit $LASTEXITCODE
        }
    }
} else {
    Write-Warning "rustup not found at $rustup -- skipped toolchain + tauri-cli (re-run after reboot/PATH refresh)."
}

# --- MSVC + Windows SDK versions (newest installed; paths are pinned above) ----
$msvcVer = if (Test-Path $msvcRoot) {
    (Get-ChildItem $msvcRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name
}
$sdkVer = if (Test-Path $sdkBinRoot) {
    (Get-ChildItem $sdkBinRoot -Directory -Filter '10.*' | Sort-Object Name -Descending | Select-Object -First 1).Name
}

function ConvertTo-BashPath([string]$p) {
    if ($p -match '^([A-Za-z]):\\(.*)$') { return '/' + $Matches[1].ToLower() + '/' + ($Matches[2] -replace '\\', '/') }
    return $p
}

# --- ~/msvc-env.sh sourced from ~/.bashrc: INCLUDE/LIB + cl.exe/link.exe on PATH -
# cargo build scripts (cc: whisper-rs-sys, ring) need cl.exe + the MSVC/SDK
# INCLUDE/LIB; bindgen needs libclang (LIBCLANG_PATH).
$vcvars = Join-Path $vsBase 'VC\Auxiliary\Build\vcvars64.bat'
if ((Test-Path $vcvars) -and $msvcVer) {
    Write-Host "== Generating ~/msvc-env.sh for Git Bash =="
    $envLines = cmd /c "`"$vcvars`" >nul 2>&1 && set"
    $get = { param($k) ($envLines | Where-Object { $_ -like "$k=*" } | Select-Object -First 1) -replace "^$k=", '' }
    $include = & $get 'INCLUDE'
    $lib = & $get 'LIB'
    $libpath = & $get 'LIBPATH'

    # A failed vcvars leaves INCLUDE/LIB empty; writing `export INCLUDE=''` would report
    # success and leave later cargo builds failing cryptically. Skip (warn-and-continue,
    # like the missing-vcvars branch) rather than persisting a broken env file.
    if ([string]::IsNullOrWhiteSpace($include) -or [string]::IsNullOrWhiteSpace($lib)) {
        Write-Warning "vcvars64.bat produced no INCLUDE/LIB (exit $LASTEXITCODE) -- skipped ~/msvc-env.sh; re-run after VS Build Tools finishes."
    } else {
        $pathAdds = @("$msvcRoot\$msvcVer\bin\HostX64\x64")
        if ($sdkVer) { $pathAdds += "$sdkBinRoot\$sdkVer\x64" }
        if (Test-Path $llvmBin) { $pathAdds += $llvmBin }
        $bashPath = ($pathAdds | ForEach-Object { ConvertTo-BashPath $_ }) -join ':'

        $sh = @()
        $sh += "# Generated by scripts/setup-dev-windows.ps1 -- MSVC env for cargo/cc + bindgen."
        $sh += "export INCLUDE='$include'"
        $sh += "export LIB='$lib'"
        $sh += "export LIBPATH='$libpath'"
        if (Test-Path $llvmBin) { $sh += "export LIBCLANG_PATH='$llvmBin'" }
        $sh += "export PATH=`"$bashPath`:`$PATH`""
        # cmake-rs defaults to the VS generator, which a Build Tools-only box has no
        # registered VS instance for and whose ExternalProject TryCompile dies on MSB6003.
        $sh += "export CMAKE_GENERATOR='Ninja'"
        $home_ = $env:USERPROFILE
        $envShWin = Join-Path $home_ 'msvc-env.sh'
        # -NoNewline + explicit LF: Set-Content would append CRLF, and a trailing CR
        # lands inside the exported PATH value when bash sources the file.
        Set-Content -Path $envShWin -Value (($sh -join "`n") + "`n") -Encoding ascii -NoNewline
        Write-Host "Wrote $envShWin"

        # Ensure ~/.bashrc sources it (idempotent).
        $bashrc = Join-Path $home_ '.bashrc'
        $sourceLine = '[ -f ~/msvc-env.sh ] && . ~/msvc-env.sh'
        $existing = if (Test-Path $bashrc) { Get-Content $bashrc -Raw } else { '' }
        if ($existing -notmatch 'msvc-env\.sh') {
            # -NoNewline: Add-Content's CRLF terminator would leave a CR-only line that
            # errors ("$'\r': command not found") on every Git Bash startup.
            Add-Content -Path $bashrc -Value "`n$sourceLine`n" -Encoding ascii -NoNewline
            Write-Host "Appended msvc-env.sh source to ~/.bashrc"
        }
    }
} else {
    Write-Warning "vcvars64.bat/MSVC not found -- skipped ~/msvc-env.sh (re-run after VS Build Tools finishes/reboot)."
}


Write-Host "== Vulkan SDK (Windows whisper Vulkan backend, ADR-085) =="
# try/catch, not $LASTEXITCODE: `&` on a .ps1 never sets $LASTEXITCODE, so the guard would read
# a stale native exit code (choco's 3010) and abort a successful install; failures throw.
try {
    & (Join-Path $repoRoot 'scripts\install-vulkan-sdk.ps1')
} catch {
    # Recorded, not fatal here: the long-paths and target-dir phases below must still run.
    $failedItems += @{ Name = 'Vulkan SDK'; Hint = "install-vulkan-sdk.ps1 failed: $_" }
    Write-Warning "Vulkan SDK install failed -- continuing; reported at the end."
}

# The ggml-vulkan shader ExternalProject nests deep enough to cross MAX_PATH on typical repo
# paths. Long paths let ninja traverse them, but cl.exe still cannot open >260-char paths —
# scripts/check-vulkan-path-budget.sh remains the real gate (cross-platform.md).
Write-Host "== Enabling Windows long paths (ninja needs them for the whisper.cpp Vulkan build) =="
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
    -Name 'LongPathsEnabled' -Value 1 -Type DWord
# No 2>&1 capture: under EAP=Stop PS 5.1 turns merged native stderr into a terminating
# NativeCommandError. A warning matches the choco-3010 handling above — setup must not die here.
git config --system core.longpaths true
if ($LASTEXITCODE -ne 0) {
    Write-Warning "git config --system core.longpaths failed (exit $LASTEXITCODE) — set it manually if the whisper build hits long git paths."
}

# --- desktop/src-tauri/.cargo/config.toml: short cargo target-dir (gitignored) -
# Mandatory on every Windows box, not a deep-clone escape hatch: the budget leaves 9 chars
# for the whole target dir, so `<repo>\desktop\src-tauri\target` can never fit (ADR-085).
Write-Host "== Pinning a short cargo target-dir for the desktop build (ADR-085) =="
$tauriCargoDir = Join-Path $repoRoot 'desktop\src-tauri\.cargo'
$tauriCargoConfig = Join-Path $tauriCargoDir 'config.toml'
if (Test-Path $tauriCargoConfig) {
    Write-Host "Kept existing desktop/src-tauri/.cargo/config.toml (per-machine choice)"
} else {
    # Forward slashes: valid TOML, and cargo accepts them on Windows -- nothing to escape.
    $shortTargetDir = $env:SystemDrive + '/spwd'
    New-Item -ItemType Directory -Force $tauriCargoDir | Out-Null
    $toml = "# Generated by scripts/setup-dev-windows.ps1 -- per-machine, gitignored.`n" +
            "# Short target-dir: scripts/check-vulkan-path-budget.sh gates this (ADR-085).`n" +
            "[build]`n" +
            "target-dir = `"$shortTargetDir`"`n"
    Set-Content -Path $tauriCargoConfig -Value $toml -Encoding ascii -NoNewline
    Write-Host "Wrote desktop/src-tauri/.cargo/config.toml (target-dir $shortTargetDir)"
}

# Everything above runs even when a package failed, so the report comes last -- and a
# missing tool still exits non-zero: `make dev` would only fail later and less clearly.
if ($failedItems.Count -gt 0) {
    Write-Host ""
    Write-Host "== Incomplete: $($failedItems.Count) item(s) missing =="
    foreach ($item in $failedItems) {
        Write-Host "  $($item.Name)"
        if ($item.Hint) { Write-Host "    $($item.Hint)" }
    }
    if ($rebootPending) { Write-Warning "A reboot is also pending -- reboot, then re-run." }
    Write-Host "Every other setup step completed. Install the above, then re-run this script."
    exit 1
}
if ($rebootPending) {
    Write-Warning "REBOOT required (choco 3010) before 'make dev'."
}

Write-Host ""
Write-Host "== Done. Next steps =="
Write-Host "  1. Open a NEW Git Bash window (to pick up PATH + ~/.bashrc)."
Write-Host "  2. cd into the repo and run:  make setup-dev   (install project deps)"
Write-Host "  3. then:  make dev"
Write-Host "  (First whisper.cpp build is slow; subsequent builds are incremental.)"
