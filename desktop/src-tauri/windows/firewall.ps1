# SSOT: Windows firewall rules for Speedwave under WSL2 mirrored networking.
# Two layers (ADR-067): (1) a Hyper-V firewall rule scoped to the WSL
# VMCreatorId governs container<->host traffic across the WSL VM boundary;
# (2) host Windows Defender Firewall (WDF) per-program ALLOW rules suppress the
# "allow an app to access the network" consent prompt for the HOST listeners
# (bundled node.exe workers + speedwave-desktop.exe) that bind the WSL adapter
# IP. The Hyper-V rule alone does NOT stop that prompt — it is a separate
# firewall engine; both are required.
# Consumed by: NSIS POSTINSTALL/POSTUNINSTALL, WiX CustomAction, Desktop runtime.
# Modes: install|uninstall (installer, never self-elevate) ; ensure|install-elevated (Desktop runtime).
# Fail-open: log warn and exit 0 on policy/permission failure.
# Refs: https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/hyper-v-firewall
#       https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules

param(
  [ValidateSet('install', 'uninstall', 'ensure', 'install-elevated')]
  [string]$Mode = 'install',

  # Semicolon-separated absolute paths of host listener binaries to pre-authorize
  # at the WDF layer (node.exe, speedwave-desktop.exe). Resolved per-install by
  # the caller (paths differ between perUser and per-machine installs). A single
  # string (not [string[]]) because PowerShell -File cannot bind a multi-element
  # array; ';' is a safe separator (illegal in Windows file paths). Wildcards are
  # NOT supported by WDF application rules — must be exact paths.
  [string]$Programs = ''
)

$ErrorActionPreference = 'Continue'

# Split the semicolon-separated program list into an array, dropping blanks.
$ProgramList = @($Programs -split ';' | Where-Object { $_ -ne '' })

# WSL VMCreatorId is fixed by Microsoft for all WSL2 distros.
$WslVmCreatorId = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
$RuleName = 'Speedwave WSL Inbound'
$WdfRulePrefix = 'Speedwave Host Allow'

function Write-Status($msg) { Write-Output "speedwave-firewall: $msg" }

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Read-only existence check; works without admin (free idempotency gate, no UAC).
# Ready only when BOTH the Hyper-V rule and a WDF allow rule for every requested
# program exist — so 'ensure' re-creates whatever is missing.
function Test-RuleExists {
  if (-not (Get-NetFirewallHyperVRule -DisplayName $RuleName -ErrorAction SilentlyContinue)) {
    return $false
  }
  foreach ($prog in $ProgramList) {
    $rule = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
      Where-Object { $_.Program -eq $prog } |
      Get-NetFirewallRule -ErrorAction SilentlyContinue |
      Where-Object { $_.Action -eq 'Allow' -and $_.Direction -eq 'Inbound' }
    if (-not $rule) { return $false }
  }
  return $true
}

# Removes any stale WDF Block rules for our binaries (left by a user who clicked
# Anuluj/Cancel on a prior prompt). Explicit Block beats Allow, so this MUST run
# before creating the Allow rules. Matches both the legacy patterns and the
# exact requested program paths.
function Remove-StaleBlockRules {
  try {
    $stale = Get-NetFirewallRule -Action Block -ErrorAction SilentlyContinue | Where-Object {
      $app = $_ | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
      $app -and $app.Program -and (
        $app.Program -match 'speedwave-desktop\.exe$' -or
        $app.Program -match 'Speedwave\.exe$' -or
        $app.Program -match '\\nodejs\\node\.exe$' -or
        $app.Program -match '\\\.speedwave[^\\]*\\bin\\speedwave\.exe$' -or
        ($ProgramList -contains $app.Program)
      )
    }
    foreach ($r in $stale) {
      Write-Status "removing stale WDF block rule: $($r.DisplayName)"
      Remove-NetFirewallRule -Name $r.Name -ErrorAction SilentlyContinue
    }
  } catch {
    Write-Status "WDF block-rule cleanup failed (non-fatal): $_"
  }
}

