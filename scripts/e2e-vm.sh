#!/usr/bin/env bash
# e2e-vm.sh — Orchestrates E2E testing across remote machines via SSH (Windows:
# SPEEDWAVE_WINDOWS_HOST, macOS: SPEEDWAVE_MACOS_HOST). Usage: scripts/e2e-vm.sh [windows|macos|all]

set -euo pipefail

# --- Instance isolation --- SPEEDWAVE_DATA_DIR overrides ~/.speedwave (ADR-031); derive
# instance name — MUST match Rust derive_instance_name_from() in consts.rs.
SPEEDWAVE_DATA_DIR="${SPEEDWAVE_DATA_DIR:-$HOME/.speedwave}"
SPEEDWAVE_VM_NAME="$(basename "$SPEEDWAVE_DATA_DIR" | sed 's/^\.//')"
if ! echo "$SPEEDWAVE_VM_NAME" | grep -qE '^[a-z][a-z0-9-]{0,63}$'; then
    echo "ERROR: SPEEDWAVE_DATA_DIR basename '$SPEEDWAVE_VM_NAME' is invalid (must match ^[a-z][a-z0-9-]{0,63}$)" >&2
    exit 1
fi

# -- Configuration (shared) ----------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=e2e-common.sh
source "${SCRIPT_DIR}/e2e-common.sh"

# SSOT: exclude list for repo transfers to remote E2E machines, referenced by both
# macos_rsync_to and windows_rsync_to. Each remote machine downloads its own platform assets.
E2E_RSYNC_EXCLUDES=(
    node_modules target dist .e2e-artifacts .git build-context
    .angular .build
    'desktop/src-tauri/lima'
    'desktop/src-tauri/nodejs'
    'desktop/src-tauri/wsl'
    'desktop/src-tauri/cli'
    'desktop/src-tauri/mcp-os'
    'desktop/src-tauri/THIRD-PARTY-LICENSES'
    'desktop/src-tauri/calendar-cli'
    'desktop/src-tauri/mail-cli'
    'desktop/src-tauri/notes-cli'
    'desktop/src-tauri/reminders-cli'
)

# Override SSH opts with keepalive for long-running test sessions.
WINDOWS_SSH_OPTS="$SSH_OPTS_BASE -o ServerAliveInterval=30 -o ServerAliveCountMax=10 -p $WINDOWS_SSH_PORT"
MACOS_SSH_OPTS="$SSH_OPTS_BASE -o ServerAliveInterval=30 -o ServerAliveCountMax=10"

# Host repo path — resolved from git root of this script's location.
HOST_REPO_DIR="${SPEEDWAVE_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# No local staging dir: artifacts stay on each remote machine's ~/Desktop/ (survives
# clean_state), avoiding 352 MB+ round-trip transfers over the network.

# -- Auto-provisioning ---------------------------------------------------------
# Check if remote machine has required tools; run setup if not.

ensure_provisioned_windows() {
    # Checks WSL2 distro exists and PowerShell finds node/cargo/cmake/libclang.dll
    # (LIBCLANG_PATH from setup script; whisper-rs-sys/bindgen — ADR-056).
    local ok=1
    # shellcheck disable=SC2086
    ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" "wsl.exe -d $WINDOWS_WSL_DISTRO -- echo ready" >/dev/null 2>&1 || ok=0
    if [ "$ok" -eq 1 ]; then
        echo 'if (-not (Get-Command node -ErrorAction SilentlyContinue)) { exit 1 }; if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { exit 1 }; if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) { exit 1 }; $p = [System.Environment]::GetEnvironmentVariable("LIBCLANG_PATH","Machine"); if (-not $p -or -not (Test-Path "$p\libclang.dll")) { exit 1 }' | windows_ps >/dev/null 2>&1 || ok=0
    fi
    if [ "$ok" -eq 1 ]; then
        echo "[windows] Provisioning: OK (WSL2 + node + cargo + cmake + libclang found)"
        return
    fi
    echo "[windows] Provisioning: missing tools — running setup..."
    "${SCRIPT_DIR}/e2e-vm-setup.sh" windows
}

ensure_provisioned_macos() {
    if macos_ssh "command -v npm && command -v cargo && command -v cmake" >/dev/null 2>&1; then
        echo "[macos] Provisioning: OK (npm + cargo + cmake found)"
        return
    fi
    echo "[macos] Provisioning: missing tools — running setup..."
    "${SCRIPT_DIR}/e2e-vm-setup.sh" macos
}

# ── Helper functions: SSH (Windows native OpenSSH → cmd.exe/powershell.exe/wsl.exe) ──
# Staging dir NOT /tmp — WSL2 clears tmpfs on restart/idle.
WINDOWS_WSL_STAGING="/home/windows/speedwave-e2e"
# Dedicated dir for the engine bats suites — other steps rm -rf the main staging dir.
WINDOWS_CONTRACT_STAGING="/home/windows/speedwave-contract-suite"

# Escapes a value for a PowerShell single-quoted literal (' doubled = literal ').
ps_squote() {
    printf '%s' "$1" | sed "s/'/''/g"
}

# Runs a PowerShell script on the Windows host: writes it to a .ps1 temp file via sftp,
# executes via -File — `-Command -` (stdin) ignores $ErrorActionPreference and drops exit codes.
windows_ps() {
    local ps_script tmpname tmpfile_win tmpfile_local
    ps_script=$(cat)
    tmpname="e2e-$$.ps1"
    tmpfile_win="C:\\Windows\\Temp\\${tmpname}"
    tmpfile_local=$(mktemp)
    # Inject vars so PS heredocs can reference them without unquoting
    # (SSH does not forward local env vars to the remote shell).
    local ps_prefix
    ps_prefix="\$WINDOWS_WSL_DISTRO = '$(ps_squote "$WINDOWS_WSL_DISTRO")'
\$env:OPENROUTER_API_KEY = '$(ps_squote "${OPENROUTER_API_KEY:-}")'
\$env:OPENROUTER_MODEL = '$(ps_squote "${OPENROUTER_MODEL:-}")'
\$env:LOCAL_LLM_BASE_URL = '$(ps_squote "${LOCAL_LLM_BASE_URL:-}")'
\$env:LOCAL_LLM_API_KEY = '$(ps_squote "${LOCAL_LLM_API_KEY:-}")'
\$env:LOCAL_LLM_MODEL = '$(ps_squote "${LOCAL_LLM_MODEL:-}")'
\$env:SPW_E2E_SPEC_PHASE = '$(ps_squote "${SPW_E2E_SPEC_PHASE:-}")'"
    # UTF-8 BOM required — PowerShell falls back to the system locale (e.g. Windows-1252)
    # reading a BOM-less .ps1, corrupting multi-byte characters.
    printf '\xEF\xBB\xBF%s\n%s\n' "$ps_prefix" "$ps_script" > "$tmpfile_local"
    # Upload the script via scp (scp uses -P for port, not -p)
    scp -q -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
        -P "$WINDOWS_SSH_PORT" "$tmpfile_local" "${WINDOWS_HOST}:C:\\Windows\\Temp\\${tmpname}"
    rm -f "$tmpfile_local"
    # Execute the script via -File (proper error handling + exit code propagation)
    # shellcheck disable=SC2086
    ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"${tmpfile_win}\""
    local exit_code=$?
    # Clean up temp file
    # shellcheck disable=SC2086
    ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" "del \"${tmpfile_win}\"" 2>/dev/null || true
    return $exit_code
}

