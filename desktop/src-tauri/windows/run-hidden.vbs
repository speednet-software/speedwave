' SSOT: hidden-window launcher for NSIS install hooks.
' nsExec runs PowerShell with CREATE_NEW_CONSOLE + SW_HIDE, but modern conhost
' paints its window before honoring SW_HIDE, so powershell.exe flashes a black
' console during install. wscript.exe is a GUI-subsystem host (no console), and
' WshShell.Run(cmd, 0, True) starts the child hidden (window style 0) and waits,
' returning the child exit code. So the flash is gone and Pop $0 still works.
' Usage: wscript.exe run-hidden.vbs "<full command line>"
' Encoding: plain ASCII, NO BOM (wscript fails to parse a UTF-8 BOM).
Option Explicit
Dim sh, rc
Set sh = CreateObject("WScript.Shell")
rc = sh.Run(WScript.Arguments(0), 0, True)
WScript.Quit rc
