# PowerShell equivalent of bundle-build-context.sh; run from repo root. LOCAL Windows dev builds
# only — CI (windows-latest) runs bundle-build-context.sh via Git Bash instead.

$ErrorActionPreference = 'Stop'

# Default to the in-repo Tauri resource dir. Tests override via $env:BUNDLE_DEST
# so concurrent test + dev runs do not race on the same files (mirrors the .sh).
$dest = if ($env:BUNDLE_DEST) { $env:BUNDLE_DEST } else { 'desktop\src-tauri' }
New-Item -ItemType Directory -Path $dest -Force | Out-Null
# The mcp-servers tree the bundle is staged from (mirrors the .sh); a scratch copy keeps a
# test rebuild off the real tree a concurrent run reads.
$mcpServersDir = if ($env:BUNDLE_MCP_SERVERS_DIR) { $env:BUNDLE_MCP_SERVERS_DIR } else { 'mcp-servers' }
if (-not (Test-Path -Path $mcpServersDir -PathType Container)) {
    [Console]::Error.WriteLine("ERROR: mcp-servers tree not found at $mcpServersDir (BUNDLE_MCP_SERVERS_DIR).")
    exit 1
}

# Serialize concurrent runs on DEST (mirrors the .sh mkdir-mutex): non-atomic body can bake a
# 0-byte package.json into a worker image otherwise; a lock whose holder PID is dead is reclaimed.
$lockDir = "$dest\.bundle.lock"
# mcp-servers/policies/wasm-pkg is a single shared source-tree location (not under $dest) — a
# second lock guards it from concurrent writers across different $env:BUNDLE_DEST invocations.
$wasmPkgDir = 'mcp-servers/policies/wasm-pkg'
$wasmLockDir = 'mcp-servers/policies/.wasm-build.lock'

# Is the PID in a lock dir a live process? Returns $true only when Get-Process proves the holder
# is gone; any other error or a missing/blank PID is treated as ALIVE to never reclaim a live lock.
function Test-LockHolderDead {
    param([string]$dir)
    $holder = (Get-Content "$dir\pid" -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not $holder) { return $false }  # no PID yet — assume alive, wait
    try {
        $null = Get-Process -Id ([int]$holder) -ErrorAction Stop
        return $false                      # holder is running
    } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
        return $true                       # "no process with that Id" — dead
    } catch {
        return $false                      # any other fault — be safe, wait
    }
}

# Acquire-Lock <dir>: mkdir-based mutex (mirrors the .sh acquire_lock); reclaims a lock whose
# holder PID is dead. Returns $true when acquired (caller arranges finally release).
function Acquire-Lock {
    param([string]$dir)
    while ($true) {
        try {
            New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null
            break
        } catch {
            if (Test-LockHolderDead $dir) {
                Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
                continue
            }
            Start-Sleep -Milliseconds 300
        }
    }
    "$PID" | Out-File -FilePath "$dir\pid" -Encoding ascii
    return $true
}

# Acquire both locks, then wrap main script in try/finally to release them both.
Acquire-Lock $lockDir | Out-Null
Acquire-Lock $wasmLockDir | Out-Null

# From here both locks are held; the finally releases them on any exit.
try {

# Clean destination
Remove-Item -Recurse -Force "$dest\build-context","$dest\mcp-os","$dest\oauth" -ErrorAction SilentlyContinue

# -- PII engine wasm artifact (crates/pii-engine-wasm) ------------------------
# Built fresh on every run that stages policies — no prebuilt/placeholder fallback (mirrors
# the .sh). Local Windows dev builds need Git Bash on PATH (already required elsewhere in this
# repo's tooling); Windows CI never reaches this file — it runs bundle-build-context.sh instead.
bash 'crates/pii-engine-wasm/build-wasm.sh' $wasmPkgDir
if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine('ERROR: failed to build the PII engine wasm artifact (crates/pii-engine-wasm).')
    [Console]::Error.WriteLine("Install the toolchain with 'make setup-dev' (rustup target wasm32-unknown-unknown + wasm-pack) and retry.")
    exit 1
}
$wasmArtifacts = Get-ChildItem -Path $wasmPkgDir -Filter '*_bg.wasm' -File -ErrorAction SilentlyContinue
if ((-not $wasmArtifacts) -or ($wasmArtifacts | Where-Object { $_.Length -eq 0 })) {
    [Console]::Error.WriteLine("ERROR: PII engine wasm artifact missing or empty in $wasmPkgDir after build (expected *_bg.wasm).")
    exit 1
}

# -- Build context (containers + MCP server sources) --------------------------

# Copy-SourceTree <src> <dst>: mirrors copy_source_tree() in the .sh — never enters a directory
#   named in bundle.rs::HOST_BUILD_OUTPUT_DIRS (alignment test-enforced); parallel builds rewrite those.
function Copy-SourceTree {
    param([string]$src, [string]$dst)
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $src -Force) {
        if ($item.PSIsContainer) {
            if ($item.Name -in 'target', 'dist', 'node_modules') { continue }
            Copy-SourceTree $item.FullName (Join-Path $dst $item.Name)
        } else {
            Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $dst $item.Name)
        }
    }
}

Copy-SourceTree containers "$dest\build-context\containers"

# Vendor crates/pii-engine into the context (mirrors the .sh): Containerfile.proxy COPYs it to
# recreate the repo's `../../crates/pii-engine` relative layout (proxy/Cargo.toml, ADR-073 F4)
# since the proxy image builds from the `containers/` context alone.
Copy-SourceTree crates\pii-engine "$dest\build-context\containers\crates\pii-engine"