# Run a bash script inside WSL2 on the Windows machine.
# Reads a heredoc from stdin.
windows_wsl() {
    # shellcheck disable=SC2086
    ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" "wsl.exe -d $WINDOWS_WSL_DISTRO -- bash -"
}

# Copies files to the Windows machine via tar-over-SSH into WSL2 where it's extracted.
# Destination must be WINDOWS_WSL_STAGING (~/speedwave-e2e), NOT /tmp.
windows_rsync_to() {
    local src="$1" dst="$2"
    # --no-mac-metadata and --exclude='._*' prevent macOS resource forks (cause
    # "not valid UTF-8" errors in Tauri builds).
    local -a tar_excludes=()
    for e in "${E2E_RSYNC_EXCLUDES[@]}"; do tar_excludes+=("--exclude=$e"); done
    # Windows-specific extras (macOS resource forks)
    tar_excludes+=('--exclude=._*')
    local -a tar_flags=(--no-mac-metadata)
    # wsl.exe may need time to restart after a --unregister of another distro shut down the VM.
    echo "  Waiting for WSL distro $WINDOWS_WSL_DISTRO..."
    local wsl_ready=0
    for i in $(seq 1 10); do
        # shellcheck disable=SC2086
        if ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" "wsl.exe -d $WINDOWS_WSL_DISTRO -- echo ready" >/dev/null 2>&1; then
            wsl_ready=1
            break
        fi
        echo "  WSL not ready (attempt $i/10), waiting..."
        sleep 3
    done
    if [ "$wsl_ready" -eq 0 ]; then
        echo "  ERROR: WSL distro $WINDOWS_WSL_DISTRO not available after 30s" >&2
        return 1
    fi

    # Prepare the destination via separate SSH calls (avoids cmd.exe quoting issues).
    # shellcheck disable=SC2086
    ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" "wsl.exe -d $WINDOWS_WSL_DISTRO -- rm -rf ${dst}"
    # /home/<user>/ may not exist if the WSL distro was freshly installed.
    # shellcheck disable=SC2086
    ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" "wsl.exe -d $WINDOWS_WSL_DISTRO -- bash -c 'mkdir -p ${dst}'"
    # Local tar archive, scp'd to Windows, then extracted inside WSL2 — piping tar
    # directly through SSH → cmd.exe → wsl.exe is unreliable after WSL VM restarts.
    local tar_local
    tar_local=$(mktemp "${TMPDIR:-/tmp}/speedwave-e2e-XXXXXX.tar")
    echo "  tar: creating archive from $(dirname "$src")/$(basename "$src")..."
    tar "${tar_flags[@]}" -cf "$tar_local" -C "$(dirname "$src")" "${tar_excludes[@]}" "$(basename "$src")"

    echo "  scp: uploading $(du -h "$tar_local" | cut -f1) archive to Windows..."
    scp -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
        -P "$WINDOWS_SSH_PORT" "$tar_local" "${WINDOWS_HOST}:C:/Windows/Temp/speedwave-e2e.tar"
    rm -f "$tar_local"

    # Extract inside WSL2 — read from the Windows-side temp file via /mnt/c/
    echo "  tar: extracting on WSL2..."
    # shellcheck disable=SC2086
    ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" \
        "wsl.exe -d $WINDOWS_WSL_DISTRO -- tar -xf /mnt/c/Windows/Temp/speedwave-e2e.tar -C ${dst} --strip-components=1"
    local tar_exit=$?
    # Clean up temp archive on Windows
    # shellcheck disable=SC2086
    ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" "del C:\\Windows\\Temp\\speedwave-e2e.tar" 2>/dev/null || true

    if [ "$tar_exit" -ne 0 ]; then
        echo "  tar extract FAILED (exit $tar_exit)" >&2
        return "$tar_exit"
    fi
    echo "  tar: extraction complete"
}

# Copy a file from the Windows machine via scp.
windows_scp_from() {
    local src="$1" dst="$2"
    # Windows OpenSSH scp needs forward slashes (C:/foo), not backslashes
    src="${src//\\//}"
    scp -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
        -P "$WINDOWS_SSH_PORT" "${WINDOWS_HOST}:${src}" "$dst"
}

# Wait for SSH to become available (machine may have just booted).
windows_wait_ssh() {
    echo "[windows] Waiting for SSH on $WINDOWS_HOST (port $WINDOWS_SSH_PORT)..."
    for i in $(seq 1 30); do
        windows_ssh "echo ready" >/dev/null 2>&1 && { echo "[windows] SSH ready"; return 0; }
        sleep 2
    done
    echo "[windows] ERROR: SSH not ready after 60s" >&2
    return 1
}

