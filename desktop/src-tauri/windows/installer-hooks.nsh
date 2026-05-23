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

; PRE-INSTALL: release every $INSTDIR\Speedwave.exe + $INSTDIR\nodejs\*
; process holding a file lock before the installer tries to overwrite
; them. Without this, upgrading from an earlier version fails with
; "Error opening file for writing" when an old node.exe (mcp-os /
; host_exec / oauth worker) is still running.
;
; Design:
;   * $INSTDIR is passed to the sweep via the SPW_INSTDIR environment
;     variable, NOT as a cmd-line argument. PowerShell's -Command flag
;     concatenates trailing argv into the command text (per MSDN
;     about_pwsh: "all arguments following it are interpreted as part
;     of the command to execute"), so an apostrophe in the path
;     (C:\Users\O'Brien\…) would open an unclosed string literal and
;     cause pwsh to exit 1 silently. Env var keeps the path opaque to
;     the parser. Empirically verified on pwsh 7.6.2.
;   * The sweep itself is materialized to $PLUGINSDIR\sweep.ps1 and
;     invoked with `powershell.exe -File` — eliminates -Command
;     quoting fragility entirely. NSIS auto-deletes $PLUGINSDIR
;     after the install completes.
;   * Process enumeration uses Get-CimInstance Win32_Process (not
;     Get-Process), which crosses session and elevation boundaries
;     when the installer runs elevated. Filter is
;     `ExecutablePath.StartsWith($pattern, OrdinalIgnoreCase)` —
;     uses ordinal comparison so brackets / wildcards in the path
;     do not become character-class metacharacters (-like would).
;   * Both Speedwave.exe and node.exe sweeps are scoped to $INSTDIR;
;     unrelated processes named "Speedwave.exe" or "node.exe" outside
;     $INSTDIR are never touched.
;   * After the kill, the script polls each target file for write
;     access (1 s × 20 tries = 20 s) — covers slow AV scan / EDR
;     post-close hold. Replaces the previous fixed `Sleep 500`.
;   * Sweep exits 0 on success, non-zero on hard failure (PowerShell
;     missing, AppLocker block, parse error). NSIS checks the exit
;     code and emits DetailPrint so the install log shows the cause
;     instead of a downstream "Error opening file for writing".
!macro NSIS_HOOK_PREINSTALL
  ; Materialize the sweep script into $PLUGINSDIR (auto-cleaned by NSIS).
  InitPluginsDir
  FileOpen $0 "$PLUGINSDIR\speedwave-sweep.ps1" w
  FileWrite $0 `$$ErrorActionPreference = 'Stop'$\r$\n`
  FileWrite $0 `$$instDir = $$env:SPW_INSTDIR$\r$\n`
  FileWrite $0 `if (-not $$instDir) { Write-Error 'SPW_INSTDIR not set'; exit 2 }$\r$\n`
  ; String concat instead of Join-Path: Join-Path can throw "Cannot
  ; find drive" terminating errors under -ErrorAction Stop, and treats
  ; brackets / wildcards in $instDir as path-set metacharacters. Plain
  ; concat is exact and locale/PS-version independent.
  FileWrite $0 `$$instDir = $$instDir.TrimEnd('\')$\r$\n`
  FileWrite $0 `$$nodePrefix = $$instDir + '\nodejs\'$\r$\n`
  FileWrite $0 `$$desktopExe = $$instDir + '\Speedwave.exe'$\r$\n`
  FileWrite $0 `try {$\r$\n`
  FileWrite $0 `  $$procs = Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue$\r$\n`
  FileWrite $0 `  $$victims = $$procs | Where-Object {$\r$\n`
  FileWrite $0 `    $$_.ExecutablePath -and ($$_.ExecutablePath.StartsWith($$nodePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or $$_.ExecutablePath.Equals($$desktopExe, [System.StringComparison]::OrdinalIgnoreCase))$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `  foreach ($$v in $$victims) {$\r$\n`
  FileWrite $0 `    Write-Output ('killing PID ' + $$v.ProcessId + ' ' + $$v.ExecutablePath)$\r$\n`
  FileWrite $0 `    Stop-Process -Id $$v.ProcessId -Force -ErrorAction SilentlyContinue$\r$\n`
  FileWrite $0 `  }$\r$\n`
  FileWrite $0 `} catch {$\r$\n`
  FileWrite $0 `  Write-Error ('sweep enumeration failed: ' + $$_)$\r$\n`
  FileWrite $0 `  exit 3$\r$\n`
  FileWrite $0 `}$\r$\n`
  ; Poll file write access on the two binaries the installer is about
  ; to overwrite. Returns when both unlock or after 20 s timeout.
  FileWrite $0 `$$targets = @($$desktopExe, $$nodePrefix + 'node.exe')$\r$\n`
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

  ; Pass $INSTDIR to the script via env var — avoids cmd-line parsing
  ; hazards (apostrophes, brackets) entirely. SetEnvironmentVariable
  ; is process-scoped, so this only affects the installer + its
  ; powershell.exe child.
  System::Call 'kernel32::SetEnvironmentVariable(t "SPW_INSTDIR", t "$INSTDIR")i'

  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\speedwave-sweep.ps1"`
  Pop $0
  ${If} $0 != 0
    DetailPrint "Speedwave PRE-INSTALL: sweep exited $0 — install may fail with 'file in use'."
    DetailPrint "Common causes: PowerShell missing, AppLocker / WDAC blocking script execution, ExecutionPolicy enforced by GPO, or a worker process the sweep could not kill."
  ${EndIf}

  ; Clear the env var so it does not leak into other installer phases.
  System::Call 'kernel32::SetEnvironmentVariable(t "SPW_INSTDIR", i 0)i'
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