# rules.yaml (mirrors the .sh): pii-engine's policy.rs include_str!s it repo-root-relative
# (`../../../mcp-servers/policies/rules.yaml`) — Containerfile.proxy COPYs it alongside.
New-Item -ItemType Directory -Path "$dest\build-context\containers\mcp-servers\policies" -Force | Out-Null
Copy-Item "$mcpServersDir\policies\rules.yaml" "$dest\build-context\containers\mcp-servers\policies\rules.yaml"

# Strip CR from every .sh. UTF-8 without BOM — a BOM before the shebang
# breaks Linux exec just like CRLF would.
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
Get-ChildItem -Path "$dest\build-context\containers" -Recurse -Include '*.sh' -File |
    ForEach-Object {
        $content = [System.IO.File]::ReadAllText($_.FullName, $utf8NoBom)
        if ($content.Contains("`r")) {
            [System.IO.File]::WriteAllText($_.FullName, $content.Replace("`r", ""), $utf8NoBom)
        }
    }

New-Item -ItemType Directory -Path "$dest\build-context\mcp-servers" -Force | Out-Null
Copy-Item "$mcpServersDir\tsconfig.base.json" "$dest\build-context\mcp-servers\"

# os is intentionally excluded — it runs on the host and is bundled separately as mcp-os/
# playwright has no own src/ — the image installs @playwright/mcp from npm at build time.
$services = @('shared','policies','hub','slack','sharepoint','redmine','gitlab','github','atlassian','office','playwright','context7')

foreach ($svc in $services) {
    $svcSrc = "$mcpServersDir\$svc"
    $svcDest = "$dest\build-context\mcp-servers\$svc"
    New-Item -ItemType Directory -Path $svcDest -Force | Out-Null
    Copy-Item "$svcSrc\package.json" "$svcDest\"
    if (Test-Path "$svcSrc\package-lock.json") {
        Copy-Item "$svcSrc\package-lock.json" "$svcDest\"
    }
    # Some services (e.g. playwright) wrap an upstream npm package and have no src/.
    if (Test-Path "$svcSrc\src") {
        Copy-Item -Recurse "$svcSrc\src" "$svcDest\src"
    }
    if (Test-Path "$svcSrc\tsconfig.json") {
        Copy-Item "$svcSrc\tsconfig.json" "$svcDest\"
    }
    # policies: template YAMLs the hub Containerfile COPYs and reads at runtime.
    if (Test-Path "$svcSrc\templates") {
        Copy-Item -Recurse "$svcSrc\templates" "$svcDest\templates"
    }
    # policies: wasm-pkg is built into the real tree ($wasmPkgDir, not $mcpServersDir) just above;
    # stage that real artifact, never a placeholder (the hub Containerfile COPYs policies/wasm-pkg).
    if ($svc -eq 'policies') {
        New-Item -ItemType Directory -Path "$svcDest\wasm-pkg" -Force | Out-Null
        Copy-Item -Recurse "$wasmPkgDir\*" "$svcDest\wasm-pkg\" -Force
    }
    # office ships Python support-scripts + a pinned requirements.txt that its Dockerfile COPYs.
    # Exclude test_*.py — pytest isn't in the runtime image and they're dead weight there.
    if (Test-Path "$svcSrc\scripts") {
        New-Item -ItemType Directory -Path "$svcDest\scripts" -Force | Out-Null
        Get-ChildItem -Path "$svcSrc\scripts" -File | Where-Object { $_.Name -notlike 'test_*.py' } |
            ForEach-Object { Copy-Item $_.FullName "$svcDest\scripts\" }
    }
    if (Test-Path "$svcSrc\requirements.txt") {
        Copy-Item "$svcSrc\requirements.txt" "$svcDest\"
    }
    foreach ($f in @('Dockerfile','Containerfile')) {
        if (Test-Path "$svcSrc\$f") {
            Copy-Item "$svcSrc\$f" "$svcDest\"
        }
    }
}

# -- mcp-os + oauth (host-side TypeScript workers) ---------------------------

# Stage-Host-Worker <worker-dir-name> <bundle-dir-name>: mirrors stage_host_worker() in the
#   .sh; Copy-Item not a junction (Tauri's bundler doesn't reliably preserve them in NSIS).
function Stage-Host-Worker {
    param([string]$worker, [string]$bundle)
    New-Item -ItemType Directory -Path "$dest\$bundle\$worker","$dest\$bundle\shared" -Force | Out-Null
    Copy-Item -Recurse "$mcpServersDir\$worker\dist" "$dest\$bundle\$worker\dist"
    Copy-Item -Recurse "$mcpServersDir\shared\dist" "$dest\$bundle\shared\dist"
    # Install production deps only — standalone lockfile, then deterministic npm ci.
    Copy-Item "$mcpServersDir\shared\package.json" "$dest\$bundle\shared\"
    Push-Location "$dest\$bundle\shared"
    npm pkg delete devDependencies
    if ($LASTEXITCODE -ne 0) { throw "npm pkg delete devDependencies failed in $dest\$bundle\shared" }
    npm install --package-lock-only --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "npm install --package-lock-only failed in $dest\$bundle\shared" }
    npm ci --omit=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "npm ci --omit=dev failed in $dest\$bundle\shared" }
    Pop-Location
    New-Item -ItemType Directory -Path "$dest\$bundle\$worker\node_modules\@speedwave" -Force | Out-Null
    Copy-Item -Recurse "$dest\$bundle\shared" "$dest\$bundle\$worker\node_modules\@speedwave\mcp-shared"
}

Stage-Host-Worker -worker os -bundle mcp-os
Stage-Host-Worker -worker oauth -bundle oauth

Write-Host "Build context bundled into $dest"

} finally {
    # Release both mutexes on any exit (mirrors the .sh trap).
    Remove-Item -Recurse -Force $lockDir,$wasmLockDir -ErrorAction SilentlyContinue
}