# Clean previous Speedwave state on the Windows machine.
windows_clean_state() {
    echo "[windows] Cleaning previous state..."
    windows_ps <<'CLEAN'
$ErrorActionPreference = "Continue"

# Kill processes that may hold file locks in the build/install tree
Stop-Process -Name "speedwave-desktop" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "speedwave" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "esbuild" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "cargo" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Stop and remove containers inside WSL2 Speedwave distro before removing user data.
# nerdctl lives inside the WSL2 distro, not on the Windows host.
$distroExists = wsl.exe -l -q 2>$null | Select-String -Quiet "Speedwave"
if ($distroExists) {
    # Compose down each project
    $composeDir = "$env:USERPROFILE\.speedwave\compose"
    if (Test-Path $composeDir) {
        Get-ChildItem $composeDir -Directory | ForEach-Object {
            $composePath = Join-Path $_.FullName "compose.yml"
            if (Test-Path $composePath) {
                $wslPath = wsl.exe -d Speedwave wslpath -u ($composePath -replace '\\','/')
                wsl.exe -d Speedwave -- nerdctl compose -f $wslPath -p $_.Name down 2>$null
            }
        }
    }
    # Remove any leftover speedwave containers
    $containers = wsl.exe -d Speedwave -- nerdctl ps -a --format '{{.Names}}' 2>$null |
        Select-String '^speedwave_'
    $containers | ForEach-Object {
        wsl.exe -d Speedwave -- nerdctl rm -f $_.Line 2>$null
    }
    # Remove leftover CNI networks — stale bridge interfaces cause
    # "already has an IP address different from ..." on next run.
    wsl.exe -d Speedwave -- nerdctl network prune -f 2>$null
}

# Uninstall Speedwave if present (NSIS uninstaller)
if (Test-Path "C:\Speedwave\uninstall.exe") {
    Start-Process -Wait -FilePath "C:\Speedwave\uninstall.exe" -ArgumentList "/S"
}

# Unregister the Speedwave WSL2 distro (removes rootfs, containerd state, images).
# Always attempt — wsl.exe -l -q outputs UTF-16LE (unreliable Select-String match); --unregister is a no-op if absent.
wsl.exe --unregister Speedwave 2>$null
# Unregistering can terminate the lightweight WSL VM; subsequent wsl.exe calls may fail
# with "The system cannot find the path specified" until it restarts.
Start-Sleep -Seconds 5

# Remove stale CNI bridge interfaces left behind by unregistered distro (shared WSL2 kernel) —
# they cause "already has an IP address different from ..." errors on the next run.
$bridges = wsl.exe -d $WINDOWS_WSL_DISTRO -u root -- bash -c "ip -o link show type bridge 2>/dev/null | grep -o 'br-[^:@]*'" 2>$null
if ($bridges) {
    $bridges -split "`n" | ForEach-Object {
        $br = $_.Trim()
        if ($br) { wsl.exe -d $WINDOWS_WSL_DISTRO -u root -- ip link delete $br 2>$null }
    }
}

# Remove install dir, user data, build cache
Remove-Item -Recurse -Force "C:\Speedwave" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:USERPROFILE\.speedwave" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "C:\speedwave-e2e" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "C:\cargo-build" -ErrorAction SilentlyContinue
Remove-Item -Force "C:\speedwave-setup.exe" -ErrorAction SilentlyContinue

# Remove WSL-side staging dir (in the build distro, not Speedwave distro).
wsl.exe -d $WINDOWS_WSL_DISTRO -- rm -rf /home/windows/speedwave-e2e

Write-Host "Clean state ready"
CLEAN
}

# -- Helper functions: SSH (macOS) ---------------------------------------------

# Copy files to the macOS machine via rsync-over-ssh.
macos_rsync_to() {
    local src="$1" dst="$2"
    local -a exclude_args=()
    for e in "${E2E_RSYNC_EXCLUDES[@]}"; do exclude_args+=(--exclude "$e"); done
    # shellcheck disable=SC2086
    rsync -az -e "ssh $MACOS_SSH_OPTS" --delete \
        "${exclude_args[@]}" \
        "$src" "${MACOS_HOST}:${dst}"
}

# Wait for SSH to become available (machine may have just booted).
macos_wait_ssh() {
    echo "[macos] Waiting for SSH on $MACOS_HOST..."
    for i in $(seq 1 30); do
        macos_ssh "echo ready" >/dev/null 2>&1 && { echo "[macos] SSH ready"; return 0; }
        sleep 2
    done
    echo "[macos] ERROR: SSH not ready after 60s" >&2
    return 1
}

# Clean previous Speedwave state on the macOS machine.
macos_clean_state() {
    echo "[macos] Cleaning previous state..."
    macos_ssh bash <<'CLEAN'
set -euo pipefail
SPEEDWAVE_DATA_DIR="${SPEEDWAVE_DATA_DIR:-$HOME/.speedwave}"
SPEEDWAVE_VM_NAME="$(basename "$SPEEDWAVE_DATA_DIR" | sed 's/^\.//')"
# Kill the app first so it doesn't restart containers
pkill -f speedwave-desktop 2>/dev/null || true
pkill -f 'mcp-os.*index.js' 2>/dev/null || true
sleep 1
# Stop and remove containers inside Lima VM BEFORE removing $SPEEDWAVE_DATA_DIR
LIMACTL="$SPEEDWAVE_DATA_DIR/lima/bin/limactl"
if [ -x "$LIMACTL" ] && LIMA_HOME="$SPEEDWAVE_DATA_DIR/lima" "$LIMACTL" list -q 2>/dev/null | grep -q $SPEEDWAVE_VM_NAME; then
    for compose_file in $SPEEDWAVE_DATA_DIR/compose/*/compose.yml; do
        [ -f "$compose_file" ] || continue
        project=$(basename "$(dirname "$compose_file")")
        LIMA_HOME="$SPEEDWAVE_DATA_DIR/lima" "$LIMACTL" shell $SPEEDWAVE_VM_NAME \
            sudo nerdctl compose -f "$compose_file" -p "$project" down 2>/dev/null || true
    done
fi
# Kill Lima VM (hostagent ignores SIGTERM)
pkill -9 -f limactl 2>/dev/null || true
rm -f $SPEEDWAVE_DATA_DIR/lima/*/ssh.sock 2>/dev/null || true
# Unmount all Speedwave DMG volumes (Finder appends " 1", " 2" for duplicates)
for vol in /Volumes/Speedwave*; do
    [ -d "$vol" ] || continue
    hdiutil detach "$vol" -force 2>/dev/null || true
done
rm -rf /Applications/Speedwave.app 2>/dev/null || true
# Remove Speedwave user data (config, Lima VM, setup markers, cached downloads)
rm -rf "$SPEEDWAVE_DATA_DIR" 2>/dev/null || true
rm -rf ~/Library/Caches/lima 2>/dev/null || true
# Remove previous build/test dirs and artifacts
rm -rf /tmp/speedwave-e2e /tmp/speedwave.dmg /tmp/speedwave.log 2>/dev/null || true
echo "Clean state ready"
CLEAN
}