# Creates a host WDF inbound ALLOW rule per program so Windows never prompts for
# that binary. Idempotent: removes our own prior allow rule for the path first.
function Install-WdfAllowRules {
  foreach ($prog in $ProgramList) {
    try {
      Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
        Where-Object { $_.Program -eq $prog } |
        Get-NetFirewallRule -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like "$WdfRulePrefix*" } |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
      $leaf = Split-Path $prog -Leaf
      $params = @{
        DisplayName = "$WdfRulePrefix ($leaf)"
        Program     = $prog
        Direction   = 'Inbound'
        Action      = 'Allow'
        Profile     = 'Any'
        Enabled     = 'True'
        ErrorAction = 'Stop'
      }
      New-NetFirewallRule @params | Out-Null
      Write-Status "WDF allow rule installed for $prog"
    } catch {
      Write-Status "WDF allow rule failed for ${prog} (non-fatal): $_"
    }
  }
}

# Privileged body (requires admin): stale-block cleanup, then the Hyper-V rule
# (VM-boundary reachability) and the WDF allow rules (suppress host prompt).
# Returns $true on Hyper-V success, $false on caught failure (fail-open).
function Install-FirewallRule {
  Remove-StaleBlockRules
  Install-WdfAllowRules

  try {
    Get-NetFirewallHyperVRule -DisplayName $RuleName -ErrorAction SilentlyContinue |
      Remove-NetFirewallHyperVRule -ErrorAction SilentlyContinue
    # Splatting (no backtick line-continuation): a backtick is the NSIS
    # FileWrite string delimiter and has no escape, so it breaks makensis.
    $params = @{
      DisplayName = $RuleName
      Direction   = 'Inbound'
      Action      = 'Allow'
      VMCreatorId = $WslVmCreatorId
      Protocol    = 'TCP'
      LocalPorts  = 'Any'
      ErrorAction = 'Stop'
    }
    New-NetFirewallHyperVRule @params | Out-Null
    Write-Status "Hyper-V rule installed for VMCreatorId $WslVmCreatorId"
    return $true
  } catch {
    Write-Status "Hyper-V rule install failed (fail-open): $_"
    return $false
  }
}

# Installer mode (NSIS/MSI): never self-elevate. Relies on the installer's own
# elevation (MSI runs as LocalSystem; perUser NSIS may lack admin and the
# Desktop runtime 'ensure' fallback then creates the rules). Always exit 0.
if ($Mode -eq 'install') {
  if (Test-RuleExists) {
    Write-Status "rules already present"
    exit 0
  }
  Install-FirewallRule | Out-Null
  exit 0
}

if ($Mode -eq 'uninstall') {
  try {
    Get-NetFirewallHyperVRule -DisplayName $RuleName -ErrorAction SilentlyContinue |
      Remove-NetFirewallHyperVRule -ErrorAction SilentlyContinue
    Get-NetFirewallRule -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like "$WdfRulePrefix*" } |
      Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Write-Status "firewall rules removed"
    exit 0
  } catch {
    Write-Status "firewall rule uninstall failed (fail-open): $_"
    exit 0
  }
}

# Internal mode: run the privileged body directly. NO admin check, NO relaunch
# (prevents an infinite UAC loop). Invoked only by 'ensure' self-elevation.
if ($Mode -eq 'install-elevated') {
  if (Install-FirewallRule) { exit 0 } else { exit 2 }
}

# Desktop runtime mode: existence-check first (non-admin, no UAC). If missing,
# create directly when already admin, else signal the Rust caller (exit 3) that
# elevation is required so it can decide whether to prompt.
if ($Mode -eq 'ensure') {
  if (Test-RuleExists) {
    Write-Status "rules already present"
    exit 0
  }
  if (Test-IsAdmin) {
    if (Install-FirewallRule -and (Test-RuleExists)) { exit 0 } else { exit 2 }
  }
  Write-Status "rules missing and elevation required"
  exit 3
}
