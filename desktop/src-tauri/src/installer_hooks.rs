//! Regression tests for `windows/installer-hooks.nsh` and its inputs
//! (`installer-hooks-template.nsh`, `sweep.ps1`, `firewall.ps1`). See ADR-048.

#[cfg(test)]
mod tests {
    const HOOKS: &str = include_str!("../windows/installer-hooks.nsh");
    const TEMPLATE: &str = include_str!("../windows/installer-hooks-template.nsh");
    const SWEEP_PS1: &str = include_str!("../windows/sweep.ps1");
    const FIREWALL_PS1: &str = include_str!("../windows/firewall.ps1");
    const SWEEP_WXS: &str = include_str!("../windows/sweep.wxs");
    const FIREWALL_WXS: &str = include_str!("../windows/firewall.wxs");
    const RUN_HIDDEN_VBS: &str = include_str!("../windows/run-hidden.vbs");

    // ── Hook shape ──────────────────────────────────────────────────────

    #[test]
    fn has_all_required_hook_macros() {
        for macro_name in [
            "NSIS_HOOK_PREINSTALL",
            "NSIS_HOOK_POSTINSTALL",
            "NSIS_HOOK_PREUNINSTALL",
            "NSIS_HOOK_POSTUNINSTALL",
        ] {
            assert!(
                HOOKS.contains(&format!("!macro {macro_name}")),
                "installer-hooks.nsh missing !macro {macro_name}"
            );
        }
    }

