Var SpeedwaveCleanData
Var SpeedwaveDataDirOverride

!macro SPEEDWAVE_MATERIALIZE_SWEEP
  !define SW_SWEEP_ID ${__LINE__}
  InitPluginsDir
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\sweep.ps1" w
  IfErrors 0 sw_SWEEP_write_ok_${SW_SWEEP_ID}
    DetailPrint "Speedwave: could not create sweep.ps1 in $PLUGINSDIR — skipping."
    Goto sw_SWEEP_write_done_${SW_SWEEP_ID}
  sw_SWEEP_write_ok_${SW_SWEEP_ID}:
  FileWrite $0 `$\r$\n`
  FileWrite $0 `param($\r$\n`
  FileWrite $0 `  [ValidateSet('full', 'runtime')]$\r$\n`
  FileWrite $0 `  [string]$$Mode = 'full',$\r$\n`
  FileWrite $0 `  [string]$$InstDir,$\r$\n`
  FileWrite $0 `  [string]$$DataDir$\r$\n`
  FileWrite $0 `)$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$ErrorActionPreference = 'Stop'$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$instDir = if ($$InstDir) { $$InstDir } else { $$env:SPW_INSTDIR }$\r$\n`
  FileWrite $0 `if (-not $$instDir) { Write-Error 'SPW_INSTDIR not set'; exit 2 }$\r$\n`
  FileWrite $0 `$$dataDir = if ($$DataDir) { $$DataDir } else { $$env:SPW_DATA_DIR }$\r$\n`
  FileWrite $0 `if (-not $$dataDir) { Write-Error 'SPW_DATA_DIR not set'; exit 2 }$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$instDir = $$instDir.TrimEnd('\')$\r$\n`
  FileWrite $0 `$$dataDir = $$dataDir.TrimEnd('\')$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$nodePrefix = $$instDir + '\nodejs\'$\r$\n`
  FileWrite $0 `$$desktopExe = $$instDir + '\speedwave-desktop.exe'$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$instance = (Split-Path $$dataDir -Leaf) -replace '^\.+', ''$\r$\n`
  FileWrite $0 `if ($$instance -eq 'speedwave') {$\r$\n`
  FileWrite $0 `  $$cliName = 'speedwave.exe'$\r$\n`
  FileWrite $0 `} else {$\r$\n`
  FileWrite $0 `  $$cliName = 'speedwave-' + ($$instance -replace '^speedwave-', '') + '.exe'$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$$cliExe = $$dataDir + '\bin\' + $$cliName$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$includeWorkers = ($$Mode -eq 'full')$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `try {$\r$\n`
  FileWrite $0 `  $$procs = Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue$\r$\n`
  FileWrite $0 `  $$victims = $$procs | Where-Object {$\r$\n`
  FileWrite $0 `    $$_.ExecutablePath -and ($\r$\n`
  FileWrite $0 `      ($$includeWorkers -and $$_.ExecutablePath.StartsWith($$nodePrefix, [System.StringComparison]::OrdinalIgnoreCase)) -or$\r$\n`
  FileWrite $0 `      ($$includeWorkers -and $$_.ExecutablePath.Equals($$desktopExe, [System.StringComparison]::OrdinalIgnoreCase)) -or$\r$\n`
  FileWrite $0 `      $$_.ExecutablePath.Equals($$cliExe, [System.StringComparison]::OrdinalIgnoreCase)$\r$\n`
  FileWrite $0 `    )$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `  foreach ($$v in $$victims) {$\r$\n`
  FileWrite $0 `    Write-Output ('killing PID ' + $$v.ProcessId + ' ' + $$v.ExecutablePath)$\r$\n`
  FileWrite $0 `    Stop-Process -Id $$v.ProcessId -Force -ErrorAction SilentlyContinue$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `} catch {$\r$\n`
  FileWrite $0 `  Write-Error ('sweep enumeration failed: ' + $$_)$\r$\n`
  FileWrite $0 `  exit 3$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `if ($$includeWorkers) {$\r$\n`
  FileWrite $0 `  $$targets = @($$desktopExe, $$nodePrefix + 'node.exe', $$cliExe)$\r$\n`
  FileWrite $0 `} else {$\r$\n`
  FileWrite $0 `  $$targets = @($$cliExe)$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `for ($$i = 0; $$i -lt 20; $$i++) {$\r$\n`
  FileWrite $0 `  $$locked = $$false$\r$\n`
  FileWrite $0 `  foreach ($$t in $$targets) {$\r$\n`
  FileWrite $0 `    if (-not (Test-Path -LiteralPath $$t)) { continue }$\r$\n`
  FileWrite $0 `    try {$\r$\n`
  FileWrite $0 `      $$fs = [System.IO.File]::Open($$t, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)$\r$\n`
  FileWrite $0 `      $$fs.Close()$\r$\n`
  FileWrite $0 `    } catch {$\r$\n`
  FileWrite $0 `      $$locked = $$true$\r$\n`
  FileWrite $0 `      break$\r$\n`
  FileWrite $0 `    }$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `  if (-not $$locked) { Write-Output 'all targets unlocked'; exit 0 }$\r$\n`
  FileWrite $0 `  Start-Sleep -Milliseconds 1000$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `Write-Error 'targets still locked after 20 s'$\r$\n`
  FileWrite $0 `exit 4$\r$\n`
  FileClose $0
  sw_SWEEP_write_done_${SW_SWEEP_ID}:
  !undef SW_SWEEP_ID
!macroend

!macro SPEEDWAVE_MATERIALIZE_FIREWALL
  !define SW_FIREWALL_ID ${__LINE__}
  InitPluginsDir
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\firewall.ps1" w
  IfErrors 0 sw_FIREWALL_write_ok_${SW_FIREWALL_ID}
    DetailPrint "Speedwave: could not create firewall.ps1 in $PLUGINSDIR — skipping."
    Goto sw_FIREWALL_write_done_${SW_FIREWALL_ID}
  sw_FIREWALL_write_ok_${SW_FIREWALL_ID}:
  FileWrite $0 `param($\r$\n`
  FileWrite $0 `  [ValidateSet('install', 'uninstall', 'ensure', 'install-elevated')]$\r$\n`
  FileWrite $0 `  [string]$$Mode = 'install',$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `  [string]$$Programs = ''$\r$\n`
  FileWrite $0 `)$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$ErrorActionPreference = 'Continue'$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$ProgramList = @($$Programs -split ';' | Where-Object { $$_ -ne '' })$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$WslVmCreatorId = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'$\r$\n`
  FileWrite $0 `$$RuleName = 'Speedwave WSL Inbound'$\r$\n`
  FileWrite $0 `$$WdfRulePrefix = 'Speedwave Host Allow'$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `function Write-Status($$msg) { Write-Output $\"speedwave-firewall: $$msg$\" }$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `function Test-IsAdmin {$\r$\n`
  FileWrite $0 `  $$id = [Security.Principal.WindowsIdentity]::GetCurrent()$\r$\n`
  FileWrite $0 `  return ([Security.Principal.WindowsPrincipal]$$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `function Test-RuleExists {$\r$\n`
  FileWrite $0 `  if (-not (Get-NetFirewallHyperVRule -DisplayName $$RuleName -ErrorAction SilentlyContinue)) {$\r$\n`
  FileWrite $0 `    return $$false$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `  if ($$ProgramList.Count -eq 0) {$\r$\n`
  FileWrite $0 `    return $$false$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `  foreach ($$prog in $$ProgramList) {$\r$\n`
  FileWrite $0 `    $$rule = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |$\r$\n`
  FileWrite $0 `      Where-Object { $$_.Program -eq $$prog } |$\r$\n`
  FileWrite $0 `      Get-NetFirewallRule -ErrorAction SilentlyContinue |$\r$\n`
  FileWrite $0 `      Where-Object { $$_.Action -eq 'Allow' -and $$_.Direction -eq 'Inbound' -and $$_.DisplayName -like $\"$$WdfRulePrefix*$\" }$\r$\n`
  FileWrite $0 `    if (-not $$rule) { return $$false }$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `  return $$true$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `function Remove-StaleBlockRules {$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    $$stale = Get-NetFirewallRule -Action Block -ErrorAction SilentlyContinue | Where-Object {$\r$\n`
  FileWrite $0 `      $$app = $$_ | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue$\r$\n`
  FileWrite $0 `      $$app -and $$app.Program -and ($\r$\n`
  FileWrite $0 `        $$app.Program -match 'speedwave-desktop\.exe$$' -or$\r$\n`
  FileWrite $0 `        $$app.Program -match 'Speedwave\.exe$$' -or$\r$\n`
  FileWrite $0 `        $$app.Program -match '\\nodejs\\node\.exe$$' -or$\r$\n`
  FileWrite $0 `        $$app.Program -match '\\\.speedwave[^\\]*\\bin\\speedwave\.exe$$' -or$\r$\n`
  FileWrite $0 `        ($$ProgramList -contains $$app.Program)$\r$\n`
  FileWrite $0 `      )$\r$\n`
  FileWrite $0 `    }$\r$\n`
  FileWrite $0 `    foreach ($$r in $$stale) {$\r$\n`
  FileWrite $0 `      Write-Status $\"removing stale WDF block rule: $$($$r.DisplayName)$\"$\r$\n`
  FileWrite $0 `      Remove-NetFirewallRule -Name $$r.Name -ErrorAction SilentlyContinue$\r$\n`
  FileWrite $0 `    }$\r$\n`
  FileWrite $0 `  } catch {$\r$\n`
  FileWrite $0 `    Write-Status $\"WDF block-rule cleanup failed (non-fatal): $$_$\"$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `function Install-WdfAllowRules {$\r$\n`
  FileWrite $0 `  foreach ($$prog in $$ProgramList) {$\r$\n`
  FileWrite $0 `    try {$\r$\n`
  FileWrite $0 `      Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |$\r$\n`
  FileWrite $0 `        Where-Object { $$_.Program -eq $$prog } |$\r$\n`
  FileWrite $0 `        Get-NetFirewallRule -ErrorAction SilentlyContinue |$\r$\n`
  FileWrite $0 `        Where-Object { $$_.DisplayName -like $\"$$WdfRulePrefix*$\" } |$\r$\n`
  FileWrite $0 `        Remove-NetFirewallRule -ErrorAction SilentlyContinue$\r$\n`
  FileWrite $0 `      $$leaf = Split-Path $$prog -Leaf$\r$\n`
  FileWrite $0 `      $$params = @{$\r$\n`
  FileWrite $0 `        DisplayName = $\"$$WdfRulePrefix ($$leaf)$\"$\r$\n`
  FileWrite $0 `        Program     = $$prog$\r$\n`
  FileWrite $0 `        Direction   = 'Inbound'$\r$\n`
  FileWrite $0 `        Action      = 'Allow'$\r$\n`
  FileWrite $0 `        Profile     = 'Any'$\r$\n`
  FileWrite $0 `        Enabled     = 'True'$\r$\n`
  FileWrite $0 `        ErrorAction = 'Stop'$\r$\n`
  FileWrite $0 `      }$\r$\n`
  FileWrite $0 `      New-NetFirewallRule @params | Out-Null$\r$\n`
  FileWrite $0 `      Write-Status $\"WDF allow rule installed for $$prog$\"$\r$\n`
  FileWrite $0 `    } catch {$\r$\n`
  FileWrite $0 `      Write-Status $\"WDF allow rule failed for $${prog} (non-fatal): $$_$\"$\r$\n`
  FileWrite $0 `    }$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `function Install-FirewallRule {$\r$\n`
  FileWrite $0 `  Remove-StaleBlockRules$\r$\n`
  FileWrite $0 `  Install-WdfAllowRules$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    Get-NetFirewallHyperVRule -DisplayName $$RuleName -ErrorAction SilentlyContinue |$\r$\n`
  FileWrite $0 `      Remove-NetFirewallHyperVRule -ErrorAction SilentlyContinue$\r$\n`
  FileWrite $0 `    $$params = @{$\r$\n`
  FileWrite $0 `      DisplayName = $$RuleName$\r$\n`
  FileWrite $0 `      Direction   = 'Inbound'$\r$\n`
  FileWrite $0 `      Action      = 'Allow'$\r$\n`
  FileWrite $0 `      VMCreatorId = $$WslVmCreatorId$\r$\n`
  FileWrite $0 `      Protocol    = 'TCP'$\r$\n`
  FileWrite $0 `      LocalPorts  = 'Any'$\r$\n`
  FileWrite $0 `      ErrorAction = 'Stop'$\r$\n`
  FileWrite $0 `    }$\r$\n`
  FileWrite $0 `    New-NetFirewallHyperVRule @params | Out-Null$\r$\n`
  FileWrite $0 `    Write-Status $\"Hyper-V rule installed for VMCreatorId $$WslVmCreatorId$\"$\r$\n`
  FileWrite $0 `    return $$true$\r$\n`
  FileWrite $0 `  } catch {$\r$\n`
  FileWrite $0 `    Write-Status $\"Hyper-V rule install failed (fail-open): $$_$\"$\r$\n`
  FileWrite $0 `    return $$false$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `if ($$Mode -eq 'install') {$\r$\n`
  FileWrite $0 `  if (Test-RuleExists) {$\r$\n`
  FileWrite $0 `    Write-Status $\"rules already present$\"$\r$\n`
  FileWrite $0 `    exit 0$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `  Install-FirewallRule | Out-Null$\r$\n`
  FileWrite $0 `  exit 0$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `if ($$Mode -eq 'uninstall') {$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    Get-NetFirewallHyperVRule -DisplayName $$RuleName -ErrorAction SilentlyContinue |$\r$\n`
  FileWrite $0 `      Remove-NetFirewallHyperVRule -ErrorAction SilentlyContinue$\r$\n`
  FileWrite $0 `    Get-NetFirewallRule -ErrorAction SilentlyContinue |$\r$\n`
  FileWrite $0 `      Where-Object { $$_.DisplayName -like $\"$$WdfRulePrefix*$\" } |$\r$\n`
  FileWrite $0 `      Remove-NetFirewallRule -ErrorAction SilentlyContinue$\r$\n`
  FileWrite $0 `    Write-Status $\"firewall rules removed$\"$\r$\n`
  FileWrite $0 `    exit 0$\r$\n`
  FileWrite $0 `  } catch {$\r$\n`
  FileWrite $0 `    Write-Status $\"firewall rule uninstall failed (fail-open): $$_$\"$\r$\n`
  FileWrite $0 `    exit 0$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `if ($$Mode -eq 'install-elevated') {$\r$\n`
  FileWrite $0 `  if (Install-FirewallRule) { exit 0 } else { exit 2 }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `if ($$Mode -eq 'ensure') {$\r$\n`
  FileWrite $0 `  if (Test-RuleExists) {$\r$\n`
  FileWrite $0 `    Write-Status $\"rules already present$\"$\r$\n`
  FileWrite $0 `    exit 0$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `  if (Test-IsAdmin) {$\r$\n`
  FileWrite $0 `    if (Install-FirewallRule -and (Test-RuleExists)) { exit 0 } else { exit 2 }$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `  Write-Status $\"rules missing and elevation required$\"$\r$\n`
  FileWrite $0 `  exit 3$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileClose $0
  sw_FIREWALL_write_done_${SW_FIREWALL_ID}:
  !undef SW_FIREWALL_ID
!macroend

!macro SPEEDWAVE_MATERIALIZE_RESET
  !define SW_RESET_ID ${__LINE__}
  InitPluginsDir
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\reset.ps1" w
  IfErrors 0 sw_RESET_write_ok_${SW_RESET_ID}
    DetailPrint "Speedwave: could not create reset.ps1 in $PLUGINSDIR — skipping."
    Goto sw_RESET_write_done_${SW_RESET_ID}
  sw_RESET_write_ok_${SW_RESET_ID}:
  FileWrite $0 `param($\r$\n`
  FileWrite $0 `  [string]$$InstDir,$\r$\n`
  FileWrite $0 `  [string]$$DataDir,$\r$\n`
  FileWrite $0 `  [string]$$DefaultInstDir,$\r$\n`
  FileWrite $0 `  [string]$$DesktopProcess = 'speedwave-desktop'$\r$\n`
  FileWrite $0 `)$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$ErrorActionPreference = 'Stop'$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$instDir = if ($$InstDir) { $$InstDir } else { $$env:SPW_INSTDIR }$\r$\n`
  FileWrite $0 `$$dataDir = if ($$DataDir) { $$DataDir } else { $$env:SPW_DATA_DIR }$\r$\n`
  FileWrite $0 `$$defaultInstDir = if ($$DefaultInstDir) { $$DefaultInstDir } else { $$env:SPW_DEFAULT_INSTDIR }$\r$\n`
  FileWrite $0 `if (-not $$instDir -or -not $$dataDir -or -not $$defaultInstDir) {$\r$\n`
  FileWrite $0 `  [Console]::Error.WriteLine('SPW_INSTDIR, SPW_DATA_DIR and SPW_DEFAULT_INSTDIR must all be set')$\r$\n`
  FileWrite $0 `  exit 2$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$separators = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)$\r$\n`
  FileWrite $0 `function Get-NormalizedPath([string]$$Path) {$\r$\n`
  FileWrite $0 `  return [System.IO.Path]::GetFullPath($$Path).TrimEnd($$separators)$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$instDir = Get-NormalizedPath $$instDir$\r$\n`
  FileWrite $0 `if (-not $$instDir.Equals((Get-NormalizedPath $$defaultInstDir), [System.StringComparison]::OrdinalIgnoreCase)) {$\r$\n`
  FileWrite $0 `  Write-Output ('skipped: ' + $$instDir + ' is not the default install dir')$\r$\n`
  FileWrite $0 `  exit 10$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `if ($$instDir.Equals((Get-NormalizedPath $$dataDir), [System.StringComparison]::OrdinalIgnoreCase)) {$\r$\n`
  FileWrite $0 `  Write-Output ('skipped: ' + $$instDir + ' is also the Speedwave data dir')$\r$\n`
  FileWrite $0 `  exit 11$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `if (Get-Process -Name $$DesktopProcess -ErrorAction SilentlyContinue) {$\r$\n`
  FileWrite $0 `  Write-Output ('skipped: ' + $$DesktopProcess + ' is still running')$\r$\n`
  FileWrite $0 `  exit 12$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$trees = @('build-context', 'mcp-os', 'oauth', 'THIRD-PARTY-LICENSES', 'host_exec')$\r$\n`
  FileWrite $0 `$$failed = 0$\r$\n`
  FileWrite $0 `foreach ($$tree in $$trees) {$\r$\n`
  FileWrite $0 `  $$path = [System.IO.Path]::Combine($$instDir, $$tree)$\r$\n`
  FileWrite $0 `  if (-not [System.IO.Directory]::Exists($$path)) { continue }$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    [System.IO.Directory]::Delete($$path, $$true)$\r$\n`
  FileWrite $0 `    Write-Output ('removed ' + $$path)$\r$\n`
  FileWrite $0 `  } catch {$\r$\n`
  FileWrite $0 `    Write-Output ('could not remove ' + $$path + ': ' + $$_.Exception.Message)$\r$\n`
  FileWrite $0 `    $$failed++$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `if ($$failed -gt 0) { exit 3 }$\r$\n`
  FileWrite $0 `exit 0$\r$\n`
  FileClose $0
  sw_RESET_write_done_${SW_RESET_ID}:
  !undef SW_RESET_ID
!macroend

!macro SPEEDWAVE_MATERIALIZE_RUN_HIDDEN
  !define SW_RUN_HIDDEN_ID ${__LINE__}
  InitPluginsDir
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\run-hidden.vbs" w
  IfErrors 0 sw_RUN_HIDDEN_write_ok_${SW_RUN_HIDDEN_ID}
    DetailPrint "Speedwave: could not create run-hidden.vbs in $PLUGINSDIR — skipping."
    Goto sw_RUN_HIDDEN_write_done_${SW_RUN_HIDDEN_ID}
  sw_RUN_HIDDEN_write_ok_${SW_RUN_HIDDEN_ID}:
  FileWrite $0 `' SSOT: hidden-window launcher for NSIS install hooks.$\r$\n`
  FileWrite $0 `' nsExec runs PowerShell with CREATE_NEW_CONSOLE + SW_HIDE, but modern conhost$\r$\n`
  FileWrite $0 `' paints its window before honoring SW_HIDE, so powershell.exe flashes a black$\r$\n`
  FileWrite $0 `' console during install. wscript.exe is a GUI-subsystem host (no console), and$\r$\n`
  FileWrite $0 `' WshShell.Run(cmd, 0, True) starts the child hidden (window style 0) and waits,$\r$\n`
  FileWrite $0 `' returning the child exit code. So the flash is gone and Pop $$0 still works.$\r$\n`
  FileWrite $0 `' Usage: wscript.exe run-hidden.vbs $\"<full command line>$\"$\r$\n`
  FileWrite $0 `' Encoding: plain ASCII, NO BOM (wscript fails to parse a UTF-8 BOM).$\r$\n`
  FileWrite $0 `Option Explicit$\r$\n`
  FileWrite $0 `Dim sh, rc$\r$\n`
  FileWrite $0 `Set sh = CreateObject($\"WScript.Shell$\")$\r$\n`
  FileWrite $0 `rc = sh.Run(WScript.Arguments(0), 0, True)$\r$\n`
  FileWrite $0 `WScript.Quit rc$\r$\n`
  FileClose $0
  sw_RUN_HIDDEN_write_done_${SW_RUN_HIDDEN_ID}:
  !undef SW_RUN_HIDDEN_ID
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro SPEEDWAVE_MATERIALIZE_SWEEP

  System::Call 'kernel32::SetEnvironmentVariable(t "SPW_INSTDIR", t "$INSTDIR")i'

  ReadEnvStr $1 "SPEEDWAVE_DATA_DIR"
  StrCmp $1 "" 0 sw_data_dir_ok
    StrCpy $1 "$PROFILE\.speedwave"
  sw_data_dir_ok:
  System::Call 'kernel32::SetEnvironmentVariable(t "SPW_DATA_DIR", t "$1")i'

  !insertmacro SPEEDWAVE_MATERIALIZE_RUN_HIDDEN
  nsExec::ExecToLog `"$SYSDIR\wscript.exe" "$PLUGINSDIR\run-hidden.vbs" "$\"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$PLUGINSDIR\sweep.ps1$\""`
  Pop $0
  ${If} $0 != 0
    DetailPrint "Speedwave PRE-INSTALL: sweep exited $0 — install may fail with 'file in use'."
    DetailPrint "Common causes: PowerShell missing, AppLocker / WDAC blocking script execution, ExecutionPolicy enforced by GPO, or a worker process the sweep could not kill."
    DetailPrint "Speedwave PRE-INSTALL: skipped the resource reset, so files a release no longer ships may remain."
  ${Else}
    !insertmacro SPEEDWAVE_MATERIALIZE_RESET
    System::Call 'kernel32::SetEnvironmentVariable(t "SPW_DEFAULT_INSTDIR", t "$LOCALAPPDATA\${PRODUCTNAME}")i'
    nsExec::ExecToLog `"$SYSDIR\wscript.exe" "$PLUGINSDIR\run-hidden.vbs" "$\"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$PLUGINSDIR\reset.ps1$\""`
    Pop $0
    ${If} $0 != 0
      DetailPrint "Speedwave PRE-INSTALL: resource reset exited $0, so files a release no longer ships may remain."
    ${EndIf}
    System::Call 'kernel32::SetEnvironmentVariable(t "SPW_DEFAULT_INSTDIR", i 0)i'
  ${EndIf}

  System::Call 'kernel32::SetEnvironmentVariable(t "SPW_INSTDIR", i 0)i'
  System::Call 'kernel32::SetEnvironmentVariable(t "SPW_DATA_DIR", i 0)i'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro SPEEDWAVE_MATERIALIZE_FIREWALL
  !insertmacro SPEEDWAVE_MATERIALIZE_RUN_HIDDEN
  nsExec::ExecToLog `"$SYSDIR\wscript.exe" "$PLUGINSDIR\run-hidden.vbs" "$\"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$PLUGINSDIR\firewall.ps1$\" -Mode install"`
  Pop $0
  ${If} $0 != 0
    DetailPrint "Speedwave POST-INSTALL: firewall rule install exited $0 (non-fatal)."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ReadEnvStr $SpeedwaveDataDirOverride "SPEEDWAVE_DATA_DIR"
  StrCmp $SpeedwaveDataDirOverride "" sw_default_prompt sw_override_prompt

  sw_default_prompt:
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Also remove Speedwave user data ($PROFILE\.speedwave) and the WSL distribution 'Speedwave'?$\r$\n$\r$\nChoose 'No' to keep your tokens, projects, and the WSL distro for a future re-install." \
      /SD IDNO IDYES sw_clean_yes IDNO sw_clean_no
    Goto sw_clean_done

  sw_override_prompt:
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Also remove the WSL distribution 'Speedwave'?$\r$\n$\r$\nNote: SPEEDWAVE_DATA_DIR is set. The uninstaller will NOT delete that directory -- please remove it manually after uninstall if desired.$\r$\n$\r$\nChoose 'No' to keep the WSL distro." \
      /SD IDNO IDYES sw_clean_yes IDNO sw_clean_no
    Goto sw_clean_done

  sw_clean_yes:
    StrCpy $SpeedwaveCleanData "1"
    Goto sw_clean_done
  sw_clean_no:
    StrCpy $SpeedwaveCleanData "0"
  sw_clean_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$LOCALAPPDATA\Speedwave\nodejs"
  RMDir "$LOCALAPPDATA\Speedwave"

  !insertmacro SPEEDWAVE_MATERIALIZE_FIREWALL
  !insertmacro SPEEDWAVE_MATERIALIZE_RUN_HIDDEN
  nsExec::ExecToLog `"$SYSDIR\wscript.exe" "$PLUGINSDIR\run-hidden.vbs" "$\"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$PLUGINSDIR\firewall.ps1$\" -Mode uninstall"`
  Pop $0
  ${If} $0 != 0
    DetailPrint "Speedwave POST-UNINSTALL: firewall rule remove exited $0 (non-fatal)."
  ${EndIf}

  StrCmp $SpeedwaveCleanData "1" 0 sw_skip_cleanup

    nsExec::Exec '"$SYSDIR\wsl.exe" -d Speedwave -- true'
    Pop $0
    ${If} $0 != 0
      DetailPrint "Speedwave: WSL distribution not registered, skipping unregister"
      Goto sw_after_wsl_unregister
    ${EndIf}

    nsExec::ExecToLog '"$SYSDIR\wsl.exe" --terminate Speedwave'
    Pop $0

    nsExec::ExecToLog '"$SYSDIR\wsl.exe" --unregister Speedwave'
    Pop $0
    ${If} $0 != 0
      DetailPrint "Speedwave WARNING: wsl --unregister Speedwave returned $0."
      DetailPrint "If a 'Speedwave' entry remains in 'wsl --list', run:"
      DetailPrint "  wsl --unregister Speedwave"
    ${EndIf}

    sw_after_wsl_unregister:

    StrCmp $SpeedwaveDataDirOverride "" 0 sw_skip_data_dir
      RMDir /r "$PROFILE\.speedwave"
      DetailPrint "Speedwave: removed user data and WSL distribution"
      Goto sw_done_cleanup
    sw_skip_data_dir:
      DetailPrint "Speedwave: removed WSL distribution; user data at $SpeedwaveDataDirOverride preserved (manual removal required)"

    sw_done_cleanup:
  sw_skip_cleanup:
!macroend
