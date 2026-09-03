# Signs the Windows PE binaries Speedwave builds itself with Azure Artifact Signing (ADR-086).
# Two callers: Tauri bundle.windows.signCommand (one file) and beforeBundleCommand (-Bundled).
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$File = '',
    [switch]$Bundled
)
$ErrorActionPreference = 'Stop'

# Pinned like the other CI-side installs (alignments rules); bump deliberately.
$ModuleVersion = '0.1.17'
# Artifact Signing certificates live three days: a signature stays valid only via this RFC3161 TSA.
$TimestampServer = 'http://timestamp.acs.microsoft.com'

# SRC_TAURI is overridable by tests; defaults to desktop/src-tauri (mirrors sign-bundled-binaries.sh).
$RepoRoot = Split-Path -Parent $PSScriptRoot
$SrcTauri = if ($env:SRC_TAURI) { $env:SRC_TAURI } else { Join-Path $RepoRoot 'desktop\src-tauri' }

# PE files we build ourselves that ship via tauri.windows.conf.json bundle.resources (keep in sync).
# Vendor-signed nodejs\node.exe and the hash-pinned vulkan-1.dll must never be re-signed.
$SignTargets = @(
    'cli\speedwave.exe'
)

$Endpoint = $env:AZURE_ARTIFACT_SIGNING_ENDPOINT
$Account = $env:AZURE_ARTIFACT_SIGNING_ACCOUNT
$CertificateProfile = $env:AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE

if (($Bundled -and $File) -or (-not $Bundled -and -not $File)) {
    throw 'Usage: sign-windows-binaries.ps1 <file> | sign-windows-binaries.ps1 -Bundled'
}

if (-not ($Endpoint -and $Account -and $CertificateProfile)) {
    Write-Output 'AZURE_ARTIFACT_SIGNING_* not set - skipping Windows code signing (unsigned dev build)'
    exit 0
}

# The ArtifactSigning module is published for PowerShell 7 only (PSEdition_Core); the hooks
# launch Windows PowerShell because only it exists on every host, so the signing path re-execs.
if ($PSVersionTable.PSEdition -ne 'Core') {
    if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) {
        throw 'pwsh (PowerShell 7) is required to sign; install it or unset AZURE_ARTIFACT_SIGNING_* for an unsigned build'
    }
    $forward = if ($Bundled) { @('-Bundled') } else { @($File) }
    & pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath @forward
    exit $LASTEXITCODE
}

function Import-SigningModule {
    $installed = Get-Module -ListAvailable -Name ArtifactSigning | Where-Object { $_.Version -eq [version]$ModuleVersion }
    if (-not $installed) {
        Write-Output "Installing ArtifactSigning PowerShell module $ModuleVersion..."
        Install-Module -Name ArtifactSigning -RequiredVersion $ModuleVersion -Scope CurrentUser -Force -AllowClobber
    }
    Import-Module -Name ArtifactSigning -RequiredVersion $ModuleVersion
}

function Invoke-Sign([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "expected binary does not exist: $Path (if tauri.windows.conf.json added or renamed a resource, update `$SignTargets)"
    }
    Write-Output "  signing: $Path"
    # Hosted runners have no managed identity and the interactive/IDE credentials only add probe
    # latency; CI authenticates through azure/login, which the AzureCliCredential picks up.
    Invoke-ArtifactSigning -Endpoint $Endpoint -CodeSigningAccountName $Account -CertificateProfileName $CertificateProfile `
        -Files $Path -FileDigest SHA256 -TimestampRfc3161 $TimestampServer -TimestampDigest SHA256 `
        -ExcludeManagedIdentityCredential -ExcludeSharedTokenCacheCredential -ExcludeVisualStudioCredential `
        -ExcludeVisualStudioCodeCredential -ExcludeAzurePowerShellCredential -ExcludeAzureDeveloperCliCredential `
        -ExcludeInteractiveBrowserCredential
}

function Test-Signature([string]$Path) {
    $sig = Get-AuthenticodeSignature -LiteralPath $Path
    if ($sig.Status -ne 'Valid') {
        throw "signature verification failed for ${Path}: $($sig.Status) ($($sig.StatusMessage))"
    }
    if ($null -eq $sig.TimeStamperCertificate) {
        throw "signature on $Path carries no timestamp; it would expire with the three-day certificate"
    }
    Write-Output "  verified: $($sig.SignerCertificate.Subject)"
}

Import-SigningModule
if ($Bundled) {
    Write-Output "Signing bundled Windows binaries with Azure Artifact Signing ($Account/$CertificateProfile)"
    foreach ($target in $SignTargets) {
        $path = Join-Path $SrcTauri $target
        Invoke-Sign $path
        Test-Signature $path
    }
    Write-Output 'Bundled binaries signed successfully'
} else {
    Invoke-Sign $File
    Test-Signature $File
}