run_windows() {
    windows_wait_ssh
    ensure_provisioned_windows

    # ── Phase 1: Build NSIS installer ──
    # Builds via PowerShell (native Rust/Node/MSVC); repo transfers tar-over-SSH into WSL2, then C:\
    echo "[windows] Phase 1: Building NSIS installer..."
    echo "[windows] Syncing repo to remote..."
    windows_rsync_to "$HOST_REPO_DIR/" "$WINDOWS_WSL_STAGING/"

    # Copy WSL2 -> Windows filesystem, then build. Each phase is a separate windows_ps
    # call to avoid SSH timeouts — long builds (cargo ~15 min) can exceed NAT idle timeouts.

    # -- Step 1: Copy repo and install npm dependencies --
    echo "[windows] Step 1/5: Copy repo + npm install..."
    windows_ps <<'SCRIPT'
$ErrorActionPreference = "Stop"
function Assert-ExitCode { if ($LASTEXITCODE -ne 0) { Write-Error "Command failed with exit code $LASTEXITCODE"; exit $LASTEXITCODE } }
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

Write-Host "── Copying repo from WSL2 to Windows side..."
Stop-Process -Name "esbuild" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

for ($attempt = 1; $attempt -le 3; $attempt++) {
    Remove-Item -Recurse -Force "C:\speedwave-e2e" -ErrorAction SilentlyContinue
    wsl.exe -d $WINDOWS_WSL_DISTRO -- rm -rf /mnt/c/speedwave-e2e
    if (-not (Test-Path "C:\speedwave-e2e")) { break }
    Write-Host "  Retry $attempt -- some files still locked, waiting..."
    Start-Sleep -Seconds 3
}
if (Test-Path "C:\speedwave-e2e") {
    Write-Error "Failed to remove C:\speedwave-e2e after 3 attempts"
    exit 1
}

wsl.exe -d $WINDOWS_WSL_DISTRO -- cp -rT /home/windows/speedwave-e2e /mnt/c/speedwave-e2e
Assert-ExitCode

Set-Location C:\speedwave-e2e
Write-Host "── Installing npm dependencies..."
npm ci; Assert-ExitCode
Set-Location mcp-servers; npm ci; Assert-ExitCode; Set-Location ..
Set-Location desktop\src; npm ci; Assert-ExitCode; Set-Location ..\..
Set-Location desktop\e2e; npm ci; Assert-ExitCode; Set-Location ..\..
Write-Host "Step 1 DONE"
SCRIPT

    # -- Step 2: Build MCP + stage resources --
    echo "[windows] Step 2/5: Build MCP + stage resources..."
    windows_ps <<'SCRIPT'
$ErrorActionPreference = "Stop"
function Assert-ExitCode { if ($LASTEXITCODE -ne 0) { Write-Error "Command failed with exit code $LASTEXITCODE"; exit $LASTEXITCODE } }
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Set-Location C:\speedwave-e2e

Write-Host "── Building MCP servers..."
Set-Location mcp-servers; npm run build; Assert-ExitCode; Set-Location ..

Write-Host "── Staging node.exe for Tauri bundle..."
New-Item -ItemType Directory -Path desktop\src-tauri\nodejs -Force | Out-Null
$nodePath = (Get-Command node).Source
Copy-Item $nodePath desktop\src-tauri\nodejs\node.exe

Write-Host "── Downloading WSL resources..."
New-Item -ItemType Directory -Path desktop\src-tauri\wsl -Force | Out-Null
curl.exe -fsSL -o desktop\src-tauri\wsl\nerdctl-full.tar.gz "https://github.com/containerd/nerdctl/releases/download/v2.2.2/nerdctl-full-2.2.2-linux-amd64.tar.gz"
Assert-ExitCode
curl.exe -fsSL -o desktop\src-tauri\wsl\ubuntu-rootfs.tar.gz "https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-amd64-24.04lts.rootfs.tar.gz"
Assert-ExitCode

Write-Host "── Bundling build context..."
powershell -ExecutionPolicy Bypass -File scripts\bundle-build-context.ps1
Assert-ExitCode
Write-Host "Step 2 DONE"
SCRIPT

    # -- Step 3: Build CLI (cargo) --
    echo "[windows] Step 3/5: Build CLI..."
    windows_ps <<'SCRIPT'
$ErrorActionPreference = "Stop"
function Assert-ExitCode { if ($LASTEXITCODE -ne 0) { Write-Error "Command failed with exit code $LASTEXITCODE"; exit $LASTEXITCODE } }
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
$env:INCLUDE = [System.Environment]::GetEnvironmentVariable("INCLUDE","Machine")
$env:LIB = [System.Environment]::GetEnvironmentVariable("LIB","Machine")
$env:CARGO_TARGET_DIR = 'C:\cargo-build'
New-Item -ItemType Directory -Path $env:CARGO_TARGET_DIR -Force | Out-Null
Set-Location C:\speedwave-e2e

Write-Host "── Building CLI binary..."
New-Item -ItemType Directory -Path desktop\src-tauri\cli -Force | Out-Null
cargo build -p speedwave-cli --release
Assert-ExitCode
Copy-Item $env:CARGO_TARGET_DIR\release\speedwave.exe desktop\src-tauri\cli\speedwave.exe
Write-Host "Step 3 DONE"
SCRIPT

    # -- Step 4: Build Tauri + NSIS (longest step ~15 min) --
    echo "[windows] Step 4/5: Build Tauri + NSIS bundle..."
    windows_ps <<'SCRIPT'
$ErrorActionPreference = "Stop"
function Assert-ExitCode { if ($LASTEXITCODE -ne 0) { Write-Error "Command failed with exit code $LASTEXITCODE"; exit $LASTEXITCODE } }
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
$env:INCLUDE = [System.Environment]::GetEnvironmentVariable("INCLUDE","Machine")
$env:LIB = [System.Environment]::GetEnvironmentVariable("LIB","Machine")
$env:CARGO_TARGET_DIR = 'C:\cargo-build'
New-Item -ItemType Directory -Path $env:CARGO_TARGET_DIR -Force | Out-Null
Set-Location C:\speedwave-e2e

Write-Host "── Building Tauri release with NSIS bundle (e2e feature = WebDriver on :4445)..."
Set-Location desktop\src-tauri
cargo tauri build --features e2e --no-sign
Assert-ExitCode
Set-Location ..\..
Write-Host "Step 4 DONE"
SCRIPT

    # -- Step 5: Locate and stage installer --
    echo "[windows] Step 5/5: Locating installer..."
    windows_ps <<'SCRIPT'
$ErrorActionPreference = "Stop"
Set-Location C:\speedwave-e2e

$installer = Get-ChildItem "C:\cargo-build\release\bundle\nsis\*.exe" -Recurse | Select-Object -First 1
if (-not $installer) { Write-Error "NSIS installer not found"; exit 1 }
Write-Host "Found: $($installer.FullName)"
Copy-Item $installer.FullName "C:\speedwave-setup.exe"
Copy-Item $installer.FullName "$env:USERPROFILE\Desktop\speedwave-setup.exe"
Write-Host "Step 5 DONE"
SCRIPT

    # ── Phase 2: Install & test on clean system ──
    # Simulates a real user download; ~/Desktop/speedwave-setup.exe survives clean_state.
    windows_clean_state

    echo "[windows] Phase 2: Installing app and running E2E tests (clean system)..."
    echo 'Copy-Item "$env:USERPROFILE\Desktop\speedwave-setup.exe" "C:\speedwave-setup.exe"' | windows_ps

    windows_ps <<'SCRIPT'
$ErrorActionPreference = "Stop"
Write-Host "── Installing Speedwave..."
Start-Process -Wait -FilePath "C:\speedwave-setup.exe" -ArgumentList "/S","/D=C:\Speedwave"
if (Test-Path "C:\Speedwave\speedwave-desktop.exe") {
    Write-Host "Install OK"
} else {
    Write-Error "speedwave-desktop.exe not found after installation"
    exit 1
}
SCRIPT

    # Engine-contract suite: rsynced into the STAGING distro only, bats runs there,
    # and crosses into the tested Speedwave distro via WSL interop — never touched directly.
    windows_rsync_to "$HOST_REPO_DIR/_tests/e2e/" "$WINDOWS_CONTRACT_STAGING/"

    # Copy E2E test suite to WSL2 then to Windows side
    windows_rsync_to "$HOST_REPO_DIR/desktop/e2e/" "$WINDOWS_WSL_STAGING/"
    windows_ps <<'SCRIPT'
$ErrorActionPreference = "Stop"
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Remove-Item -Recurse -Force "C:\speedwave-e2e" -ErrorAction SilentlyContinue
wsl.exe -d $WINDOWS_WSL_DISTRO -- rm -rf /mnt/c/speedwave-e2e
wsl.exe -d $WINDOWS_WSL_DISTRO -- cp -rT /home/windows/speedwave-e2e /mnt/c/speedwave-e2e
Set-Location C:\speedwave-e2e
npm ci
SCRIPT

    local exit_code=0
    echo "[windows] Running E2E (first launch — clean system)..."
    run_windows_e2e || exit_code=$?

    if [ "$exit_code" -ne 0 ]; then
        echo "[windows] FAILED on first launch (exit code: $exit_code)"
        echo "[windows] Installer at: $WINDOWS_HOST:Desktop\\speedwave-setup.exe"
        echo "[windows] Cleaning up..."
        windows_clean_state
        return "$exit_code"
    fi

    # ── Phase 3: Second launch (clean system again) ──
    # Verifies a second fresh install despite leftover state (WSL2 distros, registry).
    echo "[windows] Phase 3: Running E2E again (second install — clean system)..."
    windows_clean_state

    echo "[windows] Reinstalling app..."
    echo 'Copy-Item "$env:USERPROFILE\Desktop\speedwave-setup.exe" "C:\speedwave-setup.exe"' | windows_ps

    windows_ps <<'SCRIPT'
$ErrorActionPreference = "Stop"
Start-Process -Wait -FilePath "C:\speedwave-setup.exe" -ArgumentList "/S","/D=C:\Speedwave"
if (Test-Path "C:\Speedwave\speedwave-desktop.exe") { Write-Host "Install OK" } else { Write-Error "Install failed"; exit 1 }
SCRIPT

    # Re-copy E2E test suite (windows_clean_state removed C:\speedwave-e2e)
    windows_rsync_to "$HOST_REPO_DIR/desktop/e2e/" "$WINDOWS_WSL_STAGING/"
    windows_ps <<'SCRIPT'
$ErrorActionPreference = "Stop"
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Remove-Item -Recurse -Force "C:\speedwave-e2e" -ErrorAction SilentlyContinue
wsl.exe -d $WINDOWS_WSL_DISTRO -- rm -rf /mnt/c/speedwave-e2e
wsl.exe -d $WINDOWS_WSL_DISTRO -- cp -rT /home/windows/speedwave-e2e /mnt/c/speedwave-e2e
Set-Location C:\speedwave-e2e
npm ci
SCRIPT

    # The bats suites need the provisioned engine + live 'e2e-test' project, which only
    # exists between the pre-reset specs and 07-factory-reset.spec.ts — run pre-reset
    # first, then the bats steps, then reset-only (factory reset still runs last).
    run_windows_e2e "pre-reset" || exit_code=$?

    # Engine-contract suite needs the provisioned engine, which exists only after
    # the app has run — the Speedwave WSL distro is created on first app start.
    if [ "$exit_code" -eq 0 ]; then
        echo "[windows] Running engine-contract suite (staging distro -> WSL interop -> Speedwave distro)..."
        # shellcheck disable=SC2086
        ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" "wsl.exe -d $WINDOWS_WSL_DISTRO -- bash -lc \"command -v bats >/dev/null || (sudo apt-get update -o Acquire::Retries=3 && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y bats); ENGINE_EXEC='env WSL_UTF8=1 wsl.exe -d Speedwave -u root --' bats --print-output-on-failure $WINDOWS_CONTRACT_STAGING/engine-contract.bats\"" || exit_code=$?
    fi

    # Update-dirty-state suite: needs the live 'e2e-test' project + running containers
    # the desktop suite just left behind — must run before the reset-only wdio run below.
    if [ "$exit_code" -eq 0 ]; then
        echo "[windows] Resolving installed Windows CLI path via WSL interop..."
        local windows_cli_path
        # shellcheck disable=SC2086
        # head runs HOST-side: cmd.exe ignores single quotes, so a remote-side pipe
        # would be intercepted as cmd's own operator ('head' is not recognized).
        windows_cli_path=$(ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" "wsl.exe -d $WINDOWS_WSL_DISTRO -- bash -lc \"ls /mnt/c/Users/*/.speedwave/bin/speedwave*.exe 2>/dev/null\"" | head -n1 | tr -d '\r')
        if [ -z "$windows_cli_path" ]; then
            echo "[windows] ERROR: installed speedwave CLI not found under /mnt/c/Users/*/.speedwave/bin" >&2
            exit_code=1
        else
            local windows_data_dir="${windows_cli_path%/bin/*}"
            echo "[windows] Running update-dirty-state suite (staging distro -> WSL interop -> Speedwave distro)..."
            # shellcheck disable=SC2086
            ssh $WINDOWS_SSH_OPTS "$WINDOWS_HOST" "wsl.exe -d $WINDOWS_WSL_DISTRO -- bash -lc \"command -v bats >/dev/null || (sudo apt-get update -o Acquire::Retries=3 && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y bats); ENGINE_EXEC='env WSL_UTF8=1 wsl.exe -d Speedwave -u root --' SPW_E2E_PROJECT=e2e-test SPEEDWAVE_DATA_DIR=$windows_data_dir SPEEDWAVE_BIN=$windows_cli_path bats --print-output-on-failure $WINDOWS_CONTRACT_STAGING/update-dirty-state.bats\"" || exit_code=$?
        fi
    fi

    if [ "$exit_code" -eq 0 ]; then
        run_windows_e2e "reset-only" || exit_code=$?
    fi

    if [ "$exit_code" -eq 0 ]; then
        echo "[windows] PASSED (both first and second install)"
    else
        echo "[windows] FAILED on second install (exit code: $exit_code)"
    fi
    echo "[windows] Installer at: $WINDOWS_HOST:Desktop\\speedwave-setup.exe"

    # -- Cleanup: leave the machine clean after tests ----------------------------
    echo "[windows] Cleaning up..."
    windows_clean_state

    return "$exit_code"
}

