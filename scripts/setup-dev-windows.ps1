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

# Non-obvious picks: `make` must be GNU Make 4.4 (GnuWin32 3.81 breaks $(VAR)); cmake
# + llvm build whisper.cpp/bindgen (audio-transcription).
Write-Host "== choco install toolchain (this is large: VS Build Tools) =="
choco install -y git make rustup.install nodejs-lts cmake llvm `
    visualstudio2022buildtools visualstudio2022-workload-vctools bats-core
# $ErrorActionPreference does not cover native exit codes -- check choco explicitly.
# (Write-Host, not Write-Error: under EAP=Stop the latter throws before `exit <code>`.)
if ($LASTEXITCODE -eq 3010) {
    Write-Warning "choco reports a REBOOT is required (3010). Reboot, then re-run this script."
} elseif ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: choco install failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User')

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

# --- Locate MSVC + Windows SDK -------------------------------------------------
$vsBase = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools"
$msvcRoot = Join-Path $vsBase 'VC\Tools\MSVC'
$msvcVer = if (Test-Path $msvcRoot) {
    (Get-ChildItem $msvcRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name
}
$sdkBinRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
$sdkVer = if (Test-Path $sdkBinRoot) {
    (Get-ChildItem $sdkBinRoot -Directory -Filter '10.*' | Sort-Object Name -Descending | Select-Object -First 1).Name
}

function ConvertTo-BashPath([string]$p) {
    if ($p -match '^([A-Za-z]):\\(.*)$') { return '/' + $Matches[1].ToLower() + '/' + ($Matches[2] -replace '\\', '/') }
    return $p
}

# --- .cargo/config.toml: pin the MSVC linker (gitignored, per-machine) ---------
# Without it, cargo on Git Bash resolves cygwin's /usr/bin/link before MSVC
# link.exe -> LNK1146/LNK1170/LNK1206-class failures.
if ($msvcVer) {
    $linker = "$msvcRoot\$msvcVer\bin\HostX64\x64\link.exe"
    $cargoDir = Join-Path $repoRoot '.cargo'
    New-Item -ItemType Directory -Force $cargoDir | Out-Null
    $cargoConfig = Join-Path $cargoDir 'config.toml'
    # Never clobber a hand-written per-machine config silently -- back it up first.
    if ((Test-Path $cargoConfig) -and
        ((Get-Content $cargoConfig -Raw) -notmatch 'Generated by scripts/setup-dev-windows\.ps1')) {
        Copy-Item $cargoConfig "$cargoConfig.bak" -Force
        Write-Warning "Existing .cargo/config.toml backed up to config.toml.bak before overwrite."
    }
    $linkerToml = $linker -replace '\\', '\\'
    $toml = "# Generated by scripts/setup-dev-windows.ps1 -- per-machine, gitignored.`n" +
            "[target.x86_64-pc-windows-msvc]`n" +
            "linker = `"$linkerToml`"`n"
    Set-Content -Path $cargoConfig -Value $toml -Encoding ascii -NoNewline
    Write-Host "Wrote .cargo/config.toml (MSVC $msvcVer linker)"
} else {
    Write-Warning "MSVC not found under $msvcRoot -- skipped .cargo/config.toml (re-run after VS Build Tools finishes/reboot)."
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
        $llvmBin = "$env:ProgramFiles\LLVM\bin"
        if (Test-Path $llvmBin) { $pathAdds += $llvmBin }
        $bashPath = ($pathAdds | ForEach-Object { ConvertTo-BashPath $_ }) -join ':'

        $sh = @()
        $sh += "# Generated by scripts/setup-dev-windows.ps1 -- MSVC env for cargo/cc + bindgen."
        $sh += "export INCLUDE='$include'"
        $sh += "export LIB='$lib'"
        $sh += "export LIBPATH='$libpath'"
        if (Test-Path $llvmBin) { $sh += "export LIBCLANG_PATH='$llvmBin'" }
        $sh += "export PATH=`"$bashPath`:`$PATH`""
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
    Write-Host "ERROR: Vulkan SDK install failed: $_"
    exit 1
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

Write-Host ""
Write-Host "== Done. Next steps =="
Write-Host "  1. Open a NEW Git Bash window (to pick up PATH + ~/.bashrc)."
Write-Host "  2. cd into the repo and run:  make setup-dev   (install project deps)"
Write-Host "  3. then:  make dev"
Write-Host "  (First whisper.cpp build is slow; subsequent builds are incremental.)"
