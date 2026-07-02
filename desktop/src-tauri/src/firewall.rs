//! Windows firewall rules (ADR-067) — Desktop runtime fallback.
//! Ensures both firewall layers exist before any host listener binds the WSL
//! adapter IP. Runs at most once per process; fail-open, never blocks startup.

/// Outcome of one `firewall.ps1 -Mode ensure` invocation.
#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EnsureOutcome {
    /// Rule present or just created (exit 0).
    Ready,
    /// Rule missing; elevation required (exit 3).
    NeedsElevation,
    /// Caught failure or unexpected exit — fail-open, retry next launch.
    Failed,
    /// Script not found or could not run — fail-open, retry next launch.
    Skipped,
}

/// Maps a `-Mode ensure` exit code to an outcome. Pure; testable everywhere.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn classify_ensure_exit(code: Option<i32>) -> EnsureOutcome {
    match code {
        Some(0) => EnsureOutcome::Ready,
        Some(3) => EnsureOutcome::NeedsElevation,
        Some(_) => EnsureOutcome::Failed,
        None => EnsureOutcome::Skipped,
    }
}

#[cfg(target_os = "windows")]
pub(crate) use windows_impl::ensure_firewall_rule;

/// No-op on non-Windows so call sites need no extra `#[cfg]`.
#[cfg(not(target_os = "windows"))]
pub(crate) fn ensure_firewall_rule() {}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{classify_ensure_exit, EnsureOutcome};
    use crate::setup_wizard::{resolve_bundled_windows_script, system_powershell_path};
    use std::sync::Once;

    static FIREWALL_RULE_ONCE: Once = Once::new();

    /// Ensures the Hyper-V firewall rule exists. Runs at most once per process.
    /// Called as the first statement of every host-listener starter so the rule
    /// precedes any bind on the WSL adapter IP (ADR-067).
    pub(crate) fn ensure_firewall_rule() {
        FIREWALL_RULE_ONCE.call_once(ensure_firewall_rule_inner);
    }

    fn ensure_firewall_rule_inner() {
        let Some(script) = resolve_bundled_windows_script("firewall.ps1") else {
            log::warn!(
                "firewall: firewall.ps1 not found in bundle — skipping (WDF prompts may appear)"
            );
            return;
        };
        let programs = host_listener_programs();

        match run_firewall_mode(&script, "ensure", &programs) {
            EnsureOutcome::Ready => log::info!("firewall: rules present"),
            EnsureOutcome::Failed => {
                log::warn!("firewall: ensure failed (non-fatal) — will retry next launch")
            }
            EnsureOutcome::Skipped => {
                log::warn!("firewall: ensure could not run (non-fatal) — will retry next launch")
            }
            EnsureOutcome::NeedsElevation => {
                if !is_interactive_session() {
                    log::warn!(
                        "firewall: rules missing and session non-interactive — skipping elevation"
                    );
                    return;
                }
                attempt_elevated_install(&script, &programs);
            }
        }
    }

    /// Full paths of the host listeners pre-authorized at the WDF layer: the
    /// bundled node.exe and this exe, resolved relative to the running exe.
    fn host_listener_programs() -> Vec<String> {
        let mut progs = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            progs.push(exe.to_string_lossy().into_owned());
            if let Some(dir) = exe.parent() {
                let node = dir
                    .join(speedwave_runtime::consts::NODEJS_SUBDIR)
                    .join("node.exe");
                // Only authorize node.exe if it actually exists.
                if node.is_file() {
                    progs.push(node.to_string_lossy().into_owned());
                } else {
                    log::warn!(
                        "firewall: bundled node.exe not found at {} — skipping its allow rule",
                        node.display()
                    );
                }
            }
        }
        progs
    }

    /// Self-elevates `firewall.ps1 -Mode install-elevated` via UAC. Launcher
    /// exit codes: 0 = elevated child ran, 10 = UAC cancelled / refused.
    fn attempt_elevated_install(script: &std::path::Path, programs: &[String]) {
        let powershell = system_powershell_path();
        // Build the elevated child's -ArgumentList; each element PS-quoted.
        let mut args = vec![
            "'-NoProfile'".to_string(),
            "'-NonInteractive'".to_string(),
            "'-ExecutionPolicy'".to_string(),
            "'Bypass'".to_string(),
            "'-File'".to_string(),
            ps_quote(&script.to_string_lossy()),
            "'-Mode'".to_string(),
            "'install-elevated'".to_string(),
        ];
        if !programs.is_empty() {
            args.push("'-Programs'".to_string());
            // Single ';'-joined string (see run_firewall_mode), then PS-quoted.
            args.push(ps_quote(&programs.join(";")));
        }
        let inner = format!(
            "try {{ Start-Process -FilePath {ps} -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop -ArgumentList @({argv}) | Out-Null; exit 0 }} catch {{ exit 10 }}",
            ps = ps_quote(&powershell.to_string_lossy()),
            argv = args.join(","),
        );
        // system_command applies CREATE_NO_WINDOW so the launcher shows no console.
        let result = speedwave_runtime::binary::system_command(&powershell.to_string_lossy())
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"])
            .arg(&inner)
            .status();
        match result.map(|s| s.code()) {
            // Launcher ran the elevated child; verify by rule PRESENCE.
            Ok(Some(0)) => {
                if matches!(
                    run_firewall_mode(script, "ensure", programs),
                    EnsureOutcome::Ready
                ) {
                    log::info!("firewall: rules created via elevation");
                } else {
                    log::warn!(
                        "firewall: elevation ran but rules still missing — will retry next launch"
                    );
                }
            }
            // UAC cancelled / elevation refused.
            Ok(Some(10)) => {
                log::warn!("firewall: UAC declined — WDF prompts may appear until granted")
            }
            Ok(other) => {
                log::warn!("firewall: elevation launcher exited {other:?} (non-fatal) — will retry next launch")
            }
            Err(e) => log::warn!("firewall: elevation spawn failed (non-fatal): {e}"),
        }
    }

    /// Runs `firewall.ps1 -Mode <mode>` (non-elevated) with the program list and
    /// classifies the exit. `Command::args` passes paths as OS argv, so spaces
    /// need no quoting here.
    fn run_firewall_mode(
        script: &std::path::Path,
        mode: &str,
        programs: &[String],
    ) -> EnsureOutcome {
        let powershell = system_powershell_path();
        // system_command applies CREATE_NO_WINDOW (SSOT: binary.rs).
        let mut cmd = speedwave_runtime::binary::system_command(&powershell.to_string_lossy());
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .args(["-Mode", mode]);
        if !programs.is_empty() {
            // Semicolon-separated single string; -File cannot bind an array.
            cmd.arg("-Programs").arg(programs.join(";"));
        }
        match cmd.status() {
            Ok(status) => classify_ensure_exit(status.code()),
            Err(e) => {
                log::warn!("firewall: spawn failed (non-fatal): {e}");
                EnsureOutcome::Skipped
            }
        }
    }

    /// Single-quotes a string for embedding in a PowerShell command (doubles
    /// any embedded single quote). Used only for the self-elevation inner cmd.
    fn ps_quote(s: &str) -> String {
        format!("'{}'", s.replace('\'', "''"))
    }

    /// True when the process can render a UAC consent dialog, detected via the
    /// `SESSIONNAME` env var (set for interactive sessions, absent for services).
    fn is_interactive_session() -> bool {
        std::env::var_os("SESSIONNAME").is_some()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn classify_exit_zero_is_ready() {
        assert_eq!(classify_ensure_exit(Some(0)), EnsureOutcome::Ready);
    }

    #[test]
    fn classify_exit_three_is_needs_elevation() {
        assert_eq!(classify_ensure_exit(Some(3)), EnsureOutcome::NeedsElevation);
    }

    #[test]
    fn classify_other_nonzero_is_failed() {
        assert_eq!(classify_ensure_exit(Some(2)), EnsureOutcome::Failed);
        assert_eq!(classify_ensure_exit(Some(1)), EnsureOutcome::Failed);
    }

    #[test]
    fn classify_no_code_is_skipped() {
        assert_eq!(classify_ensure_exit(None), EnsureOutcome::Skipped);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn ensure_firewall_rule_is_noop_off_windows() {
        // Must not panic and must be callable without Windows APIs.
        ensure_firewall_rule();
    }
}