# Audio-transcription pipeline E2E on Windows-native (ADR-056/ADR-075): ensures `small`
# Whisper model + runs `transcription_pipeline_e2e`. Native cargo (MSVC) — deps skip WSL.
run_windows_audio() {
    windows_wait_ssh
    ensure_provisioned_windows
    echo "[windows-audio] Syncing repo to WSL staging..."
    windows_rsync_to "$HOST_REPO_DIR/" "$WINDOWS_WSL_STAGING/"
    echo "[windows-audio] Copying to native dir, ensuring model, running tests..."
    windows_ps <<'SCRIPT'
$ErrorActionPreference = "Stop"
function Assert-ExitCode { if ($LASTEXITCODE -ne 0) { Write-Error "exit $LASTEXITCODE"; exit $LASTEXITCODE } }
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

$dst = "C:\spw-audio-e2e"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $dst
New-Item -ItemType Directory -Path $dst -Force | Out-Null
Write-Host "── Copying repo WSL2 → $dst ..."
# Via a tar file, never a pipe — PowerShell 5.1 pipelines re-encode binary data.
$tarPath = "C:\spw-audio-e2e.tar"
Remove-Item -Force -ErrorAction SilentlyContinue $tarPath
wsl.exe -d $WINDOWS_WSL_DISTRO -- tar -C /home/windows/speedwave-e2e -cf /mnt/c/spw-audio-e2e.tar .
Assert-ExitCode
tar -C $dst -xf $tarPath
Assert-ExitCode
Remove-Item -Force -ErrorAction SilentlyContinue $tarPath
Set-Location $dst

Write-Host "── wasapi/audio_windows unit tests + audio-transcription clippy ..."
cargo clippy -p speedwave-runtime --features audio-transcription -- -D warnings
Assert-ExitCode
cargo test -p speedwave-runtime --features audio-transcription --lib transcription
Assert-ExitCode

Write-Host "── Full pipeline E2E (downloads the small model if absent) ..."
$env:RUN_STT_E2E = "1"
$env:STT_E2E_MODEL = "small"
cargo test -p speedwave-runtime --features audio-transcription --test transcription_pipeline_e2e -- --nocapture
Assert-ExitCode
Write-Host "── Windows audio E2E OK"
SCRIPT
}

