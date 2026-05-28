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

; @@SPEEDWAVE_EMBEDDED_MACROS@@
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

  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\sweep.ps1"`
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
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\firewall.ps1" -Mode install`
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

  ; Always remove Hyper-V firewall rule — it is app config, not user data.
  !insertmacro SPEEDWAVE_MATERIALIZE_FIREWALL
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\firewall.ps1" -Mode uninstall`
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
