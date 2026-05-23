//! Regression tests for `windows/installer-hooks.nsh`.
//!
//! The NSIS hooks file is consumed by Tauri at bundle time and never
//! parsed by Rust at runtime — but it is the only barrier preventing a
//! Windows upgrade from failing with "Error opening file for writing"
//! when a stale `node.exe` worker is still running (see PR description).
//! These tests pin down the security- and correctness-critical pieces
//! of the hook so a casual edit cannot silently regress them.

#[cfg(test)]
mod tests {
    const HOOKS: &str = include_str!("../windows/installer-hooks.nsh");

    #[test]
    fn has_preinstall_macro() {
        assert!(
            HOOKS.contains("!macro NSIS_HOOK_PREINSTALL"),
            "PRE-INSTALL hook is the only thing that releases node.exe \
             before the new installer overwrites it; do not remove it"
        );
    }

    #[test]
    fn passes_instdir_via_environment_variable_not_command_line() {
        // CRITICAL: `powershell.exe -Command "..."` CONCATENATES trailing
        // argv into the command text (per MSDN about_pwsh). An apostrophe
        // in $INSTDIR (e.g. C:\Users\O'Brien\…) would open an unclosed
        // string literal and cause pwsh to exit 1 silently. The hook MUST
        // pass $INSTDIR via an environment variable, never as a positional
        // argument. Verified empirically on pwsh 7.6.2.
        assert!(
            HOOKS.contains("SetEnvironmentVariable") && HOOKS.contains("SPW_INSTDIR"),
            "$INSTDIR must be passed via SetEnvironmentVariable, not on the cmd line"
        );
        assert!(
            HOOKS.contains("$$env:SPW_INSTDIR"),
            "the PS script must read $env:SPW_INSTDIR (NSIS-escaped as $$env:)"
        );
        // Negative: no positional path argv to powershell.exe in the
        // command line. Detect by looking for the old broken pattern.
        assert!(
            !HOOKS.contains("-File \"$PLUGINSDIR\\speedwave-sweep.ps1\" \""),
            "no positional path arg to the .ps1 — env var is the only channel"
        );
    }

    #[test]
    fn writes_sweep_script_to_pluginsdir() {
        // The sweep is materialized as a .ps1 in $PLUGINSDIR and invoked
        // via `-File`, NOT `-Command`. This avoids ALL the -Command
        // quoting hazards. $PLUGINSDIR is auto-cleaned by NSIS after
        // install, so the temp script does not leak.
        assert!(
            HOOKS.contains("InitPluginsDir") && HOOKS.contains("$PLUGINSDIR\\speedwave-sweep.ps1"),
            "sweep script must be materialized in $PLUGINSDIR"
        );
        assert!(
            HOOKS.contains("-File \"$PLUGINSDIR\\speedwave-sweep.ps1\""),
            "powershell.exe must be invoked with -File, not -Command, to avoid concat hazards"
        );
    }

    #[test]
    fn uses_ordinal_string_comparison_not_wildcard_like() {
        // Brackets, `?`, `*` in $INSTDIR (legal NTFS) break the `-like`
        // wildcard operator by becoming character-class metacharacters.
        // The sweep must use `String.StartsWith(..., OrdinalIgnoreCase)`
        // instead, which does literal byte comparison.
        assert!(
            HOOKS.contains("StartsWith") && HOOKS.contains("OrdinalIgnoreCase"),
            "use String.StartsWith(.., OrdinalIgnoreCase) for path matching, not -like"
        );
        // Negative: the old `-like (Join-Path ... '*')` pattern would
        // regress brackets in paths.
        assert!(
            !HOOKS.contains("-like (Join-Path"),
            "do not use -like for path matching — brackets in $INSTDIR break it"
        );
    }

    #[test]
    fn enumerates_via_cim_for_cross_session_visibility() {
        // Get-Process is scoped to the invoking user/session and misses
        // orphans owned by another user or by an elevated session when
        // the installer runs unelevated. Get-CimInstance crosses those
        // boundaries when the installer has the right privileges.
        assert!(
            HOOKS.contains("Get-CimInstance") && HOOKS.contains("Win32_Process"),
            "process enumeration must use Get-CimInstance Win32_Process, not Get-Process"
        );
    }

    #[test]
    fn polls_file_lock_does_not_use_fixed_sleep() {
        // A fixed `Sleep 500` after the kill is a race window: under
        // EDR/AV post-close scanning the file handle can stay live for
        // several seconds. The sweep must poll the actual file write
        // lock with bounded retries instead.
        assert!(
            HOOKS.contains("[System.IO.File]::Open"),
            "poll write access via [System.IO.File]::Open, not a fixed Sleep"
        );
        assert!(
            HOOKS.contains("FileShare]::None"),
            "open with FileShare::None to detect any held handle"
        );
        // The old fixed `Sleep 500` in the NSIS macro body would
        // regress this. Allow `Start-Sleep` inside the PS loop.
        assert!(
            !HOOKS.contains("  Sleep 500\n"),
            "the NSIS macro must not use a fixed Sleep — the PS loop polls"
        );
    }

    #[test]
    fn checks_sweep_exit_code_and_emits_detailprint() {
        // nsExec::Exec pushes the exit code; ignoring it makes
        // PowerShell launch failures (AppLocker, WDAC, missing PS,
        // parse error) silent. Surface them via DetailPrint.
        assert!(
            HOOKS.contains("Pop $0") && HOOKS.contains("$0 != 0") && HOOKS.contains("DetailPrint"),
            "the sweep exit code must be checked and surfaced via DetailPrint"
        );
    }

    #[test]
    fn uses_absolute_powershell_path() {
        // PATH in the installer environment is not trusted (PATH-hijack
        // vector). The hook must invoke powershell.exe via its absolute
        // System32 path. Without this assertion, a future edit could
        // regress to bare `powershell.exe` and ship a hijack vector.
        assert!(
            HOOKS.contains("$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"),
            "use absolute $SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe — \
             PATH in the installer environment is not trusted"
        );
    }

    #[test]
    fn scopes_kill_to_instdir_not_global_image_name() {
        // A global `taskkill /F /IM Speedwave.exe` would kill every
        // process named Speedwave.exe on the machine (dev builds,
        // sibling installs in other prefixes). Both Speedwave.exe
        // and node.exe sweeps must filter by ExecutablePath against
        // $INSTDIR.
        let lower = HOOKS.to_lowercase();
        assert!(
            !lower.contains("/im node.exe"),
            "global taskkill /IM node.exe is a security regression"
        );
        assert!(
            !lower.contains("/im speedwave.exe"),
            "global taskkill /IM Speedwave.exe is unscoped — filter by ExecutablePath"
        );

        // Positive: both targets must appear in the PS sweep with
        // ExecutablePath comparison.
        assert!(
            HOOKS.contains("ExecutablePath"),
            "the sweep must filter by ExecutablePath"
        );
        assert!(
            HOOKS.contains("Speedwave.exe") && HOOKS.contains("nodejs"),
            "both Speedwave.exe and the nodejs prefix must be in the sweep"
        );
    }

    #[test]
    fn sweep_avoids_join_path_with_error_action_stop() {
        // Join-Path under `$ErrorActionPreference = 'Stop'` throws a
        // terminating "Cannot find drive" error if the drive letter
        // doesn't exist (rare in prod, common when testing on macOS).
        // We use plain string concat instead — deterministic and
        // locale/PS-version independent.
        assert!(
            !HOOKS.contains("Join-Path $$instDir"),
            "do not use Join-Path on $instDir — use string concat (locale/error-action safe)"
        );
    }
}
