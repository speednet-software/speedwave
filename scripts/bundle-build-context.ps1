
$ErrorActionPreference = 'Stop'

$dest = if ($env:BUNDLE_DEST) { $env:BUNDLE_DEST } else { 'desktop\src-tauri' }
New-Item -ItemType Directory -Path $dest -Force | Out-Null
$mcpServersDir = if ($env:BUNDLE_MCP_SERVERS_DIR) { $env:BUNDLE_MCP_SERVERS_DIR } else { 'mcp-servers' }
if (-not (Test-Path -Path $mcpServersDir -PathType Container)) {
    [Console]::Error.WriteLine("ERROR: mcp-servers tree not found at $mcpServersDir (BUNDLE_MCP_SERVERS_DIR).")
    exit 1
}

$lockDir = "$dest\.bundle.lock"
$wasmPkgDir = 'mcp-servers/policies/wasm-pkg'
$wasmLockDir = 'mcp-servers/policies/.wasm-build.lock'

function Test-LockHolderDead {
    param([string]$dir)
    $holder = (Get-Content "$dir\pid" -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not $holder) { return $false }  
    try {
        $null = Get-Process -Id ([int]$holder) -ErrorAction Stop
        return $false                      
    } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
        return $true                       
    } catch {
        return $false                      
    }
}

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

Acquire-Lock $lockDir | Out-Null
Acquire-Lock $wasmLockDir | Out-Null

try {

Remove-Item -Recurse -Force "$dest\build-context","$dest\mcp-os","$dest\oauth" -ErrorAction SilentlyContinue

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


New-Item -ItemType Directory -Path "$dest\build-context" -Force | Out-Null
Copy-Item -Recurse containers "$dest\build-context\containers"

New-Item -ItemType Directory -Path "$dest\build-context\containers\crates" -Force | Out-Null
Copy-Item -Recurse crates\pii-engine "$dest\build-context\containers\crates\pii-engine"

New-Item -ItemType Directory -Path "$dest\build-context\containers\mcp-servers\policies" -Force | Out-Null
Copy-Item "$mcpServersDir\policies\rules.yaml" "$dest\build-context\containers\mcp-servers\policies\rules.yaml"

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

$services = @('shared','policies','hub','slack','sharepoint','redmine','gitlab','github','atlassian','office','playwright','context7')

foreach ($svc in $services) {
    $svcSrc = "$mcpServersDir\$svc"
    $svcDest = "$dest\build-context\mcp-servers\$svc"
    New-Item -ItemType Directory -Path $svcDest -Force | Out-Null
    Copy-Item "$svcSrc\package.json" "$svcDest\"
    if (Test-Path "$svcSrc\package-lock.json") {
        Copy-Item "$svcSrc\package-lock.json" "$svcDest\"
    }
    if (Test-Path "$svcSrc\src") {
        Copy-Item -Recurse "$svcSrc\src" "$svcDest\src"
    }
    if (Test-Path "$svcSrc\tsconfig.json") {
        Copy-Item "$svcSrc\tsconfig.json" "$svcDest\"
    }
    if (Test-Path "$svcSrc\templates") {
        Copy-Item -Recurse "$svcSrc\templates" "$svcDest\templates"
    }
    if ($svc -eq 'policies') {
        New-Item -ItemType Directory -Path "$svcDest\wasm-pkg" -Force | Out-Null
        Copy-Item -Recurse "$wasmPkgDir\*" "$svcDest\wasm-pkg\" -Force
    }
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


function Stage-Host-Worker {
    param([string]$worker, [string]$bundle)
    New-Item -ItemType Directory -Path "$dest\$bundle\$worker","$dest\$bundle\shared" -Force | Out-Null
    Copy-Item -Recurse "$mcpServersDir\$worker\dist" "$dest\$bundle\$worker\dist"
    Copy-Item -Recurse "$mcpServersDir\shared\dist" "$dest\$bundle\shared\dist"
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
    Remove-Item -Recurse -Force $lockDir,$wasmLockDir -ErrorAction SilentlyContinue
}
