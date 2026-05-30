; Uninstaller cleanup for Speedwave (issue #613).
;
; The literal "Speedwave" distro name below mirrors
; crates/speedwave-runtime/src/consts.rs::WSL_DISTRO_NAME.
; See the "WSL distro name" SSOT-alignment row in CLAUDE.md
; for the full list of files to update if it changes.
;
; $SpeedwaveCleanData and $SpeedwaveDataDirOverride are top-level Vars so
; they persist between PRE/POST uninstall macros -- Tauri's NSIS template
; expands both into the same uninstaller .nsi, so ordinary global-variable
; scoping applies.
;
; Silent-install contract: `/SD IDNO` makes silent uninstalls
; (`uninstall.exe /S`) default to "preserve data".
;
; Bundled-payload cleanup ($LOCALAPPDATA\Speedwave\nodejs) runs
; unconditionally — it is app code, not user data, so the prompt
; below does not gate it.

Var SpeedwaveCleanData
Var SpeedwaveDataDirOverride

; ============================================================================
; GENERATED CONTENT BELOW — DO NOT EDIT BY HAND.
; Sources: windows/sweep.ps1, windows/firewall.ps1, windows/run-hidden.vbs
; Regenerate: make generate-installer-nsh
; ============================================================================

!macro SPEEDWAVE_MATERIALIZE_SWEEP
  !define SW_SWEEP_ID ${__LINE__}
  InitPluginsDir
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\sweep.ps1" w
  IfErrors 0 sw_SWEEP_write_ok_${SW_SWEEP_ID}
    DetailPrint "Speedwave: could not create sweep.ps1 in $PLUGINSDIR — skipping."
    Goto sw_SWEEP_write_done_${SW_SWEEP_ID}
  sw_SWEEP_write_ok_${SW_SWEEP_ID}:
  FileWrite $0 `# SSOT: process sweep for Speedwave Windows upgrades.$\r$\n`
  FileWrite $0 `# Consumed by: NSIS PREINSTALL hook, WiX CustomAction, setup_wizard::link_cli.$\r$\n`
  FileWrite $0 `# Env: SPW_INSTDIR (Tauri app dir) + SPW_DATA_DIR (speedwave data dir).$\r$\n`
  FileWrite $0 `# Args: -Mode full|runtime$\r$\n`
  FileWrite $0 `#   full    (default; install-time): kill Speedwave.exe + nodejs\*.exe + bin\speedwave.exe.$\r$\n`
  FileWrite $0 `#   runtime (Tauri Desktop pre-link): kill only bin\speedwave.exe — Tauri must NOT$\r$\n`
  FileWrite $0 `#           target its own workers or itself or the sweep deadlocks on its own locks.$\r$\n`
  FileWrite $0 `# Exits: 0 ok, 2 missing env, 3 enum failed, 4 lock timeout.$\r$\n`
  FileWrite $0 `# See ADR-048 for design constraints (string concat, OrdinalIgnoreCase, CIM).$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `param($\r$\n`
  FileWrite $0 `  [ValidateSet('full', 'runtime')]$\r$\n`
  FileWrite $0 `  [string]$$Mode = 'full'$\r$\n`
  FileWrite $0 `)$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$ErrorActionPreference = 'Stop'$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$instDir = $$env:SPW_INSTDIR$\r$\n`
  FileWrite $0 `if (-not $$instDir) { Write-Error 'SPW_INSTDIR not set'; exit 2 }$\r$\n`
  FileWrite $0 `$$dataDir = $$env:SPW_DATA_DIR$\r$\n`
  FileWrite $0 `if (-not $$dataDir) { Write-Error 'SPW_DATA_DIR not set'; exit 2 }$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$instDir = $$instDir.TrimEnd('\')$\r$\n`
  FileWrite $0 `$$dataDir = $$dataDir.TrimEnd('\')$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `# String concat per ADR-048.$\r$\n`
  FileWrite $0 `$$nodePrefix = $$instDir + '\nodejs\'$\r$\n`
  FileWrite $0 `$$desktopExe = $$instDir + '\Speedwave.exe'$\r$\n`
  FileWrite $0 `$$cliExe = $$dataDir + '\bin\speedwave.exe'$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `# Runtime mode: scope to the CLI binary only (Tauri Desktop is itself running$\r$\n`
  FileWrite $0 `# the sweep — killing its own workers / self deadlocks the lock-poll).$\r$\n`
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
  FileWrite $0 `# Poll write access. Returns when all targets unlock, or 20 s timeout.$\r$\n`
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
  FileWrite $0 `# SSOT: Windows firewall rules for Speedwave under WSL2 mirrored networking.$\r$\n`
  FileWrite $0 `# Two layers (ADR-067): (1) a Hyper-V firewall rule scoped to the WSL$\r$\n`
  FileWrite $0 `# VMCreatorId governs container<->host traffic across the WSL VM boundary;$\r$\n`
  FileWrite $0 `# (2) host Windows Defender Firewall (WDF) per-program ALLOW rules suppress the$\r$\n`
  FileWrite $0 `# $\"allow an app to access the network$\" consent prompt for the HOST listeners$\r$\n`
  FileWrite $0 `# (bundled node.exe workers + speedwave-desktop.exe) that bind the WSL adapter$\r$\n`
  FileWrite $0 `# IP. The Hyper-V rule alone does NOT stop that prompt — it is a separate$\r$\n`
  FileWrite $0 `# firewall engine; both are required.$\r$\n`
  FileWrite $0 `# Consumed by: NSIS POSTINSTALL/POSTUNINSTALL, WiX CustomAction, Desktop runtime.$\r$\n`
  FileWrite $0 `# Modes: install|uninstall (installer, never self-elevate) ; ensure|install-elevated (Desktop runtime).$\r$\n`
  FileWrite $0 `# Fail-open: log warn and exit 0 on policy/permission failure.$\r$\n`
  FileWrite $0 `# Refs: https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/hyper-v-firewall$\r$\n`
  FileWrite $0 `#       https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `param($\r$\n`
  FileWrite $0 `  [ValidateSet('install', 'uninstall', 'ensure', 'install-elevated')]$\r$\n`
  FileWrite $0 `  [string]$$Mode = 'install',$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `  # Semicolon-separated absolute paths of host listener binaries to pre-authorize$\r$\n`
  FileWrite $0 `  # at the WDF layer (node.exe, speedwave-desktop.exe). Resolved per-install by$\r$\n`
  FileWrite $0 `  # the caller (paths differ between perUser and per-machine installs). A single$\r$\n`
  FileWrite $0 `  # string (not [string[]]) because PowerShell -File cannot bind a multi-element$\r$\n`
  FileWrite $0 `  # array; ';' is a safe separator (illegal in Windows file paths). Wildcards are$\r$\n`
  FileWrite $0 `  # NOT supported by WDF application rules — must be exact paths.$\r$\n`
  FileWrite $0 `  [string]$$Programs = ''$\r$\n`
  FileWrite $0 `)$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `$$ErrorActionPreference = 'Continue'$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `# Split the semicolon-separated program list into an array, dropping blanks.$\r$\n`
  FileWrite $0 `$$ProgramList = @($$Programs -split ';' | Where-Object { $$_ -ne '' })$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `# WSL VMCreatorId is fixed by Microsoft for all WSL2 distros.$\r$\n`
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
  FileWrite $0 `# Read-only existence check; works without admin (free idempotency gate, no UAC).$\r$\n`
  FileWrite $0 `# Ready only when BOTH the Hyper-V rule and a WDF allow rule for every requested$\r$\n`
  FileWrite $0 `# program exist — so 'ensure' re-creates whatever is missing.$\r$\n`
  FileWrite $0 `function Test-RuleExists {$\r$\n`
  FileWrite $0 `  if (-not (Get-NetFirewallHyperVRule -DisplayName $$RuleName -ErrorAction SilentlyContinue)) {$\r$\n`
  FileWrite $0 `    return $$false$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `  # With no program list there are no WDF allow rules to find — report missing so$\r$\n`
  FileWrite $0 `  # the caller does not claim $\"rules present$\" off the Hyper-V rule alone.$\r$\n`
  FileWrite $0 `  if ($$ProgramList.Count -eq 0) {$\r$\n`
  FileWrite $0 `    return $$false$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `  foreach ($$prog in $$ProgramList) {$\r$\n`
  FileWrite $0 `    # Match only OUR rules (DisplayName prefix) — a foreign vendor's Allow rule$\r$\n`
  FileWrite $0 `    # for the same Program must not satisfy our idempotency check and leave us$\r$\n`
  FileWrite $0 `    # relying on a rule we do not own.$\r$\n`
  FileWrite $0 `    $$rule = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |$\r$\n`
  FileWrite $0 `      Where-Object { $$_.Program -eq $$prog } |$\r$\n`
  FileWrite $0 `      Get-NetFirewallRule -ErrorAction SilentlyContinue |$\r$\n`
  FileWrite $0 `      Where-Object { $$_.Action -eq 'Allow' -and $$_.Direction -eq 'Inbound' -and $$_.DisplayName -like $\"$$WdfRulePrefix*$\" }$\r$\n`
  FileWrite $0 `    if (-not $$rule) { return $$false }$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `  return $$true$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `# Removes any stale WDF Block rules for our binaries (left by a user who clicked$\r$\n`
  FileWrite $0 `# Anuluj/Cancel on a prior prompt). Explicit Block beats Allow, so this MUST run$\r$\n`
  FileWrite $0 `# before creating the Allow rules. Matches both the legacy patterns and the$\r$\n`
  FileWrite $0 `# exact requested program paths.$\r$\n`
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
  FileWrite $0 `# Creates a host WDF inbound ALLOW rule per program so Windows never prompts for$\r$\n`
  FileWrite $0 `# that binary. Idempotent: removes our own prior allow rule for the path first.$\r$\n`
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
  FileWrite $0 `# Privileged body (requires admin): stale-block cleanup, then the Hyper-V rule$\r$\n`
  FileWrite $0 `# (VM-boundary reachability) and the WDF allow rules (suppress host prompt).$\r$\n`
  FileWrite $0 `# Returns $$true on Hyper-V success, $$false on caught failure (fail-open).$\r$\n`
  FileWrite $0 `function Install-FirewallRule {$\r$\n`
  FileWrite $0 `  Remove-StaleBlockRules$\r$\n`
  FileWrite $0 `  Install-WdfAllowRules$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    Get-NetFirewallHyperVRule -DisplayName $$RuleName -ErrorAction SilentlyContinue |$\r$\n`
  FileWrite $0 `      Remove-NetFirewallHyperVRule -ErrorAction SilentlyContinue$\r$\n`
  FileWrite $0 `    # Splatting (no backtick line-continuation): a backtick is the NSIS$\r$\n`
  FileWrite $0 `    # FileWrite string delimiter and has no escape, so it breaks makensis.$\r$\n`
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
  FileWrite $0 `# Installer mode (NSIS/MSI): never self-elevate. Relies on the installer's own$\r$\n`
  FileWrite $0 `# elevation (MSI runs as LocalSystem; perUser NSIS may lack admin and the$\r$\n`
  FileWrite $0 `# Desktop runtime 'ensure' fallback then creates the rules). Always exit 0.$\r$\n`
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
  FileWrite $0 `# Internal mode: run the privileged body directly. NO admin check, NO relaunch$\r$\n`
  FileWrite $0 `# (prevents an infinite UAC loop). Invoked only by 'ensure' self-elevation.$\r$\n`
  FileWrite $0 `if ($$Mode -eq 'install-elevated') {$\r$\n`
  FileWrite $0 `  if (Install-FirewallRule) { exit 0 } else { exit 2 }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$\r$\n`
  FileWrite $0 `# Desktop runtime mode: existence-check first (non-admin, no UAC). If missing,$\r$\n`
  FileWrite $0 `# create directly when already admin, else signal the Rust caller (exit 3) that$\r$\n`
  FileWrite $0 `# elevation is required so it can decide whether to prompt.$\r$\n`
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
; Generator replaces the marker above with materialize macros derived from
; windows/sweep.ps1 + firewall.ps1. See scripts/generate-installer-nsh.sh.

; PRE-INSTALL: release $INSTDIR\Speedwave.exe, $INSTDIR\nodejs\*, and
; $dataDir\bin\speedwave.exe before the installer overwrites them.
; Without this, upgrades fail with "Error opening file for writing" on
; stale workers, or link_cli silently keeps a stale CLI on next launch.
; See ADR-048 §"PRE-INSTALL orphan worker sweep".
!macro NSIS_HOOK_PREINSTALL
  ; Materialize sweep.ps1 into $PLUGINSDIR (auto-cleaned by NSIS).
  !insertmacro SPEEDWAVE_MATERIALIZE_SWEEP

  ; $INSTDIR via env var (process-scoped) — see ADR-048.
  System::Call 'kernel32::SetEnvironmentVariable(t "SPW_INSTDIR", t "$INSTDIR")i'

  ; $dataDir for CLI sweep: honour SPEEDWAVE_DATA_DIR, else $PROFILE\.speedwave
  ; (DATA_DIR const in consts.rs).
  ReadEnvStr $1 "SPEEDWAVE_DATA_DIR"
  StrCmp $1 "" 0 sw_data_dir_ok
    StrCpy $1 "$PROFILE\.speedwave"
  sw_data_dir_ok:
  System::Call 'kernel32::SetEnvironmentVariable(t "SPW_DATA_DIR", t "$1")i'

  ; Run via the wscript hidden-window shim so PowerShell does not flash a black
  ; console during install (nsExec hides via SW_HIDE only, which conhost paints
  ; before honoring — see windows/run-hidden.vbs). The shim returns the child
  ; exit code, so Pop $0 is unchanged.
  !insertmacro SPEEDWAVE_MATERIALIZE_RUN_HIDDEN
  nsExec::ExecToLog `"$SYSDIR\wscript.exe" "$PLUGINSDIR\run-hidden.vbs" "$\"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$PLUGINSDIR\sweep.ps1$\""`
  Pop $0
  ${If} $0 != 0
    DetailPrint "Speedwave PRE-INSTALL: sweep exited $0 — install may fail with 'file in use'."
    DetailPrint "Common causes: PowerShell missing, AppLocker / WDAC blocking script execution, ExecutionPolicy enforced by GPO, or a worker process the sweep could not kill."
  ${EndIf}

  ; Clear env vars so they do not leak into other installer phases.
  System::Call 'kernel32::SetEnvironmentVariable(t "SPW_INSTDIR", i 0)i'
  System::Call 'kernel32::SetEnvironmentVariable(t "SPW_DATA_DIR", i 0)i'
!macroend

; POST-INSTALL: create Hyper-V firewall rule for the WSL VM so the host
; bridge (bound on the WSL adapter IP, not 127.0.0.1) is reachable from
; containers without surfacing a per-binary WDF prompt to the user.
; See CLAUDE.md SSOT row for windows/firewall.ps1.
!macro NSIS_HOOK_POSTINSTALL
  !insertmacro SPEEDWAVE_MATERIALIZE_FIREWALL
  !insertmacro SPEEDWAVE_MATERIALIZE_RUN_HIDDEN
  ; Hidden-window shim (see PRE-INSTALL): no console flash, exit code preserved.
  nsExec::ExecToLog `"$SYSDIR\wscript.exe" "$PLUGINSDIR\run-hidden.vbs" "$\"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$PLUGINSDIR\firewall.ps1$\" -Mode install"`
  Pop $0
  ${If} $0 != 0
    DetailPrint "Speedwave POST-INSTALL: firewall rule install exited $0 (non-fatal)."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; ADR-031: SPEEDWAVE_DATA_DIR redirects ~/.speedwave to a custom path.
  ; If set, we display a different prompt that names the env var explicitly
  ; and warns the user we cannot resolve the path from the uninstaller.
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
  ; Always remove bundled binaries left in $LOCALAPPDATA\Speedwave by Tauri's
  ; resource extractor (issue #613 follow-up). These are not user data — they
  ; are app payload (Node.js, helper executables) that the uninstaller would
  ; otherwise orphan. Run unconditionally, before the user-data branch.
  RMDir /r "$LOCALAPPDATA\Speedwave\nodejs"
  RMDir "$LOCALAPPDATA\Speedwave"

  ; Always remove the firewall rules — they are app config, not user data.
  !insertmacro SPEEDWAVE_MATERIALIZE_FIREWALL
  !insertmacro SPEEDWAVE_MATERIALIZE_RUN_HIDDEN
  ; Hidden-window shim (see PRE-INSTALL): no console flash, exit code preserved.
  nsExec::ExecToLog `"$SYSDIR\wscript.exe" "$PLUGINSDIR\run-hidden.vbs" "$\"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$PLUGINSDIR\firewall.ps1$\" -Mode uninstall"`
  Pop $0
  ${If} $0 != 0
    DetailPrint "Speedwave POST-UNINSTALL: firewall rule remove exited $0 (non-fatal)."
  ${EndIf}

  StrCmp $SpeedwaveCleanData "1" 0 sw_skip_cleanup

    ; Probe whether the Speedwave distro is registered. `wsl -d <name> -- true`
    ; returns 0 only if the distro exists and can be entered. If it does not
    ; exist (user installed but never completed setup), skip the terminate +
    ; unregister to avoid a misleading "WARNING: returned 1" in the install log.
    ; Use $SYSDIR (System32) to prevent PATH-based binary substitution,
    ; matching the absolute-path hardening in WslRuntime::reset_vm().
    nsExec::Exec '"$SYSDIR\wsl.exe" -d Speedwave -- true'
    Pop $0
    ${If} $0 != 0
      DetailPrint "Speedwave: WSL distribution not registered, skipping unregister"
      Goto sw_after_wsl_unregister
    ${EndIf}

    ; Best-effort terminate; ignore exit code.
    nsExec::ExecToLog '"$SYSDIR\wsl.exe" --terminate Speedwave'
    Pop $0

    ; Unregister the WSL distro. Any non-zero exit code at this point is
    ; unexpected (we just confirmed the distro exists), so warn the user.
    nsExec::ExecToLog '"$SYSDIR\wsl.exe" --unregister Speedwave'
    Pop $0
    ${If} $0 != 0
      DetailPrint "Speedwave WARNING: wsl --unregister Speedwave returned $0."
      DetailPrint "If a 'Speedwave' entry remains in 'wsl --list', run:"
      DetailPrint "  wsl --unregister Speedwave"
    ${EndIf}

    sw_after_wsl_unregister:

    ; Only delete the default data dir; leave SPEEDWAVE_DATA_DIR alone
    ; (we cannot validate or sandbox the path safely from the uninstaller).
    ; ".speedwave" must match consts::DATA_DIR — see SSOT alignment in CLAUDE.md.
    StrCmp $SpeedwaveDataDirOverride "" 0 sw_skip_data_dir
      RMDir /r "$PROFILE\.speedwave"
      DetailPrint "Speedwave: removed user data and WSL distribution"
      Goto sw_done_cleanup
    sw_skip_data_dir:
      DetailPrint "Speedwave: removed WSL distribution; user data at $SpeedwaveDataDirOverride preserved (manual removal required)"

    sw_done_cleanup:
  sw_skip_cleanup:
!macroend
