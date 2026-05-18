# bundle-build-context.ps1 — PowerShell equivalent of bundle-build-context.sh
# Copies container build context, mcp-os, host_exec, and the oauth worker into
# desktop\src-tauri\ for Tauri resource bundling.
#
# Usage: powershell -File scripts/bundle-build-context.ps1
# Must be run from the repo root.
#
# CI reach: this script is for LOCAL Windows developer builds only. GitHub
# Actions on windows-latest runs bundle-build-context.sh via `shell: bash`
# (Git Bash), so the .sh path is exercised by CI on every platform.

$ErrorActionPreference = 'Stop'

$dest = 'desktop\src-tauri'

# Clean destination
Remove-Item -Recurse -Force "$dest\build-context","$dest\mcp-os","$dest\host_exec","$dest\oauth" -ErrorAction SilentlyContinue

# -- Build context (containers + MCP server sources) --------------------------

New-Item -ItemType Directory -Path "$dest\build-context" -Force | Out-Null
Copy-Item -Recurse containers "$dest\build-context\containers"

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
$services = @('shared','hub','slack','sharepoint','redmine','gitlab','github','atlassian','office','playwright')

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

# -- mcp-os + host_exec + oauth (host-side TypeScript workers) ---------------

# Stage-Host-Worker <worker-dir-name> <bundle-dir-name>
#   Mirrors stage_host_worker() in bundle-build-context.sh — stages
#   mcp-servers\<worker>\dist plus the @speedwave\mcp-shared dependency tree
#   into $dest\<bundle>\, the same layout mcp-os has always used. Copy-Item
#   rather than a junction because Tauri's resource bundler doesn't reliably
#   preserve junctions/symlinks in NSIS packages.
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
Stage-Host-Worker -worker host_exec -bundle host_exec
Stage-Host-Worker -worker oauth -bundle oauth

Write-Host "Build context bundled into $dest"
