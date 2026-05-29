# SSOT: Hyper-V firewall rule for the Speedwave WSL VM.
# Consumed by: NSIS POSTINSTALL/POSTUNINSTALL, WiX CustomAction.
# Usage: firewall.ps1 -Mode install|uninstall
# Fail-open: log warn and exit 0 on policy/permission failure.
# Ref: https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/hyper-v-firewall

param(
  [ValidateSet('install', 'uninstall')]
  [string]$Mode = 'install'
)

$ErrorActionPreference = 'Continue'

# WSL VMCreatorId is fixed by Microsoft for all WSL2 distros.
$WslVmCreatorId = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
$RuleName = 'Speedwave WSL Inbound'

function Write-Status($msg) { Write-Output "speedwave-firewall: $msg" }

if ($Mode -eq 'install') {
  # Remove stale WDF block rules left by users who clicked "Anuluj/Cancel"
  # on prior WDF prompts before the Hyper-V rule existed. Block rules in WDF
  # do not interact with Hyper-V firewall but mislead diagnostics.
  try {
    $stale = Get-NetFirewallRule -Action Block -ErrorAction SilentlyContinue | Where-Object {
      $app = $_ | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
      $app -and $app.Program -and (
        $app.Program -match 'speedwave-desktop\.exe$' -or
        $app.Program -match 'Speedwave\.exe$' -or
        $app.Program -match '\\nodejs\\node\.exe$' -or
        $app.Program -match '\\\.speedwave[^\\]*\\bin\\speedwave\.exe$'
      )
    }
    foreach ($r in $stale) {
      Write-Status "removing stale WDF block rule: $($r.DisplayName)"
      Remove-NetFirewallRule -Name $r.Name -ErrorAction SilentlyContinue
    }
  } catch {
    Write-Status "WDF cleanup failed (non-fatal): $_"
  }

  # Create / re-create Hyper-V firewall rule. Idempotent.
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
    exit 0
  } catch {
    Write-Status "Hyper-V rule install failed (fail-open): $_"
    exit 0
  }
}

if ($Mode -eq 'uninstall') {
  try {
    Get-NetFirewallHyperVRule -DisplayName $RuleName -ErrorAction SilentlyContinue |
      Remove-NetFirewallHyperVRule -ErrorAction SilentlyContinue
    Write-Status "Hyper-V rule removed"
    exit 0
  } catch {
    Write-Status "Hyper-V rule uninstall failed (fail-open): $_"
    exit 0
  }
}
