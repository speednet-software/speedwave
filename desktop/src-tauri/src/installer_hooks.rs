#[cfg(test)]
mod tests {
    const HOOKS: &str = include_str!("../windows/installer-hooks.nsh");
    const TEMPLATE: &str = include_str!("../windows/installer-hooks-template.nsh");
    const SWEEP_PS1: &str = include_str!("../windows/sweep.ps1");
    const FIREWALL_PS1: &str = include_str!("../windows/firewall.ps1");
    const SWEEP_WXS: &str = include_str!("../windows/sweep.wxs");
    const FIREWALL_WXS: &str = include_str!("../windows/firewall.wxs");
    const RUN_HIDDEN_VBS: &str = include_str!("../windows/run-hidden.vbs");
    const RESET_PS1: &str = include_str!("../windows/reset.ps1");
    const TAURI_CONF: &str = include_str!("../tauri.conf.json");
    const TAURI_WINDOWS_CONF: &str = include_str!("../tauri.windows.conf.json");
    const RETIRED_DIRECTORY_RESOURCE_ROOTS: [&str; 1] = ["host_exec"];
    const INSTALLER_PS1_SOURCES: [(&str, &str); 3] = [
        ("sweep.ps1", SWEEP_PS1),
        ("firewall.ps1", FIREWALL_PS1),
        ("reset.ps1", RESET_PS1),
    ];

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
    fn reset_ps1_clears_every_current_and_retired_directory_resource() {
        let mut expected = windows_directory_resource_roots();
        assert!(
            expected.contains("build-context"),
            "tauri.windows.conf.json must bundle build-context/ as a directory resource: {expected:?}"
        );
        expected.extend(RETIRED_DIRECTORY_RESOURCE_ROOTS.map(str::to_owned));
        assert_eq!(
            reset_trees(),
            expected,
            "reset.ps1 must clear every directory resource the installer lays down and every retired one: \
             an /UPDATE or silent install never runs the previous uninstaller, so files a release drops stay behind"
        );
    }

    #[test]
    fn reset_trees_cover_every_bundled_directory_asset() {
        let trees = reset_trees();
        let assets = speedwave_runtime::bundle::required_bundled_assets("windows")
            .expect("the Windows bundled assets must resolve");
        for asset in assets.iter().filter(|a| {
            matches!(
                a.kind,
                speedwave_runtime::bundle::BundledAssetKind::Directory
            )
        }) {
            let root = asset.path.split('/').next().unwrap_or_default();
            assert!(
                trees.contains(root),
                "reset.ps1 must clear {root}, the tree holding the bundled directory {}",
                asset.path
            );
        }
    }

    #[test]
    fn reset_ps1_deletes_through_dotnet_without_following_links() {
        assert!(
            RESET_PS1.contains("[System.IO.Directory]::Delete($path, $true)"),
            "reset.ps1 must delete with Directory.Delete, which does not recurse through reparse points"
        );
        let lower = RESET_PS1.to_lowercase();
        for follower in ["remove-item", "rmdir", "rd /s", "get-childitem"] {
            assert!(
                !lower.contains(follower),
                "reset.ps1 must not delete or walk trees with {follower}, which can follow junctions"
            );
        }
    }

    #[test]
    fn reset_ps1_resets_only_the_default_install_dir_while_the_desktop_is_stopped() {
        for input in [
            "$env:SPW_INSTDIR",
            "$env:SPW_DATA_DIR",
            "$env:SPW_DEFAULT_INSTDIR",
        ] {
            assert!(RESET_PS1.contains(input), "reset.ps1 must read {input}");
        }
        assert!(
            RESET_PS1.contains("OrdinalIgnoreCase"),
            "reset.ps1 must compare NTFS paths case-insensitively"
        );
        let stem = desktop_exe_stem();
        assert!(
            RESET_PS1.contains(&format!("[string]$DesktopProcess = '{stem}'"))
                && RESET_PS1.contains("Get-Process -Name $DesktopProcess"),
            "reset.ps1 must skip while any {stem} runs: Tauri's own name-based check could still abort the install"
        );
    }