    #[test]
    fn preinstall_materializes_sweep_and_invokes_powershell() {
        let pre = section(HOOKS, "NSIS_HOOK_PREINSTALL");
        assert!(
            pre.contains("!insertmacro SPEEDWAVE_MATERIALIZE_SWEEP"),
            "PREINSTALL must !insertmacro SPEEDWAVE_MATERIALIZE_SWEEP"
        );
        assert!(
            pre.contains(r#"$\"$PLUGINSDIR\sweep.ps1$\""#),
            "PREINSTALL must run the materialized $PLUGINSDIR\\sweep.ps1 (via the shim)"
        );
        assert!(
            pre.contains("$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"),
            "PREINSTALL must use the absolute powershell path to defeat PATH hijack"
        );
        assert!(
            pre.contains(r#""$SYSDIR\wscript.exe" "$PLUGINSDIR\run-hidden.vbs""#),
            "PREINSTALL must run PowerShell via the wscript hidden-window shim"
        );
        for env_name in ["SPW_INSTDIR", "SPW_DATA_DIR"] {
            assert!(
                pre.contains(&format!(r#"SetEnvironmentVariable(t "{env_name}", t"#)),
                "PREINSTALL must pass {env_name} via SetEnvironmentVariable"
            );
            assert!(
                pre.contains(&format!(r#"SetEnvironmentVariable(t "{env_name}", i 0)"#)),
                "PREINSTALL must clear {env_name} after the sweep"
            );
        }
        assert!(
            pre.contains(r#"StrCpy $1 "$PROFILE\.speedwave""#),
            "PREINSTALL must fall back to $PROFILE\\.speedwave for SPW_DATA_DIR"
        );
    }

    #[test]
    fn postinstall_installs_firewall_rule() {
        let post = section(HOOKS, "NSIS_HOOK_POSTINSTALL");
        assert!(
            post.contains("!insertmacro SPEEDWAVE_MATERIALIZE_FIREWALL"),
            "POSTINSTALL must materialize firewall.ps1"
        );
        assert!(
            post.contains(r#"$\"$PLUGINSDIR\firewall.ps1$\" -Mode install"#),
            "POSTINSTALL must invoke firewall.ps1 -Mode install (via the shim)"
        );
    }

    #[test]
    fn postuninstall_removes_firewall_rule_before_wsl_unregister() {
        let post = section(HOOKS, "NSIS_HOOK_POSTUNINSTALL");
        let firewall_idx = post
            .find("firewall.ps1$\\\" -Mode uninstall")
            .expect("POSTUNINSTALL must remove firewall rule");
        let wsl_idx = post
            .find("wsl.exe\" --unregister")
            .expect("POSTUNINSTALL must wsl --unregister");
        assert!(
            firewall_idx < wsl_idx,
            "firewall rule removal must precede wsl --unregister"
        );
    }

    // ── Drift detection: generator output stays in sync with .ps1 sources ──

    #[test]
    fn installer_hooks_nsh_matches_template_plus_generated_macros() {
        let expected = render_expected_hooks(TEMPLATE, SWEEP_PS1, FIREWALL_PS1, RUN_HIDDEN_VBS);
        assert_eq!(
            HOOKS, expected,
            "installer-hooks.nsh is out of sync with its inputs — run `make generate-installer-nsh` and commit"
        );
    }

    #[test]
    fn run_hidden_vbs_has_no_bom() {
        // wscript.exe fails to parse a .vbs with a UTF-8 BOM.
        assert!(
            !RUN_HIDDEN_VBS.starts_with('\u{feff}'),
            "run-hidden.vbs must be ANSI/BOM-free (wscript chokes on a BOM)"
        );
    }

    #[test]
    fn install_hooks_run_powershell_via_hidden_shim() {
        // All three PowerShell-invoking hooks go through the wscript shim.
        let shim_calls = HOOKS
            .matches("wscript.exe\" \"$PLUGINSDIR\\run-hidden.vbs")
            .count();
        assert_eq!(
            shim_calls, 3,
            "expected 3 hooks invoking PowerShell via the wscript shim, found {shim_calls}"
        );
        assert_eq!(
            HOOKS
                .matches("!insertmacro SPEEDWAVE_MATERIALIZE_RUN_HIDDEN")
                .count(),
            3,
            "each shim hook must materialize run-hidden.vbs first"
        );
        // No hook may launch powershell.exe directly via nsExec.
        assert!(
            !HOOKS.contains("nsExec::ExecToLog `\"$SYSDIR\\WindowsPowerShell"),
            "no hook may call powershell.exe directly via nsExec — must use the wscript shim"
        );
    }

    #[test]
    fn template_contains_embed_marker() {
        assert!(
            TEMPLATE.contains("@@SPEEDWAVE_EMBEDDED_MACROS@@"),
            "template must contain the @@SPEEDWAVE_EMBEDDED_MACROS@@ marker for the generator"
        );
    }

    // ── PowerShell scripts: contract surface ─────────────────────────────

    #[test]
    fn sweep_ps1_reads_required_env_vars() {
        for env in ["$env:SPW_INSTDIR", "$env:SPW_DATA_DIR"] {
            assert!(SWEEP_PS1.contains(env), "sweep.ps1 must consume {env}");
        }
    }

    #[test]
    fn sweep_ps1_kills_all_three_target_categories() {
        // Speedwave.exe (Tauri) + nodejs/* (host workers) + bin/speedwave.exe (CLI).
        assert!(
            SWEEP_PS1.contains(r"\Speedwave.exe"),
            "sweep.ps1 must target Speedwave.exe"
        );
        assert!(
            SWEEP_PS1.contains(r"\nodejs\"),
            "sweep.ps1 must target $instDir\\nodejs\\ workers"
        );
        assert!(
            SWEEP_PS1.contains(r"\bin\speedwave.exe"),
            "sweep.ps1 must target $dataDir\\bin\\speedwave.exe (CLI)"
        );
    }

    #[test]
    fn sweep_ps1_uses_ordinal_comparison_not_wildcard() {
        assert!(
            SWEEP_PS1.contains("OrdinalIgnoreCase"),
            "sweep.ps1 must compare with OrdinalIgnoreCase (brackets in paths break -like)"
        );
    }

    #[test]
    fn sweep_ps1_enumerates_via_cim() {
        assert!(
            SWEEP_PS1.contains("Get-CimInstance") && SWEEP_PS1.contains("Win32_Process"),
            "sweep.ps1 must enumerate processes via Get-CimInstance Win32_Process (cross-session)"
        );
    }

    #[test]
    fn sweep_ps1_polls_file_lock_via_fileshare_none() {
        assert!(
            SWEEP_PS1.contains("[System.IO.File]::Open") && SWEEP_PS1.contains("FileShare]::None"),
            "sweep.ps1 must probe write lock via System.IO.File::Open with FileShare::None"
        );
    }

    #[test]
    fn firewall_ps1_uses_wsl_vmcreator_id() {
        assert!(
            FIREWALL_PS1.contains("{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}"),
            "firewall.ps1 must scope the rule to the WSL VMCreatorId"
        );
        assert!(
            FIREWALL_PS1.contains("New-NetFirewallHyperVRule"),
            "firewall.ps1 must call New-NetFirewallHyperVRule (Hyper-V layer, not WDF)"
        );
    }

    #[test]
    fn firewall_ps1_cleans_stale_wdf_block_rules() {
        assert!(
            FIREWALL_PS1.contains("Action Block")
                && FIREWALL_PS1.contains("Remove-NetFirewallRule"),
            "firewall.ps1 install must remove stale WDF Block rules for our binaries"
        );
    }

    #[test]
    fn firewall_ps1_creates_wdf_allow_rules() {
        // Host application ALLOW rules (New-NetFirewallRule -Program), separate from the Hyper-V rule.
        assert!(
            FIREWALL_PS1.contains("New-NetFirewallRule")
                && FIREWALL_PS1.contains("Action      = 'Allow'")
                && FIREWALL_PS1.contains("Program     = $prog"),
            "firewall.ps1 must create host WDF -Program allow rules to suppress the prompt"
        );
    }

    #[test]
    fn firewall_ps1_accepts_programs_param_split_on_semicolon() {
        // Paths arrive as one ';'-joined [string] (PowerShell -File cannot bind a [string[]]).
        assert!(
            FIREWALL_PS1.contains("[string]$Programs")
                && FIREWALL_PS1.contains("$Programs -split ';'"),
            "firewall.ps1 must accept a single ';'-separated -Programs string and split it"
        );
    }

    #[test]
    fn firewall_ps1_uninstall_removes_wdf_allow_rules() {
        let idx = FIREWALL_PS1
            .find("$Mode -eq 'uninstall'")
            .expect("uninstall branch must exist");
        let branch = &FIREWALL_PS1[idx..];
        assert!(
            branch.contains("$WdfRulePrefix") && branch.contains("Remove-NetFirewallRule"),
            "uninstall must remove the WDF allow rules ($WdfRulePrefix) it created"
        );
    }

    #[test]
    fn firewall_ps1_installer_modes_fail_open() {
        // Installer-invoked modes (install/uninstall) fail open via several exit-0 paths.
        let exits = FIREWALL_PS1.matches("exit 0").count();
        assert!(
            exits >= 4,
            "firewall.ps1 must exit 0 on success AND catch branches (fail-open); found {exits}"
        );
    }

    #[test]
    fn firewall_ps1_supports_all_modes() {
        assert!(
            FIREWALL_PS1.contains("'install', 'uninstall', 'ensure', 'install-elevated'"),
            "firewall.ps1 must validate Mode against install|uninstall|ensure|install-elevated"
        );
    }

    #[test]
    fn firewall_ps1_ensure_checks_existence_before_signalling_elevation() {
        // 'ensure' does the non-admin existence check and exits 3 only when the rule is missing.
        let ensure_idx = FIREWALL_PS1
            .find("$Mode -eq 'ensure'")
            .expect("ensure branch must exist");
        let ensure_branch = &FIREWALL_PS1[ensure_idx..];
        let check_pos = ensure_branch
            .find("Test-RuleExists")
            .expect("ensure must call Test-RuleExists");
        let exit3_pos = ensure_branch
            .find("exit 3")
            .expect("ensure must exit 3 when elevation required");
        assert!(
            check_pos < exit3_pos,
            "ensure must check rule existence BEFORE signalling needs-elevation"
        );
    }

    #[test]
    fn firewall_ps1_elevated_mode_does_not_self_relaunch() {
        // install-elevated runs the privileged body directly; self-elevation is Rust-driven.
        assert!(
            !FIREWALL_PS1.contains("-Verb RunAs") && !FIREWALL_PS1.contains("RunAs"),
            "firewall.ps1 must not self-elevate; elevation is driven from Rust"
        );
    }

    #[test]
    fn installers_invoke_only_install_and_uninstall_modes() {
        // Runtime-only modes (ensure, install-elevated) are Desktop-only; assert on the
        // invocation pattern, not presence (the strings appear in the materialized ValidateSet).
        for needle in [
            "firewall.ps1\" -Mode ensure",
            "firewall.ps1\" -Mode install-elevated",
            "firewall.ps1&quot; -Mode ensure",
            "firewall.ps1&quot; -Mode install-elevated",
        ] {
            assert!(
                !HOOKS.contains(needle),
                "installer-hooks.nsh must not invoke runtime-only mode: {needle}"
            );
            assert!(
                !FIREWALL_WXS.contains(needle),
                "firewall.wxs must not invoke runtime-only mode: {needle}"
            );
        }
    }

    #[test]
    fn materialized_ps1_scripts_contain_no_backtick() {
        // Backtick is the NSIS FileWrite delimiter with no escape; it truncates the string.
        for (name, ps1) in [("sweep.ps1", SWEEP_PS1), ("firewall.ps1", FIREWALL_PS1)] {
            assert!(
                !ps1.contains('`'),
                "{name} contains a backtick — breaks NSIS FileWrite (use splatting)"
            );
        }
    }

    // ── WiX fragments: MSI parity ────────────────────────────────────────

    #[test]
    fn sweep_wxs_runs_after_install_files_and_calls_powershell() {
        assert!(
            SWEEP_WXS.contains("After=\"InstallFiles\""),
            "sweep.wxs must sequence the CA after InstallFiles (resources extracted)"
        );
        assert!(
            SWEEP_WXS.contains("WindowsPowerShell\\v1.0\\powershell.exe"),
            "sweep.wxs must invoke the absolute powershell.exe path"
        );
        assert!(
            SWEEP_WXS.contains("sweep.ps1"),
            "sweep.wxs must reference sweep.ps1"
        );
        assert!(
            SWEEP_WXS.contains("CAQuietExec64"),
            "sweep.wxs must use CAQuietExec64 (WixCA helper) so no cmd window flashes"
        );
        assert!(
            SWEEP_WXS.contains(r#"Execute="deferred""#)
                && SWEEP_WXS.contains(r#"Impersonate="no""#),
            "sweep.wxs must run deferred + non-impersonated (System context)"
        );
    }

    #[test]
    fn firewall_wxs_install_and_uninstall_both_sequenced() {
        assert!(
            FIREWALL_WXS.contains("-Mode install") && FIREWALL_WXS.contains("-Mode uninstall"),
            "firewall.wxs must cover both install and uninstall modes"
        );
        assert!(
            FIREWALL_WXS.contains("After=\"InstallFiles\""),
            "firewall.wxs install must run after InstallFiles"
        );
        assert!(
            FIREWALL_WXS.contains("Before=\"RemoveFiles\""),
            "firewall.wxs uninstall must run before RemoveFiles (firewall.ps1 still on disk)"
        );
        assert!(
            FIREWALL_WXS.contains(r#"REMOVE="ALL""#),
            "firewall.wxs uninstall must be conditioned on REMOVE=ALL"
        );
    }

    // ── Negative invariants from the pre-refactor era ────────────────────

    #[test]
    fn no_global_image_name_kill() {
        let lower = HOOKS.to_lowercase();
        assert!(
            !lower.contains("/im node.exe"),
            "global taskkill /IM node.exe is a security regression"
        );
        assert!(
            !lower.contains("/im speedwave.exe"),
            "global taskkill /IM Speedwave.exe is unscoped"
        );
    }

    #[test]
    fn sweep_ps1_uses_string_concat_not_join_path() {
        assert!(
            !SWEEP_PS1.contains("Join-Path $instDir"),
            "sweep.ps1 must use string concat, not Join-Path (ADR-048)"
        );
    }

    // ── helpers ─────────────────────────────────────────────────────────

    /// Returns the body of a `!macro NAME ... !macroend` block.
    fn section<'a>(src: &'a str, name: &str) -> &'a str {
        let start = src
            .find(&format!("!macro {name}"))
            .unwrap_or_else(|| panic!("missing !macro {name}"));
        let after = &src[start..];
        let end = after
            .find("!macroend")
            .unwrap_or_else(|| panic!("unterminated !macro {name}"));
        &after[..end]
    }

    /// Re-derives the expected `installer-hooks.nsh` from the template +
    /// the two `.ps1` sources, mirroring `scripts/generate-installer-nsh.sh`.
    /// Drift between the committed file and this derivation fails the test.
    fn render_expected_hooks(
        template: &str,
        sweep_ps1: &str,
        firewall_ps1: &str,
        run_hidden_vbs: &str,
    ) -> String {
        let mut embed = String::new();
        embed.push_str(
            "; ============================================================================\n",
        );
        embed.push_str("; GENERATED CONTENT BELOW — DO NOT EDIT BY HAND.\n");
        embed.push_str(
            "; Sources: windows/sweep.ps1, windows/firewall.ps1, windows/run-hidden.vbs\n",
        );
        embed.push_str("; Regenerate: make generate-installer-nsh\n");
        embed.push_str(
            "; ============================================================================\n\n",
        );
        embed.push_str(&emit_materialize_macro("sweep", "ps1", sweep_ps1));
        embed.push('\n');
        embed.push_str(&emit_materialize_macro("firewall", "ps1", firewall_ps1));
        embed.push('\n');
        embed.push_str(&emit_materialize_macro("run-hidden", "vbs", run_hidden_vbs));

        let mut out = String::new();
        for line in template.lines() {
            if line.contains("@@SPEEDWAVE_EMBEDDED_MACROS@@") {
                out.push_str(&embed);
            } else {
                out.push_str(line);
                out.push('\n');
            }
        }
        out
    }

    fn emit_materialize_macro(name: &str, ext: &str, src: &str) -> String {
        // NSIS !define/label tokens cannot contain '-'; normalize to UPPER with '-' -> '_'.
        let upper = name.to_uppercase().replace('-', "_");
        let file = format!("{name}.{ext}");
        let id = format!("SW_{upper}_ID");
        let mut s = String::new();
        s.push_str(&format!("!macro SPEEDWAVE_MATERIALIZE_{upper}\n"));
        s.push_str(&format!("  !define {id} ${{__LINE__}}\n"));
        s.push_str("  InitPluginsDir\n");
        s.push_str("  ClearErrors\n");
        s.push_str(&format!("  FileOpen $0 \"$PLUGINSDIR\\{file}\" w\n"));
        s.push_str(&format!("  IfErrors 0 sw_{upper}_write_ok_${{{id}}}\n"));
        s.push_str(&format!(
            "    DetailPrint \"Speedwave: could not create {file} in $PLUGINSDIR — skipping.\"\n"
        ));
        s.push_str(&format!("    Goto sw_{upper}_write_done_${{{id}}}\n"));
        s.push_str(&format!("  sw_{upper}_write_ok_${{{id}}}:\n"));

        let stripped = src.strip_prefix('\u{feff}').unwrap_or(src);
        for line in stripped.split_inclusive('\n') {
            let line = line.strip_suffix('\n').unwrap_or(line);
            let mut esc = String::new();
            for c in line.chars() {
                match c {
                    '$' => esc.push_str("$$"),
                    // Backtick has no NSIS escape; the generator rejects sources containing one.
                    '"' => esc.push_str("$\\\""),
                    other => esc.push(other),
                }
            }
            s.push_str("  FileWrite $0 `");
            s.push_str(&esc);
            s.push_str("$\\r$\\n`\n");
        }

        s.push_str("  FileClose $0\n");
        s.push_str(&format!("  sw_{upper}_write_done_${{{id}}}:\n"));
        s.push_str(&format!("  !undef {id}\n"));
        s.push_str("!macroend\n");
        s
    }
}