# Runs the Speedwave desktop app and executes wdio tests on Windows via SSH.
# Expects the app to be installed at C:\Speedwave and E2E suite at C:\speedwave-e2e.
# $1 (optional): SPW_E2E_SPEC_PHASE value forwarded to wdio.conf.ts (default: unset = full suite).
run_windows_e2e() {
    local SPW_E2E_SPEC_PHASE="${1:-}"
    windows_ps <<'SCRIPT'
$ErrorActionPreference = "Stop"
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

$appExe = "C:\Speedwave\speedwave-desktop.exe"
if (-not (Test-Path $appExe)) {
    Write-Error "speedwave-desktop.exe not found at $appExe"
    exit 1
}

# E2E tests create a project with this directory — it must exist.
# Clean first to remove stale .speedwave.json from previous runs.
$e2eProjectDir = "$env:TEMP\speedwave-e2e-project"
$e2eSecondProjectDir = "$env:TEMP\speedwave-e2e-project-2"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $e2eProjectDir
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $e2eSecondProjectDir
New-Item -ItemType Directory -Path $e2eProjectDir -Force | Out-Null
New-Item -ItemType Directory -Path $e2eSecondProjectDir -Force | Out-Null
$env:E2E_PROJECT_DIR = $e2eProjectDir
$env:E2E_SECOND_PROJECT_DIR = $e2eSecondProjectDir

Write-Host "── Launching $appExe in interactive session..."
# SSH runs in session 0 (services) which has no desktop.
# Use schtasks /IT to launch the app in the console session where the GUI lives.
$taskName = "SpeedwaveE2E"
schtasks /Create /TN $taskName /TR $appExe /SC ONCE /ST 00:00 /IT /F /RL HIGHEST | Out-Null
schtasks /Run /TN $taskName | Out-Null
schtasks /Delete /TN $taskName /F | Out-Null
# Wait for the process to appear (retry loop for slow VMs)
$app = $null
for ($attempt = 1; $attempt -le 3; $attempt++) {
    Start-Sleep -Seconds 2
    $app = Get-Process -Name "speedwave-desktop" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($app) { break }
    Write-Host "Waiting for speedwave-desktop to start (attempt $attempt/3)..."
}
if (-not $app) { Write-Error "speedwave-desktop not found after interactive launch"; exit 1 }

# Default to failure — if npx wdio throws a terminating exception, $e2eExit
# would remain unset and `exit $e2eExit` would exit 0 (false pass).
$e2eExit = 1

try {
    # Wait for WebDriver on port 4445
    for ($i = 1; $i -le 30; $i++) {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:4445/status" -UseBasicParsing -ErrorAction Stop | Out-Null
            Write-Host "WebDriver ready after $i seconds"
            break
        } catch {
            if ($i -eq 30) { Write-Host "WARNING: WebDriver not ready after 30s" }
            Start-Sleep -Seconds 1
        }
    }

    Set-Location C:\speedwave-e2e
    npx wdio run wdio.conf.ts
    $e2eExit = $LASTEXITCODE
} finally {
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
    # Kill all leftover Speedwave child processes (WSL2 nerdctl, node mcp workers). Killing ALL
    # node.exe is intentional — dedicated build machine, no other node processes should run.
    Stop-Process -Name "speedwave-desktop" -Force -ErrorAction SilentlyContinue
    Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue
    # Stop WSL2 distro if it was started by the app
    wsl.exe -t Speedwave 2>$null
}

exit $e2eExit
SCRIPT
}

# -- Platform: macOS (SSH) -----------------------------------------------------

