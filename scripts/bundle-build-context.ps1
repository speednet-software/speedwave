# bundle-build-context.ps1 — PowerShell equivalent of bundle-build-context.sh
# Copies container build context and mcp-os into desktop/src-tauri/ for Tauri resource bundling.
#
# Usage: powershell -File scripts/bundle-build-context.ps1
# Must be run from the repo root.

$ErrorActionPreference = 'Stop'

$dest = 'desktop\src-tauri'

# Clean destination
Remove-Item -Recurse -Force "$dest\build-context","$dest\mcp-os" -ErrorAction SilentlyContinue

# -- Build context (containers + MCP server sources) --------------------------

New-Item -ItemType Directory -Path "$dest\build-context" -Force | Out-Null
Copy-Item -Recurse containers "$dest\build-context\containers"

New-Item -ItemType Directory -Path "$dest\build-context\mcp-servers" -Force | Out-Null
Copy-Item mcp-servers\tsconfig.base.json "$dest\build-context\mcp-servers\"

# os is intentionally excluded — it runs on the host and is bundled separately as mcp-os/
$services = @('shared','hub','slack','sharepoint','redmine','gitlab')

foreach ($svc in $services) {
    $svcDest = "$dest\build-context\mcp-servers\$svc"
    New-Item -ItemType Directory -Path $svcDest -Force | Out-Null
    Copy-Item "mcp-servers\$svc\package.json" "$svcDest\"
    if (Test-Path "mcp-servers\$svc\package-lock.json") {
        Copy-Item "mcp-servers\$svc\package-lock.json" "$svcDest\"
    }
    Copy-Item -Recurse "mcp-servers\$svc\src" "$svcDest\src"
    if (Test-Path "mcp-servers\$svc\tsconfig.json") {
        Copy-Item "mcp-servers\$svc\tsconfig.json" "$svcDest\"
    }
    foreach ($f in @('Dockerfile','Containerfile')) {
        if (Test-Path "mcp-servers\$svc\$f") {
            Copy-Item "mcp-servers\$svc\$f" "$svcDest\"
        }
    }
}

# -- mcp-os (host-side TypeScript worker) -------------------------------------

New-Item -ItemType Directory -Path "$dest\mcp-os\os","$dest\mcp-os\shared" -Force | Out-Null
Copy-Item -Recurse mcp-servers\os\dist "$dest\mcp-os\os\dist"
Copy-Item -Recurse mcp-servers\shared\dist "$dest\mcp-os\shared\dist"
# Always install production deps (workspace hoisting means
# mcp-servers\shared\node_modules\ is empty, so copying it never worked)
Copy-Item mcp-servers\shared\package.json "$dest\mcp-os\shared\"
Copy-Item mcp-servers\package-lock.json "$dest\mcp-os\shared\"
Push-Location "$dest\mcp-os\shared"
npm ci --omit=dev --ignore-scripts
Pop-Location

# Copy @speedwave/mcp-shared so Node.js resolves it from os/dist/index.js.
# Uses Copy-Item instead of Junction because Tauri's resource bundler does not
# reliably preserve junctions/symlinks in NSIS packages.
New-Item -ItemType Directory -Path "$dest\mcp-os\os\node_modules\@speedwave" -Force | Out-Null
Copy-Item -Recurse "$dest\mcp-os\shared" "$dest\mcp-os\os\node_modules\@speedwave\mcp-shared"

Write-Host "Build context bundled into $dest"