    #[test]
    fn preinstall_runs_the_reset_only_after_a_successful_sweep() {
        let pre = section(HOOKS, "NSIS_HOOK_PREINSTALL");
        let sweep = pre
            .find(r#"$\"$PLUGINSDIR\sweep.ps1$\""#)
            .expect("PREINSTALL must run the sweep");
        let failed = sweep
            + pre[sweep..]
                .find("${If} $0 != 0")
                .expect("PREINSTALL must check the sweep exit code");
        let succeeded = failed
            + pre[failed..]
                .find("${Else}")
                .expect("PREINSTALL must branch on a successful sweep");
        let default_dir = pre
            .find(r#"SetEnvironmentVariable(t "SPW_DEFAULT_INSTDIR", t "$LOCALAPPDATA\${PRODUCTNAME}")"#)
            .expect("PREINSTALL must pass Tauri's default per-user install dir to reset.ps1");
        let reset = pre
            .find(r#"$\"$PLUGINSDIR\reset.ps1$\""#)
            .expect("PREINSTALL must run the materialized $PLUGINSDIR\\reset.ps1 (via the shim)");
        assert!(
            pre.contains("!insertmacro SPEEDWAVE_MATERIALIZE_RESET"),
            "PREINSTALL must materialize reset.ps1"
        );
        assert!(
            succeeded < default_dir && default_dir < reset,
            "reset.ps1 must run only in the successful-sweep branch, after its inputs are set"
        );
        assert!(
            pre.contains(r#"SetEnvironmentVariable(t "SPW_DEFAULT_INSTDIR", i 0)"#),
            "PREINSTALL must clear SPW_DEFAULT_INSTDIR after the reset"
        );
        assert!(
            !pre.to_lowercase().contains("rmdir"),
            "PREINSTALL must leave deletion to reset.ps1: NSIS RMDir /r recurses through junctions"
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

    #[test]
    fn installer_hooks_nsh_matches_template_plus_generated_macros() {
        let expected = render_expected_hooks(
            TEMPLATE,
            &[
                ("sweep", "ps1", SWEEP_PS1),
                ("firewall", "ps1", FIREWALL_PS1),
                ("reset", "ps1", RESET_PS1),
                ("run-hidden", "vbs", RUN_HIDDEN_VBS),
            ],
        );
        assert_eq!(
            HOOKS, expected,
            "installer-hooks.nsh is out of sync with its inputs — run `make generate-installer-nsh` and commit"
        );
    }

    #[test]
    fn run_hidden_vbs_has_no_bom() {
        assert!(
            !RUN_HIDDEN_VBS.starts_with('\u{feff}'),
            "run-hidden.vbs must be ANSI/BOM-free (wscript chokes on a BOM)"
        );
    }

    #[test]
    fn ps1_sources_have_utf8_bom() {
        for (name, ps1) in INSTALLER_PS1_SOURCES {
            assert!(
                ps1.starts_with('\u{feff}'),
                "{name} must be UTF-8 with BOM (PowerShell 5.1 misreads a BOM-less .ps1)"
            );
            assert!(
                !ps1.starts_with("\u{feff}\u{feff}"),
                "{name} has a doubled BOM; the generator strips only one"
            );
        }
    }

    #[test]
    fn installer_hooks_nsh_embeds_no_bom() {
        assert!(
            !HOOKS.contains('\u{feff}'),
            "installer-hooks.nsh must not embed a BOM (generate-installer-nsh.sh strips it)"
        );
    }

    #[test]
    fn install_hooks_run_powershell_via_hidden_shim() {
        let shim_calls = HOOKS
            .matches("wscript.exe\" \"$PLUGINSDIR\\run-hidden.vbs")
            .count();
        assert_eq!(
            shim_calls, 4,
            "expected 4 PowerShell runs via the wscript shim (sweep, reset, 2x firewall), found {shim_calls}"
        );
        assert_eq!(
            HOOKS
                .matches("!insertmacro SPEEDWAVE_MATERIALIZE_RUN_HIDDEN")
                .count(),
            3,
            "each shim hook must materialize run-hidden.vbs first"
        );
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

    #[test]
    fn sweep_ps1_reads_required_env_vars() {
        for env in ["$env:SPW_INSTDIR", "$env:SPW_DATA_DIR"] {
            assert!(SWEEP_PS1.contains(env), "sweep.ps1 must consume {env}");
        }
    }

    #[test]
    fn sweep_ps1_kills_all_three_target_categories() {
        let stem = desktop_exe_stem();
        assert!(
            SWEEP_PS1.contains(&format!("Combine($instDir, '{stem}.exe')")),
            "sweep.ps1 must target $INSTDIR\\{stem}.exe, the binary Tauri installs"
        );
        let nodejs = speedwave_runtime::consts::NODEJS_SUBDIR;
        assert!(
            SWEEP_PS1.contains(&format!("Combine($instDir, '{nodejs}')")),
            "sweep.ps1 must target $instDir\\{nodejs}\\ workers"
        );
        let cli_dir = format!(
            "Combine($dataDir, '{}', $cliName)",
            speedwave_runtime::consts::CLI_BIN_SUBDIR
        );
        assert!(
            SWEEP_PS1.contains(&cli_dir),
            "sweep.ps1 must target the CLI through {cli_dir}"
        );
        let prod = speedwave_runtime::consts::installed_cli_filename(
            true,
            std::path::Path::new("/home/u/.speedwave"),
        );
        assert!(
            SWEEP_PS1.contains(&format!("'{prod}'")),
            "sweep.ps1 must fall back to '{prod}' for the production data dir"
        );
        assert!(
            SWEEP_PS1.contains(r"-replace '^speedwave-', ''"),
            "sweep.ps1 must strip the 'speedwave-' prefix like derive_cli_binary_name_from"
        );
        assert!(
            SWEEP_PS1.contains("Split-Path $dataDir -Leaf"),
            "sweep.ps1 must take the instance from the data-dir basename"
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
        assert!(
            FIREWALL_PS1.contains("New-NetFirewallRule")
                && FIREWALL_PS1.contains("Action      = 'Allow'")
                && FIREWALL_PS1.contains("Program     = $prog"),
            "firewall.ps1 must create host WDF -Program allow rules to suppress the prompt"
        );
    }

    #[test]
    fn firewall_ps1_accepts_programs_param_split_on_semicolon() {
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
        assert!(
            !FIREWALL_PS1.contains("-Verb RunAs") && !FIREWALL_PS1.contains("RunAs"),
            "firewall.ps1 must not self-elevate; elevation is driven from Rust"
        );
    }

    #[test]
    fn installers_invoke_only_install_and_uninstall_modes() {
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
        for (name, ps1) in INSTALLER_PS1_SOURCES {
            assert!(
                !ps1.contains('`'),
                "{name} contains a backtick — breaks NSIS FileWrite (use splatting)"
            );
        }
    }

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
    fn msi_custom_actions_run_the_scripts_where_the_msi_installs_them() {
        let conf: serde_json::Value =
            serde_json::from_str(TAURI_WINDOWS_CONF).expect("tauri.windows.conf.json must parse");
        let targets: std::collections::BTreeSet<&str> = conf["bundle"]["resources"]
            .as_object()
            .expect("tauri.windows.conf.json must map bundle.resources")
            .values()
            .filter_map(serde_json::Value::as_str)
            .collect();
        for (name, wxs) in [("sweep.wxs", SWEEP_WXS), ("firewall.wxs", FIREWALL_WXS)] {
            let scripts: Vec<&str> = wxs
                .match_indices("[INSTALLDIR]")
                .filter_map(|(at, marker)| {
                    wxs[at + marker.len()..]
                        .split("&quot;")
                        .next()
                        .filter(|path| path.ends_with(".ps1"))
                })
                .collect();
            assert!(!scripts.is_empty(), "{name} must run a bundled script");
            for script in scripts {
                assert!(
                    targets.contains(script.replace('\\', "/").as_str()),
                    "{name} runs [INSTALLDIR]{script}, but the MSI installs each bundled resource \
                     at its tauri.windows.conf.json target under INSTALLDIR"
                );
            }
        }
    }

    #[test]
    fn sweep_wxs_passes_installdir_via_file_arg_not_command_literal() {
        let cmd = SWEEP_WXS
            .lines()
            .find(|l| l.contains("powershell.exe") && l.contains("Value="))
            .expect("sweep.wxs must have a powershell CustomAction Value line");
        assert!(
            cmd.contains("-File"),
            "sweep.wxs must invoke sweep.ps1 via -File, not -Command"
        );
        assert!(
            !cmd.contains("-Command"),
            "sweep.wxs must not use -Command (interpolating [INSTALLDIR] into PS source is injectable)"
        );
        assert!(
            !cmd.contains("$env:SPW_INSTDIR"),
            "sweep.wxs must not assign [INSTALLDIR] into a PS string literal"
        );
    }

    #[test]
    fn sweep_wxs_installdir_arg_survives_trailing_backslash() {
        let line = SWEEP_WXS
            .lines()
            .find(|l| l.contains("powershell.exe") && l.contains("Value="))
            .expect("sweep.wxs must have a powershell CustomAction Value line");
        let inner = line
            .split_once("Value=\"")
            .and_then(|(_, rest)| rest.rsplit_once('"'))
            .map(|(v, _)| v)
            .expect("Value attribute must be quoted");
        let expanded = inner
            .replace("[INSTALLDIR]", "C:\\Program Files\\Speedwave\\")
            .replace("[%USERPROFILE]", "C:\\Users\\bob")
            .replace("[SystemFolder]", "C:\\Windows\\System32\\")
            .replace("&quot;", "\"");
        let argv = win32_argv(&expanded);
        assert!(
            argv.iter().any(|a| a == "-DataDir"),
            "-DataDir must reach argv (a trailing backslash must not swallow it): {argv:?}"
        );
        let inst = argv
            .iter()
            .position(|a| a == "-InstDir")
            .and_then(|i| argv.get(i + 1))
            .expect("-InstDir must have a value argument");
        assert!(
            !inst.contains('"'),
            "-InstDir value must not have absorbed a quote/next arg: {inst:?}"
        );
    }

    #[cfg(test)]
    fn win32_argv(cmd: &str) -> Vec<String> {
        let mut args = Vec::new();
        let mut cur = String::new();
        let mut in_quotes = false;
        let mut backslashes = 0usize;
        let mut started = false;
        for c in cmd.chars() {
            match c {
                '\\' => {
                    backslashes += 1;
                    started = true;
                }
                '"' => {
                    for _ in 0..backslashes / 2 {
                        cur.push('\\');
                    }
                    if backslashes % 2 == 1 {
                        cur.push('"');
                    } else {
                        in_quotes = !in_quotes;
                    }
                    backslashes = 0;
                    started = true;
                }
                ' ' | '\t' if !in_quotes => {
                    for _ in 0..backslashes {
                        cur.push('\\');
                    }
                    backslashes = 0;
                    if started {
                        args.push(std::mem::take(&mut cur));
                        started = false;
                    }
                }
                _ => {
                    for _ in 0..backslashes {
                        cur.push('\\');
                    }
                    backslashes = 0;
                    cur.push(c);
                    started = true;
                }
            }
        }
        for _ in 0..backslashes {
            cur.push('\\');
        }
        if started {
            args.push(cur);
        }
        args
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
    fn sweep_ps1_builds_paths_with_path_combine_not_join_path() {
        assert!(
            !SWEEP_PS1.contains("Join-Path"),
            "sweep.ps1 must not build paths with the provider-bound Join-Path (ADR-048)"
        );
        assert!(
            !SWEEP_PS1.contains(r"+ '\"),
            "sweep.ps1 must build paths with [System.IO.Path]::Combine, not '\\' concatenation (ADR-048)"
        );
    }

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

    fn windows_directory_resource_roots() -> std::collections::BTreeSet<String> {
        let conf: serde_json::Value =
            serde_json::from_str(TAURI_WINDOWS_CONF).expect("tauri.windows.conf.json must parse");
        conf["bundle"]["resources"]
            .as_object()
            .expect("tauri.windows.conf.json must map bundle.resources")
            .iter()
            .filter_map(|(source, target)| Some((source, target.as_str()?)))
            .filter(|(source, target)| {
                source.ends_with('/') || source.contains('*') || target.ends_with('/')
            })
            .map(|(_, target)| {
                let root = target.split(['/', '\\']).next().unwrap_or_default();
                assert!(
                    !matches!(root, "" | "." | ".."),
                    "a directory resource must install under a named child of $INSTDIR, got {target}"
                );
                root.to_owned()
            })
            .collect()
    }

    fn reset_trees() -> std::collections::BTreeSet<String> {
        let list = RESET_PS1
            .lines()
            .find_map(|line| line.trim().strip_prefix("$trees = @("))
            .and_then(|rest| rest.strip_suffix(')'))
            .expect("reset.ps1 must list its trees on one `$trees = @(...)` line");
        list.split(',')
            .map(|item| {
                let tree = item.trim().trim_matches('\'');
                assert!(
                    !matches!(tree, "" | "." | "..") && !tree.contains(['\\', '/', '$', '*']),
                    "reset.ps1 must name single children of $INSTDIR, got {item}"
                );
                tree.to_owned()
            })
            .collect()
    }

    fn desktop_exe_stem() -> String {
        let conf: serde_json::Value =
            serde_json::from_str(TAURI_CONF).expect("tauri.conf.json must parse");
        conf["mainBinaryName"]
            .as_str()
            .map_or_else(|| env!("CARGO_PKG_NAME").to_owned(), str::to_owned)
    }

    fn render_expected_hooks(template: &str, scripts: &[(&str, &str, &str)]) -> String {
        let embed = scripts
            .iter()
            .map(|(name, ext, src)| emit_materialize_macro(name, ext, src))
            .collect::<Vec<_>>()
            .join("\n");

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