run_macos() {
    macos_wait_ssh
    ensure_provisioned_macos

    # -- Phase 1: Build .dmg package --------------------------------------------
    # Copies repo to the macOS machine, produces a release .dmg — same as GitHub Actions CI.
    echo "[macos] Phase 1: Building .dmg package..."
    echo "[macos] Syncing repo to remote..."
    macos_ssh "rm -rf /tmp/speedwave-e2e" || true
    macos_rsync_to "$HOST_REPO_DIR/" /tmp/speedwave-e2e/

    macos_ssh bash <<'SCRIPT'
set -euo pipefail
cd /tmp/speedwave-e2e
export PATH="$HOME/.cargo/bin:$PATH"
eval "$(/opt/homebrew/bin/brew shellenv)"

npm ci
cd mcp-servers && npm ci && cd ..
cd desktop/src && npm ci && cd ../..
cd desktop/e2e && npm ci && cd ../..

echo "── Building full release (.dmg)..."
make test-e2e-desktop-build
SCRIPT

    # Separate SSH call: the long build above can consume stdin (npm/cargo subprocesses),
    # which would swallow subsequent commands in the same heredoc.
    echo "[macos] Locating .dmg artifact on remote..."
    macos_ssh bash <<'SCRIPT'
set -euo pipefail
cd /tmp/speedwave-e2e
echo "── Locating .dmg artifact..."
ls -la desktop/src-tauri/target/release/bundle/dmg/*.dmg
echo "── Copying .dmg to ~/Desktop/ for reuse across phases..."
cp desktop/src-tauri/target/release/bundle/dmg/*.dmg ~/Desktop/speedwave.dmg
SCRIPT

    # ── Phase 2: Install & test on clean system ──
    # Simulates a real user download; ~/Desktop/speedwave.dmg survives clean_state.
    macos_clean_state

    echo "[macos] Phase 2: Installing .dmg and running E2E tests (clean system)..."
    macos_ssh "cp ~/Desktop/speedwave.dmg /tmp/speedwave.dmg"

    macos_ssh bash <<'SCRIPT'
set -euo pipefail
# Mount the .dmg and copy .app to /Applications (same as user drag-and-drop)
hdiutil attach /tmp/speedwave.dmg -nobrowse -noautoopen
cp -R "/Volumes/Speedwave/Speedwave.app" /Applications/
hdiutil detach "/Volumes/Speedwave"
echo "Install OK: $(ls -d /Applications/Speedwave.app)"
SCRIPT

    # Copy E2E test suite — only wdio specs and deps, not the full repo
    # shellcheck disable=SC2086
    rsync -az -e "ssh $MACOS_SSH_OPTS" \
        "$HOST_REPO_DIR/desktop/e2e/" "${MACOS_HOST}:/tmp/speedwave-e2e/"
    macos_ssh bash <<'SCRIPT'
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
eval "$(/opt/homebrew/bin/brew shellenv)"
cd /tmp/speedwave-e2e && npm ci
SCRIPT

    local exit_code=0
    echo "[macos] Running E2E (first launch — clean system)..."
    run_macos_e2e || exit_code=$?

    if [ "$exit_code" -ne 0 ]; then
        echo "[macos] FAILED on first launch (exit code: $exit_code)"
        echo "[macos] .dmg at: $MACOS_HOST:~/Desktop/speedwave.dmg"
        echo "[macos] Cleaning up..."
        macos_clean_state
        return "$exit_code"
    fi

    # ── Phase 3: Second launch (clean system again) ──
    # Verifies a second fresh install despite leftover state (Lima cache, VM remnants).
    echo "[macos] Phase 3: Running E2E again (second install — clean system)..."
    macos_clean_state

    echo "[macos] Reinstalling .dmg..."
    macos_ssh "cp ~/Desktop/speedwave.dmg /tmp/speedwave.dmg"

    macos_ssh bash <<'SCRIPT'
set -euo pipefail
hdiutil attach /tmp/speedwave.dmg -nobrowse -noautoopen
cp -R "/Volumes/Speedwave/Speedwave.app" /Applications/
hdiutil detach "/Volumes/Speedwave"
echo "Install OK"
SCRIPT

    # Re-copy E2E test suite (macos_clean_state removed /tmp/speedwave-e2e).
    # Also ships _tests/e2e/ flat into the same dir — no filename overlap.
    # shellcheck disable=SC2086
    rsync -az -e "ssh $MACOS_SSH_OPTS" \
        "$HOST_REPO_DIR/desktop/e2e/" "${MACOS_HOST}:/tmp/speedwave-e2e/"
    # shellcheck disable=SC2086
    rsync -az -e "ssh $MACOS_SSH_OPTS" \
        "$HOST_REPO_DIR/_tests/e2e/" "${MACOS_HOST}:/tmp/speedwave-e2e/"
    macos_ssh bash <<'SCRIPT'
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
eval "$(/opt/homebrew/bin/brew shellenv)"
cd /tmp/speedwave-e2e && npm ci
SCRIPT

    # The bats suites need the provisioned engine + live 'e2e-test' project, which only
    # exists between the pre-reset specs and 07-factory-reset.spec.ts — run pre-reset
    # first, then the bats step, then reset-only (factory reset still runs last).
    run_macos_e2e "pre-reset" || exit_code=$?

    if [ "$exit_code" -eq 0 ]; then
        echo "[macos] Running update-dirty-state suite (production-style install: LIMA_HOME + speedwave VM)..."
        macos_ssh bash <<'SCRIPT' || exit_code=$?
set -euo pipefail
eval "$(/opt/homebrew/bin/brew shellenv)"
command -v bats >/dev/null 2>&1 || brew install bats-core
# The app stops the Lima VM when it exits after the pre-reset suite; unlike WSL,
# Lima has no on-demand start — bring the VM back before the engine preflight.
env LIMA_HOME="$HOME/.speedwave/lima" /Applications/Speedwave.app/Contents/Resources/lima/bin/limactl start speedwave
SPEEDWAVE_BIN="$HOME/.local/bin/speedwave" \
ENGINE_EXEC="env LIMA_HOME=$HOME/.speedwave/lima /Applications/Speedwave.app/Contents/Resources/lima/bin/limactl shell speedwave -- sudo" \
SPW_E2E_PROJECT=e2e-test bats --print-output-on-failure /tmp/speedwave-e2e/update-dirty-state.bats
SCRIPT
    fi

    if [ "$exit_code" -eq 0 ]; then
        run_macos_e2e "reset-only" || exit_code=$?
    fi

    if [ "$exit_code" -eq 0 ]; then
        echo "[macos] PASSED (both first and second install)"
    else
        echo "[macos] FAILED on second install (exit code: $exit_code)"
    fi
    echo "[macos] .dmg at: $MACOS_HOST:~/Desktop/speedwave.dmg"

    # -- Cleanup: leave the machine clean after tests ----------------------------
    echo "[macos] Cleaning up..."
    macos_clean_state

    return "$exit_code"
}

# Runs the Speedwave desktop app and executes wdio tests on macOS via SSH. Expects the .app
# at /Applications/Speedwave.app and the E2E suite in /tmp/speedwave-e2e.
# $1 (optional): SPW_E2E_SPEC_PHASE value forwarded to wdio.conf.ts (default: unset = full suite).
run_macos_e2e() {
    local spec_phase="${1:-}"
    # SSH does not forward local env vars — export the LLM test config via
    # locally expanded prefix lines ahead of the quoted heredoc body.
    {
        printf 'export OPENROUTER_API_KEY=%q\n' "${OPENROUTER_API_KEY:-}"
        printf 'export OPENROUTER_MODEL=%q\n' "${OPENROUTER_MODEL:-}"
        printf 'export LOCAL_LLM_BASE_URL=%q\n' "${LOCAL_LLM_BASE_URL:-}"
        printf 'export LOCAL_LLM_API_KEY=%q\n' "${LOCAL_LLM_API_KEY:-}"
        printf 'export LOCAL_LLM_MODEL=%q\n' "${LOCAL_LLM_MODEL:-}"
        printf 'export SPW_E2E_SPEC_PHASE=%q\n' "$spec_phase"
        cat <<'SCRIPT'
set -euo pipefail
SPEEDWAVE_DATA_DIR="${SPEEDWAVE_DATA_DIR:-$HOME/.speedwave}"
export PATH="$HOME/.cargo/bin:$PATH"
eval "$(/opt/homebrew/bin/brew shellenv)"

APP_PATH="/Applications/Speedwave.app/Contents/MacOS/speedwave-desktop"
if [ ! -f "$APP_PATH" ]; then
    echo "ERROR: Speedwave binary not found at $APP_PATH" >&2
    exit 1
fi

# Kill any leftover Speedwave processes from previous runs
pkill -f speedwave-desktop 2>/dev/null || true
pkill -f limactl 2>/dev/null || true
pkill -f 'mcp-os.*index.js' 2>/dev/null || true
sleep 1

# E2E tests create a project with this directory — it must exist.
# Clean first to remove stale .speedwave.json from previous runs.
rm -rf /tmp/speedwave-e2e-project /tmp/speedwave-e2e-project-2
mkdir -p /tmp/speedwave-e2e-project /tmp/speedwave-e2e-project-2

# Launch the app in the background. macOS requires a GUI session — SSH must connect to a user
# with an active login session (e.g., auto-login enabled, or connected via Screen Sharing).
"$APP_PATH" &
APP_PID=$!

cleanup() {
    # Kill app and all child processes (Lima hostagent, mcp-os node, SSH mux).
    # Lima hostagent ignores SIGTERM — use SIGKILL after a brief grace period.
    kill $APP_PID 2>/dev/null || true
    pkill -f speedwave-desktop 2>/dev/null || true
    sleep 1
    pkill -9 -f limactl 2>/dev/null || true
    pkill -9 -f 'mcp-os.*index.js' 2>/dev/null || true
    # Clean up Lima SSH mux sockets
    rm -f $SPEEDWAVE_DATA_DIR/lima/*/ssh.sock 2>/dev/null || true
}
trap cleanup EXIT

