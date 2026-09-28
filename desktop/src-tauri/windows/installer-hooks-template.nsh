Var SpeedwaveCleanData
Var SpeedwaveDataDirOverride

; @@SPEEDWAVE_EMBEDDED_MACROS@@

!macro SPEEDWAVE_RUN_HIDDEN COMMAND_LINE
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $3 `${COMMAND_LINE}`
  System::Call '*(&l4, p, p, p, i, i, i, i, i, i, i, i, &i2, &i2, p, p, p, p) p .r1'
  System::Call '*(p, p, i, i) p .r2'
  System::Call 'kernel32::CreateProcessW(p 0, w r3, p 0, p 0, i 0, i 0x08000000, p 0, p 0, p r1, p r2) i .r0'
  ${If} $0 = 0
    StrCpy $0 "error"
  ${Else}
    System::Call '*$2(p .r3, p .r4)'
    System::Call 'kernel32::WaitForSingleObject(p r3, i -1)'
    System::Call 'kernel32::GetExitCodeProcess(p r3, *i .r0)'
    System::Call 'kernel32::CloseHandle(p r3)'
    System::Call 'kernel32::CloseHandle(p r4)'
  ${EndIf}
  System::Free $2
  System::Free $1
  Pop $4
  Pop $3
  Pop $2
  Pop $1
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro SPEEDWAVE_MATERIALIZE_SWEEP

  System::Call 'kernel32::SetEnvironmentVariable(t "SPW_INSTDIR", t "$INSTDIR")i'

  ReadEnvStr $1 "SPEEDWAVE_DATA_DIR"
  StrCmp $1 "" 0 sw_data_dir_ok
    StrCpy $1 "$PROFILE\.speedwave"
  sw_data_dir_ok:
  System::Call 'kernel32::SetEnvironmentVariable(t "SPW_DATA_DIR", t "$1")i'

  !insertmacro SPEEDWAVE_RUN_HIDDEN `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\sweep.ps1"`
  ${If} $0 != 0
    DetailPrint "Speedwave PRE-INSTALL: sweep exited $0 — install may fail with 'file in use'."
    DetailPrint "Common causes: PowerShell missing, AppLocker / WDAC blocking script execution, ExecutionPolicy enforced by GPO, or a worker process the sweep could not kill."
    DetailPrint "Speedwave PRE-INSTALL: skipped the resource reset, so files a release no longer ships may remain."
  ${Else}
    !insertmacro SPEEDWAVE_MATERIALIZE_RESET
    System::Call 'kernel32::SetEnvironmentVariable(t "SPW_DEFAULT_INSTDIR", t "$LOCALAPPDATA\${PRODUCTNAME}")i'
    !insertmacro SPEEDWAVE_RUN_HIDDEN `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\reset.ps1"`
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
  !insertmacro SPEEDWAVE_RUN_HIDDEN `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\firewall.ps1" -Mode install`
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
  !insertmacro SPEEDWAVE_RUN_HIDDEN `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\firewall.ps1" -Mode uninstall`
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
