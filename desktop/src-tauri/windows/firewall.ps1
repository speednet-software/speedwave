param(
  [ValidateSet('install', 'uninstall', 'ensure', 'install-elevated')]
  [string]$Mode = 'install',

  [string]$Programs = ''
)

$ErrorActionPreference = 'Continue'

$ProgramList = @($Programs -split ';' | Where-Object { $_ -ne '' })

$WslVmCreatorId = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
$RuleName = 'Speedwave WSL Inbound'
$WdfRulePrefix = 'Speedwave Host Allow'

function Write-Status($msg) { Write-Output "speedwave-firewall: $msg" }

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-RuleExists {
  if (-not (Get-NetFirewallHyperVRule -DisplayName $RuleName -ErrorAction SilentlyContinue)) {
    return $false
  }
  if ($ProgramList.Count -eq 0) {
    return $false
  }
  foreach ($prog in $ProgramList) {
    $rule = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
      Where-Object { $_.Program -eq $prog } |
      Get-NetFirewallRule -ErrorAction SilentlyContinue |
      Where-Object { $_.Action -eq 'Allow' -and $_.Direction -eq 'Inbound' -and $_.DisplayName -like "$WdfRulePrefix*" }
    if (-not $rule) { return $false }
  }
  return $true
}

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

function Install-FirewallRule {
  Remove-StaleBlockRules
  Install-WdfAllowRules

  try {
    Get-NetFirewallHyperVRule -DisplayName $RuleName -ErrorAction SilentlyContinue |
      Remove-NetFirewallHyperVRule -ErrorAction SilentlyContinue
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

if ($Mode -eq 'install-elevated') {
  if (Install-FirewallRule) { exit 0 } else { exit 2 }
}

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
