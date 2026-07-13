# PowerShell equivalent of bundle-build-context.sh; run from repo root. LOCAL Windows dev builds
# only — CI (windows-latest) runs bundle-build-context.sh via Git Bash instead.

$ErrorActionPreference = 'Stop'

# Default to the in-repo Tauri resource dir. Tests override via $env:BUNDLE_DEST
# so concurrent test + dev runs do not race on the same files (mirrors the .sh).
$dest = if ($env:BUNDLE_DEST) { $env:BUNDLE_DEST } else { 'desktop\src-tauri' }
New-Item -ItemType Directory -Path $dest -Force | Out-Null

# Serialize concurrent runs on DEST (mirrors the .sh mkdir-mutex): non-atomic body can bake a
# 0-byte package.json into a worker image otherwise; a lock whose holder PID is dead is reclaimed.
$lockDir = "$dest\.bundle.lock"

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

while ($true) {
    try {
        New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null
        break
    } catch {
        if (Test-LockHolderDead $lockDir) {
            Remove-Item -Recurse -Force $lockDir -ErrorAction SilentlyContinue
            continue
        }
        Start-Sleep -Milliseconds 300
    }
}

# From here the lock is held; the finally releases it on ANY exit. Writing the PID
# is inside the try so a failed write still releases the lock (no deadlock).
try {
    "$PID" | Out-File -FilePath "$lockDir\pid" -Encoding ascii

# Clean destination
Remove-Item -Recurse -Force "$dest\build-context","$dest\mcp-os","$dest\oauth" -ErrorAction SilentlyContinue

# -- Build context (containers + MCP server sources) --------------------------

New-Item -ItemType Directory -Path "$dest\build-context" -Force | Out-Null
Copy-Item -Recurse containers "$dest\build-context\containers"

# Host build outputs are never image content — prune bundle.rs::HOST_BUILD_OUTPUT_DIRS
# (alignment test-enforced). Recursion stops at a match, mirroring the .sh `find -prune`.
function Remove-BuildOutputs {
    param([string]$root)
    foreach ($dir in Get-ChildItem -Path $root -Directory -Force) {
        if ($dir.Name -in 'target', 'dist', 'node_modules') {
            Remove-Item -Recurse -Force $dir.FullName
        } else {
            Remove-BuildOutputs $dir.FullName
        }
    }
}
Remove-BuildOutputs "$dest\build-context\containers"

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
Copy-Item mcp-servers\tsconfig.base.json "$dest\build-context\mcp-servers\"

# os is intentionally excluded — it runs on the host and is bundled separately as mcp-os/
# playwright has no own src/ — the image installs @playwright/mcp from npm at build time.
$services = @('shared','policies','hub','slack','sharepoint','redmine','gitlab','github','atlassian','office','playwright','context7')

foreach ($svc in $services) {
    $svcDest = "$dest\build-context\mcp-servers\$svc"
    New-Item -ItemType Directory -Path $svcDest -Force | Out-Null
    Copy-Item "mcp-servers\$svc\package.json" "$svcDest\"
    if (Test-Path "mcp-servers\$svc\package-lock.json") {
        Copy-Item "mcp-servers\$svc\package-lock.json" "$svcDest\"
    }
    # Some services (e.g. playwright) wrap an upstream npm package and have no src/.
    if (Test-Path "mcp-servers\$svc\src") {
        Copy-Item -Recurse "mcp-servers\$svc\src" "$svcDest\src"
    }
    if (Test-Path "mcp-servers\$svc\tsconfig.json") {
        Copy-Item "mcp-servers\$svc\tsconfig.json" "$svcDest\"
    }
    # policies: template YAMLs the hub Containerfile COPYs and reads at runtime.
    if (Test-Path "mcp-servers\$svc\templates") {
        Copy-Item -Recurse "mcp-servers\$svc\templates" "$svcDest\templates"
    }
    # office ships Python support-scripts + a pinned requirements.txt that its Dockerfile COPYs.
    # Exclude test_*.py — pytest isn't in the runtime image and they're dead weight there.
    if (Test-Path "mcp-servers\$svc\scripts") {
        New-Item -ItemType Directory -Path "$svcDest\scripts" -Force | Out-Null
        Get-ChildItem -Path "mcp-servers\$svc\scripts" -File | Where-Object { $_.Name -notlike 'test_*.py' } |
            ForEach-Object { Copy-Item $_.FullName "$svcDest\scripts\" }
    }
    if (Test-Path "mcp-servers\$svc\requirements.txt") {
        Copy-Item "mcp-servers\$svc\requirements.txt" "$svcDest\"
    }
    foreach ($f in @('Dockerfile','Containerfile')) {
        if (Test-Path "mcp-servers\$svc\$f") {
            Copy-Item "mcp-servers\$svc\$f" "$svcDest\"
        }
    }
}

# -- mcp-os + oauth (host-side TypeScript workers) ---------------------------

# Stage-Host-Worker <worker-dir-name> <bundle-dir-name>: mirrors stage_host_worker() in the
#   .sh; Copy-Item not a junction (Tauri's bundler doesn't reliably preserve them in NSIS).
function Stage-Host-Worker {
    param([string]$worker, [string]$bundle)
    New-Item -ItemType Directory -Path "$dest\$bundle\$worker","$dest\$bundle\shared" -Force | Out-Null
    Copy-Item -Recurse "mcp-servers\$worker\dist" "$dest\$bundle\$worker\dist"
    Copy-Item -Recurse "mcp-servers\shared\dist" "$dest\$bundle\shared\dist"
    # Install production deps only — standalone lockfile, then deterministic npm ci.
    Copy-Item "mcp-servers\shared\package.json" "$dest\$bundle\shared\"
    Push-Location "$dest\$bundle\shared"
    npm install --package-lock-only --ignore-scripts
    npm ci --omit=dev --ignore-scripts
    Pop-Location
    New-Item -ItemType Directory -Path "$dest\$bundle\$worker\node_modules\@speedwave" -Force | Out-Null
    Copy-Item -Recurse "$dest\$bundle\shared" "$dest\$bundle\$worker\node_modules\@speedwave\mcp-shared"
}

Stage-Host-Worker -worker os -bundle mcp-os
Stage-Host-Worker -worker oauth -bundle oauth

Write-Host "Build context bundled into $dest"

} finally {
    # Release the mutex on any exit (mirrors the .sh trap).
    Remove-Item -Recurse -Force $lockDir -ErrorAction SilentlyContinue
}
