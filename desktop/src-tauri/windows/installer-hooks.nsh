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

    ; Best-effort terminate; ignore exit code.
    ; Use $SYSDIR (System32) to prevent PATH-based binary substitution,
    ; matching the absolute-path hardening in WslRuntime::reset_vm().
    nsExec::ExecToLog '"$SYSDIR\wsl.exe" --terminate Speedwave'
    Pop $0

    ; Unregister the WSL distro. "No distribution" exit code is treated as
    ; success (idempotent). Any other non-zero exit code gets a warning so
    ; the user knows to run `wsl --unregister Speedwave` manually.
    nsExec::ExecToLog '"$SYSDIR\wsl.exe" --unregister Speedwave'
    Pop $0
    ${If} $0 != 0
      DetailPrint "Speedwave WARNING: wsl --unregister Speedwave returned $0."
      DetailPrint "If a 'Speedwave' entry remains in 'wsl --list', run:"
      DetailPrint "  wsl --unregister Speedwave"
    ${EndIf}

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