# Wait for tauri-plugin-webdriver on port 4445
for i in $(seq 1 30); do
    curl -sf http://127.0.0.1:4445/status >/dev/null 2>&1 && break
    sleep 1
done

export E2E_PROJECT_DIR=/tmp/speedwave-e2e-project
export E2E_SECOND_PROJECT_DIR=/tmp/speedwave-e2e-project-2
cd /tmp/speedwave-e2e && node_modules/.bin/wdio run wdio.conf.ts
E2E_EXIT=$?

cleanup
trap - EXIT

exit $E2E_EXIT
SCRIPT
    } | macos_ssh bash
}

# -- Preview mode: install & launch app for manual testing ---------------------

preview_windows() {
    windows_wait_ssh

    # Require a pre-built installer on the remote Desktop
    echo 'if (-not (Test-Path "$env:USERPROFILE\Desktop\speedwave-setup.exe")) { Write-Error "No installer at Desktop\speedwave-setup.exe -- run Phase 1 first: scripts/e2e-vm.sh windows"; exit 1 }' | windows_ps

    windows_clean_state

    echo "[windows] Installing app from Desktop\\speedwave-setup.exe..."
    echo 'Copy-Item "$env:USERPROFILE\Desktop\speedwave-setup.exe" "C:\speedwave-setup.exe"' | windows_ps

    windows_ps <<'SCRIPT'
$ErrorActionPreference = "Stop"
Start-Process -Wait -FilePath "C:\speedwave-setup.exe" -ArgumentList "/S","/D=C:\Speedwave"
if (Test-Path "C:\Speedwave\speedwave-desktop.exe") { Write-Host "Install OK" } else { Write-Error "Install failed"; exit 1 }
Start-Process -FilePath "C:\Speedwave\speedwave-desktop.exe"
Write-Host "Launched"
SCRIPT

    echo ""
    echo "[windows] Speedwave is running on $WINDOWS_HOST."
    echo "[windows] Stop:  ssh $WINDOWS_SSH_OPTS $WINDOWS_HOST 'powershell.exe Stop-Process -Name speedwave-desktop -Force'"
}


preview_macos() {
    macos_wait_ssh

    # Require a pre-built .dmg on the remote Desktop
    macos_ssh "test -f ~/Desktop/speedwave.dmg" || {
        echo "No .dmg at ~/Desktop/speedwave.dmg — run Phase 1 first: scripts/e2e-vm.sh macos"
        return 1
    }

    macos_clean_state

    echo "[macos] Installing .dmg..."
    macos_ssh "cp ~/Desktop/speedwave.dmg /tmp/speedwave.dmg"

    macos_ssh bash <<'SCRIPT'
set -euo pipefail
hdiutil attach /tmp/speedwave.dmg -nobrowse -noautoopen
cp -R "/Volumes/Speedwave/Speedwave.app" /Applications/
hdiutil detach "/Volumes/Speedwave"
open /Applications/Speedwave.app
echo "Launched"
SCRIPT

    echo ""
    echo "[macos] Speedwave is running on $MACOS_HOST."
    echo "[macos] View logs:  ssh $MACOS_SSH_OPTS $MACOS_HOST tail -f ~/Library/Logs/pl.speedwave.desktop/speedwave.log"
    echo "[macos] Stop:       ssh $MACOS_SSH_OPTS $MACOS_HOST pkill Speedwave"
}

# -- Main ----------------------------------------------------------------------

TARGET="${1:-all}"

case "$TARGET" in
    windows|win)    run_windows ;;
    windows-audio|win-audio) run_windows_audio ;;
    macos|mac)      run_macos ;;
    all)
        PIDS=()
        for fn in run_windows run_macos; do
            $fn &
            PIDS+=($!)
        done
        FAILED=0
        for pid in "${PIDS[@]}"; do
            if ! wait "$pid"; then FAILED=$((FAILED + 1)); fi
        done
        echo ""
        if [ "$FAILED" -eq 0 ]; then
            echo "All E2E tests passed on all platforms"
        else
            echo "$FAILED platform(s) failed"
            exit 1
        fi
        ;;
    preview-windows|preview-win)
        preview_windows ;;
    preview-macos|preview-mac)
        preview_macos ;;
    *)
        echo "Usage: $0 [windows|macos|all|preview-windows|preview-macos]" >&2
        exit 1
        ;;
esac
