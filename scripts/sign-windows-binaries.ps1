[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$File = '',
    [switch]$Bundled
)
$ErrorActionPreference = 'Stop'

$ModuleVersion = '0.1.17'
$TimestampServer = 'http://timestamp.acs.microsoft.com'
$ArtifactSigningEku = '1.3.6.1.4.1.311.97.1.0'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SrcTauri = if ($env:SRC_TAURI) { $env:SRC_TAURI } else { Join-Path $RepoRoot 'desktop\src-tauri' }

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

if ($PSVersionTable.PSEdition -ne 'Core') {
    if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) {
        throw 'pwsh (PowerShell 7) is required to sign; install it or unset AZURE_ARTIFACT_SIGNING_* for an unsigned build'
    }
    if ($Bundled) {
        & pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath -Bundled
    } else {
        & pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath $File
    }
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
    $ekus = $sig.SignerCertificate.Extensions |
        Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } |
        ForEach-Object { $_.EnhancedKeyUsages } | ForEach-Object { $_.Value }
    if ($ekus -notcontains $ArtifactSigningEku) {
        throw "signature on $Path is not from Azure Artifact Signing (EKU $ArtifactSigningEku missing); signer: $($sig.SignerCertificate.Subject)"
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
