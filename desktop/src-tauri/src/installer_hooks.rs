//! Regression tests pinning security/correctness invariants of
//! `windows/installer-hooks.nsh`. See ADR-048 for the full rationale.

#[cfg(test)]
mod tests {
    const HOOKS: &str = include_str!("../windows/installer-hooks.nsh");

    #[test]
    fn has_preinstall_macro() {
        assert!(
            HOOKS.contains("!macro NSIS_HOOK_PREINSTALL"),
            "PRE-INSTALL hook is the only thing that releases node.exe before overwrite"
        );
    }

    #[test]
    fn passes_instdir_via_environment_variable_not_command_line() {
        assert!(
            HOOKS.contains("SetEnvironmentVariable") && HOOKS.contains("SPW_INSTDIR"),
            "$INSTDIR must be passed via SetEnvironmentVariable, not on the cmd line \
             (apostrophe in path breaks pwsh -Command parsing — see ADR-048)"
        );
        assert!(
            HOOKS.contains("$$env:SPW_INSTDIR"),
            "the PS script must read $env:SPW_INSTDIR (NSIS-escaped as $$env:)"
        );
        assert!(
            !HOOKS.contains("-File \"$PLUGINSDIR\\speedwave-sweep.ps1\" \""),
            "no positional path arg to the .ps1 — env var is the only channel"
        );
    }

    #[test]
    fn writes_sweep_script_to_pluginsdir() {
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
        assert!(
            HOOKS.contains("StartsWith") && HOOKS.contains("OrdinalIgnoreCase"),
            "use String.StartsWith(.., OrdinalIgnoreCase) — `-like` treats brackets as wildcards"
        );
        assert!(
            !HOOKS.contains("-like (Join-Path"),
            "do not use -like for path matching — brackets in $INSTDIR break it"
        );
    }

    #[test]
    fn enumerates_via_cim_for_cross_session_visibility() {
        assert!(
            HOOKS.contains("Get-CimInstance") && HOOKS.contains("Win32_Process"),
            "process enumeration must use Get-CimInstance Win32_Process, not Get-Process \
             (Get-Process is session-scoped)"
        );
    }

    #[test]
    fn polls_file_lock_does_not_use_fixed_sleep() {
        assert!(
            HOOKS.contains("[System.IO.File]::Open"),
            "poll write access via [System.IO.File]::Open, not a fixed Sleep"
        );
        assert!(
            HOOKS.contains("FileShare]::None"),
            "open with FileShare::None to detect any held handle"
        );
        assert!(
            !HOOKS.contains("  Sleep 500\n"),
            "the NSIS macro must not use a fixed Sleep — the PS loop polls"
        );
    }

    #[test]
    fn checks_sweep_exit_code_and_emits_detailprint() {
        assert!(
            HOOKS.contains("Pop $0") && HOOKS.contains("$0 != 0") && HOOKS.contains("DetailPrint"),
            "the sweep exit code must be checked and surfaced via DetailPrint"
        );
    }

    #[test]
    fn uses_absolute_powershell_path() {
        assert!(
            HOOKS.contains("$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"),
            "use absolute $SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe — PATH not trusted"
        );
    }

    #[test]
    fn scopes_kill_to_instdir_not_global_image_name() {
        let lower = HOOKS.to_lowercase();
        assert!(
            !lower.contains("/im node.exe"),
            "global taskkill /IM node.exe is a security regression"
        );
        assert!(
            !lower.contains("/im speedwave.exe"),
            "global taskkill /IM Speedwave.exe is unscoped — filter by ExecutablePath"
        );
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
    fn clears_spw_instdir_env_var_after_sweep() {
        assert!(
            HOOKS.contains(r#"SetEnvironmentVariable(t "SPW_INSTDIR", i 0)"#),
            "SPW_INSTDIR must be cleared after sweep (SetEnvironmentVariable with NULL)"
        );
    }

    #[test]
    fn file_existence_check_uses_literal_path() {
        assert!(
            HOOKS.contains("Test-Path -LiteralPath"),
            "Test-Path must use -LiteralPath to handle brackets/wildcards in $INSTDIR"
        );
    }

    #[test]
    fn fileopen_failure_is_handled_with_iferrors() {
        assert!(
            HOOKS.contains("IfErrors"),
            "FileOpen must be guarded by IfErrors so disk-full / ACL failures \
             surface via DetailPrint instead of silently writing an empty sweep"
        );
    }

    #[test]
    fn sweep_avoids_join_path_with_error_action_stop() {
        assert!(
            !HOOKS.contains("Join-Path $$instDir"),
            "do not use Join-Path on $instDir — string concat is locale/error-action safe"
        );
    }
}
