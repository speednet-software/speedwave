// Auth commands — extracted from main.rs. Tauri command wrappers for API-key management and
// CLI auth command generation.

use crate::types::{check_project, AuthStatusResponse};

use super::{auth, setup_wizard};

// ── Authentication commands (API key only — OAuth is done via CLI) ─────────

#[tauri::command]
pub async fn save_api_key(project: String, api_key: String) -> Result<(), String> {
    check_project(&project)?;
    if api_key.len() > crate::types::MAX_CREDENTIAL_BYTES {
        return Err("API key too long".to_string());
    }
    tokio::task::spawn_blocking(move || {
        log::info!("saving API key for project {project}");
        auth::save_api_key(&project, &api_key).map_err(|e| {
            log::error!("failed to save API key: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_api_key(project: String) -> Result<(), String> {
    check_project(&project)?;
    tokio::task::spawn_blocking(move || {
        log::info!("deleting API key for project {project}");
        auth::delete_api_key(&project).map_err(|e| {
            log::error!("failed to delete API key: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn anthropic_logout(project: String) -> Result<(), String> {
    check_project(&project)?;
    tokio::task::spawn_blocking(move || {
        log::info!("logging out of Anthropic for project {project}");
        speedwave_runtime::claude_home::remove_claude_credentials(
            speedwave_runtime::consts::data_dir().as_path(),
            &project,
        )
        .map(|_| ())
        .map_err(|e| {
            log::error!("failed to remove Anthropic credentials: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Migrates the project's `claude.llm` (default shape when absent) so
/// `is_unconfigured()` sees the post-migration, evidence-aware answer.
fn migrated_llm_for(
    user_config: &speedwave_runtime::config::SpeedwaveUserConfig,
    project: &str,
    evidence: speedwave_runtime::config::AnthropicEvidence,
) -> speedwave_runtime::config::LlmConfig {
    let mut llm = user_config
        .find_project(project)
        .and_then(|p| p.claude.as_ref())
        .and_then(|c| c.llm.clone())
        .unwrap_or_default();
    speedwave_runtime::config::migrate_llm(&mut llm, evidence);
    llm
}

/// True when the project's migrated LLM config resolves an active provider.
/// Shared by `get_auth_status` and the reconcile restore guard.
pub(crate) fn project_llm_configured_in(
    data_dir: &std::path::Path,
    user_config: &speedwave_runtime::config::SpeedwaveUserConfig,
    project: &str,
) -> bool {
    let evidence = speedwave_runtime::config::AnthropicEvidence::detect_in(data_dir, project);
    !migrated_llm_for(user_config, project, evidence).is_unconfigured()
}

#[tauri::command]
pub async fn get_auth_status(project: String) -> Result<AuthStatusResponse, String> {
    check_project(&project)?;
    tokio::task::spawn_blocking(move || {
        crate::containers_cmd::ensure_images_ready()?;
        log::info!("resolving auth status for project {project}");
        let api_key_configured = auth::has_api_key(&project);
        // Real OAuth state = credentials file present (provider-independent).
        let oauth_authenticated = speedwave_runtime::claude_home::has_anthropic_oauth_credentials(
            speedwave_runtime::consts::data_dir().as_path(),
            &project,
        );
        // R7: non-anthropic providers never need Anthropic auth.
        let user_config = speedwave_runtime::config::load_user_config().unwrap_or_default();
        let needs_anthropic_auth =
            setup_wizard::project_needs_anthropic_auth(&user_config, &project);
        let evidence = if api_key_configured {
            speedwave_runtime::config::AnthropicEvidence::ApiKey
        } else if oauth_authenticated {
            speedwave_runtime::config::AnthropicEvidence::Oauth
        } else {
            speedwave_runtime::config::AnthropicEvidence::None
        };
        // Migrated (not raw) shape — must agree with needs_anthropic_auth, which
        // itself already evaluates the equivalent post-migration answer.
        let migrated = migrated_llm_for(&user_config, &project, evidence);
        // False for explicit v2 logout/dangling and credential-less fresh; a
        // blockless project WITH credentials fabricates (v0.13.3 default population).
        let provider_configured = !migrated.is_unconfigured();
        Ok(AuthStatusResponse::from_flags(
            api_key_configured,
            oauth_authenticated,
            needs_anthropic_auth,
            provider_configured,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── CLI auth command generation ─────────────────────────────────────────────

/// Shell-escape a string for use inside single quotes (POSIX standard).
/// Each embedded single-quote becomes: close-quote, backslash-escaped quote, open-quote.
pub(crate) fn shell_escape_single_quoted(s: &str) -> String {
    s.replace('\'', "'\\''")
}

/// `\\?\` prefix stripper — re-export of the runtime SSOT.
pub(crate) use speedwave_runtime::engine_path::strip_extended_length_prefix as strip_windows_extended_length_prefix;

/// Escapes a string for safe interpolation inside a PowerShell single-quoted literal — only
/// embedded single quotes need doubling.
pub(crate) fn ps_escape_single_quoted(s: &str) -> String {
    s.replace('\'', "''")
}

/// Pure command assembly. `is_windows` selects PowerShell-shaped output (Set-Location, `;`, $env:,
/// '' escape, \\?\ stripping) vs POSIX (cd, &&, export, '\'' escape).
pub(crate) fn build_auth_command_for_platform(
    project: &str,
    project_dir: &str,
    home: &std::path::Path,
    data_dir: &std::path::Path,
    default_data_dir: Option<&std::path::Path>,
    is_windows: bool,
) -> String {
    let needs_env_pin = default_data_dir.map(|d| d != data_dir).unwrap_or(false);
    let data_dir_str = data_dir.to_string_lossy();
    let cli_path = speedwave_runtime::consts::cli_install_path_for(is_windows, home, data_dir);

    if is_windows {
        let pdir = strip_windows_extended_length_prefix(project_dir);
        let ddir = strip_windows_extended_length_prefix(&data_dir_str);
        let cli_path = strip_windows_extended_length_prefix(&cli_path);
        if needs_env_pin {
            // Pin CLI path to <data_dir>/bin so PATH cannot resolve a foreign install.
            format!(
                "$env:{} = '{}'; Set-Location '{}'; & '{}' login --project '{}'",
                speedwave_runtime::consts::DATA_DIR_ENV,
                ps_escape_single_quoted(ddir),
                ps_escape_single_quoted(pdir),
                ps_escape_single_quoted(cli_path),
                ps_escape_single_quoted(project),
            )
        } else {
            // Absolute path always: a shell spawned right after the wizard
            // (before any PATH refresh) has no `speedwave` on PATH yet.
            format!(
                "Set-Location '{}'; & '{}' login --project '{}'",
                ps_escape_single_quoted(pdir),
                ps_escape_single_quoted(cli_path),
                ps_escape_single_quoted(project),
            )
        }
    } else if needs_env_pin {
        format!(
            "export {}='{}' && cd '{}' && '{}' login --project '{}'",
            speedwave_runtime::consts::DATA_DIR_ENV,
            shell_escape_single_quoted(&data_dir_str),
            shell_escape_single_quoted(project_dir),
            shell_escape_single_quoted(&cli_path),
            shell_escape_single_quoted(project),
        )
    } else {
        format!(
            "cd '{}' && '{}' login --project '{}'",
            shell_escape_single_quoted(project_dir),
            shell_escape_single_quoted(&cli_path),
            shell_escape_single_quoted(project),
        )
    }
}

/// Production entry point. Reads the host platform once via `cfg!()` and delegates to
/// `build_auth_command_for_platform`, keeping the `get_auth_command` call-site unchanged.
fn build_auth_command(
    project: &str,
    project_dir: &str,
    home: &std::path::Path,
    data_dir: &std::path::Path,
    default_data_dir: Option<&std::path::Path>,
) -> String {
    build_auth_command_for_platform(
        project,
        project_dir,
        home,
        data_dir,
        default_data_dir,
        cfg!(target_os = "windows"),
    )
}

/// Resolves the project directory, home, active data dir, and default data dir.
/// Shared by `get_auth_command` and `start_oauth_login` to prevent drift.
pub(crate) fn resolve_project_dirs(
    project: &str,
) -> Result<
    (
        String,
        std::path::PathBuf,
        std::path::PathBuf,
        Option<std::path::PathBuf>,
    ),
    String,
> {
    let user_config = speedwave_runtime::config::load_user_config()
        .map_err(|e| format!("Failed to load config: {e}"))?;
    let project_dir = user_config
        .find_project(project)
        .map(|p| p.dir.clone())
        .ok_or_else(|| format!("project '{project}' not found in config"))?;
    let home = dirs::home_dir().ok_or_else(|| "cannot determine home directory".to_string())?;
    let data_dir = speedwave_runtime::consts::data_dir().clone();
    let default_data_dir = Some(home.join(speedwave_runtime::consts::DATA_DIR));
    Ok((project_dir, home, data_dir, default_data_dir))
}

/// Resolves the CLI install path and errors with a user-facing message if the
/// binary is not present, so callers never emit a command that will fail.
pub(crate) fn ensure_cli_installed() -> Result<(), String> {
    let install = speedwave_runtime::consts::cli_install_path()
        .ok_or_else(|| "cannot determine home directory".to_string())?;
    ensure_cli_installed_at(std::path::Path::new(&install))
}

fn ensure_cli_installed_at(install: &std::path::Path) -> Result<(), String> {
    if install.exists() {
        Ok(())
    } else {
        Err(format!(
            "CLI not installed at {} — reopen the Speedwave app to finish setup",
            install.display()
        ))
    }
}

/// Returns a CLI command to authenticate with Claude Code. Non-default data dir prefixes
/// `export SPEEDWAVE_DATA_DIR=...` (POSIX) or `$env:SPEEDWAVE_DATA_DIR = '...'` (PowerShell).
#[tauri::command]
pub async fn get_auth_command(project: String) -> Result<String, String> {
    check_project(&project)?;
    tokio::task::spawn_blocking(move || {
        log::info!("building auth command for project {project}");
        let (project_dir, home, data_dir, default_data_dir) = resolve_project_dirs(&project)?;
        ensure_cli_installed()?;
        Ok(build_auth_command(
            &project,
            &project_dir,
            &home,
            &data_dir,
            default_data_dir.as_deref(),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;

    // -- get_auth_status race guard --

    #[test]
    fn get_auth_status_waits_for_image_readiness() {
        // Race guard: get_auth_status must gate on image readiness before exec.
        let source = include_str!("auth_commands.rs");
        let fn_start = source
            .find("pub async fn get_auth_status(")
            .expect("get_auth_status Tauri command must exist");
        let fn_tail = &source[fn_start + 1..];
        let fn_end = fn_tail
            .find("// ── CLI auth command generation")
            .map(|i| fn_start + 1 + i)
            .unwrap_or(source.len());
        let fn_body = &source[fn_start..fn_end];

        let ensure_pos = fn_body
            .find("ensure_images_ready")
            .expect("get_auth_status must call ensure_images_ready");
        let oauth_pos = fn_body
            .find("has_anthropic_oauth_credentials")
            .expect("get_auth_status must read real OAuth state via credentials presence");
        assert!(
            ensure_pos < oauth_pos,
            "ensure_images_ready must come BEFORE the OAuth state read"
        );
    }

    #[test]
    fn get_auth_status_oauth_is_credentials_presence_not_check_claude_auth() {
        // The badge must reflect real login, not check_claude_auth's Ok(true)
        // skip for non-anthropic providers.
        let source = include_str!("auth_commands.rs");
        let fn_start = source.find("pub async fn get_auth_status(").unwrap();
        // Scan production code only — the test module below mentions
        // check_claude_auth by design.
        let fn_end = source[fn_start..]
            .find("#[cfg(test)]")
            .map(|i| fn_start + i)
            .unwrap_or(source.len());
        let fn_body = &source[fn_start..fn_end];
        assert!(
            !fn_body.contains("check_claude_auth"),
            "oauth_authenticated must not come from the provider-gated check_claude_auth"
        );
    }

    #[test]
    fn get_auth_status_populates_needs_anthropic_auth_from_predicate() {
        // R7: the gate field must come from project_needs_anthropic_auth, not be
        // hardcoded — else non-anthropic providers strand on "auth required".
        let source = include_str!("auth_commands.rs");
        let fn_start = source
            .find("pub async fn get_auth_status(")
            .expect("get_auth_status Tauri command must exist");
        let fn_tail = &source[fn_start + 1..];
        let fn_end = fn_tail
            .find("// ── CLI auth command generation")
            .map(|i| fn_start + 1 + i)
            .unwrap_or(source.len());
        let fn_body = &source[fn_start..fn_end];
        assert!(
            fn_body.contains("project_needs_anthropic_auth"),
            "get_auth_status must derive needs_anthropic_auth from the predicate"
        );
        assert!(
            fn_body.contains("needs_anthropic_auth,"),
            "get_auth_status must return the needs_anthropic_auth field"
        );
    }

    #[test]
    fn get_auth_status_derives_provider_configured_from_is_unconfigured() {
        // provider_configured defaults to FALSE for fresh/missing (no provider
        // chosen yet), same as an explicit v2 logout.
        let source = include_str!("auth_commands.rs");
        let fn_start = source
            .find("pub async fn get_auth_status(")
            .expect("get_auth_status Tauri command must exist");
        let fn_tail = &source[fn_start + 1..];
        let fn_end = fn_tail
            .find("// ── CLI auth command generation")
            .map(|i| fn_start + 1 + i)
            .unwrap_or(source.len());
        let fn_body = &source[fn_start..fn_end];
        assert!(
            fn_body.contains("!migrated.is_unconfigured()"),
            "get_auth_status must derive provider_configured from the SSOT is_unconfigured gate"
        );
        assert!(
            fn_body.contains("migrated_llm_for"),
            "provider_configured must evaluate a migrated shape, not the raw stored config"
        );
        assert!(
            fn_body.contains("provider_configured,"),
            "get_auth_status must return the provider_configured field"
        );
    }

    /// A never-migrated `LlmConfig::default()` must yield
    /// `provider_configured == false` via `get_auth_status`.
    #[test]
    fn provider_configured_is_false_for_fresh_llm_default() {
        let mut user_config = speedwave_runtime::config::SpeedwaveUserConfig::default();
        user_config
            .projects
            .push(speedwave_runtime::config::ProjectUserEntry {
                name: "proj".to_string(),
                dir: "/tmp/proj".to_string(),
                claude: Some(speedwave_runtime::config::ClaudeOverrides {
                    env: None,
                    settings: None,
                    llm: Some(speedwave_runtime::config::LlmConfig::default()),
                }),
                integrations: None,
                plugin_settings: None,
            });
        let migrated = migrated_llm_for(
            &user_config,
            "proj",
            speedwave_runtime::config::AnthropicEvidence::None,
        );
        let provider_configured = !migrated.is_unconfigured();
        assert!(
            !provider_configured,
            "a never-touched LlmConfig::default() must read as not configured"
        );
    }

    /// State transition: once an active provider is selected, the same
    /// derivation flips to `true` — proves the expression isn't vacuously false.
    #[test]
    fn provider_configured_is_true_once_active_provider_resolves() {
        let mut llm = speedwave_runtime::config::LlmConfig::default();
        assert!(llm.set_active_to_anthropic());
        let mut user_config = speedwave_runtime::config::SpeedwaveUserConfig::default();
        user_config
            .projects
            .push(speedwave_runtime::config::ProjectUserEntry {
                name: "proj".to_string(),
                dir: "/tmp/proj".to_string(),
                claude: Some(speedwave_runtime::config::ClaudeOverrides {
                    env: None,
                    settings: None,
                    llm: Some(llm),
                }),
                integrations: None,
                plugin_settings: None,
            });
        let migrated = migrated_llm_for(
            &user_config,
            "proj",
            speedwave_runtime::config::AnthropicEvidence::None,
        );
        let provider_configured = !migrated.is_unconfigured();
        assert!(provider_configured);
    }

    /// Edge case: project exists but `claude` is `None` entirely — must not
    /// panic, defaults to not-configured (no credentials, no llm block).
    #[test]
    fn provider_configured_is_false_when_claude_override_absent() {
        let mut user_config = speedwave_runtime::config::SpeedwaveUserConfig::default();
        user_config
            .projects
            .push(speedwave_runtime::config::ProjectUserEntry {
                name: "proj".to_string(),
                dir: "/tmp/proj".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            });
        let migrated = migrated_llm_for(
            &user_config,
            "proj",
            speedwave_runtime::config::AnthropicEvidence::None,
        );
        let provider_configured = !migrated.is_unconfigured();
        assert!(!provider_configured);
    }

    /// Legacy v1 config with a saved API key must still migrate to
    /// "configured", not just the OAuth (no-key) path.
    #[test]
    fn migrated_llm_for_reads_configured_for_legacy_v1_with_api_key() {
        let mut user_config = speedwave_runtime::config::SpeedwaveUserConfig::default();
        user_config
            .projects
            .push(speedwave_runtime::config::ProjectUserEntry {
                name: "proj".to_string(),
                dir: "/tmp/proj".to_string(),
                claude: Some(speedwave_runtime::config::ClaudeOverrides {
                    env: None,
                    settings: None,
                    llm: Some(speedwave_runtime::config::LlmConfig {
                        provider: Some("anthropic".to_string()),
                        ..Default::default()
                    }),
                }),
                integrations: None,
                plugin_settings: None,
            });
        let migrated = migrated_llm_for(
            &user_config,
            "proj",
            speedwave_runtime::config::AnthropicEvidence::ApiKey,
        );
        let provider_configured = !migrated.is_unconfigured();
        assert!(provider_configured);
    }

    /// Edge case: unknown project name must not panic — mirrors
    /// `find_project` returning `None` for a name absent from `projects`.
    #[test]
    fn migrated_llm_for_returns_none_for_unknown_project() {
        let user_config = speedwave_runtime::config::SpeedwaveUserConfig::default();
        assert!(migrated_llm_for(
            &user_config,
            "missing",
            speedwave_runtime::config::AnthropicEvidence::None
        )
        .is_unconfigured());
    }

    /// Upgrade rescue: a project with no `claude.llm` block but on-disk
    /// Anthropic credentials must read as configured (v0.13.3 default population).
    #[test]
    fn blockless_project_with_oauth_evidence_reads_configured() {
        let mut user_config = speedwave_runtime::config::SpeedwaveUserConfig::default();
        user_config
            .projects
            .push(speedwave_runtime::config::ProjectUserEntry {
                name: "proj".to_string(),
                dir: "/tmp/proj".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            });
        let migrated = migrated_llm_for(
            &user_config,
            "proj",
            speedwave_runtime::config::AnthropicEvidence::Oauth,
        );
        assert!(!migrated.is_unconfigured());
        let entry = migrated.active_provider().expect("active entry");
        assert_eq!(entry.id, "anthropic");
        assert!(!entry.has_api_key);
    }

    /// An unmigrated legacy v1 raw config must not make `provider_configured`
    /// and `needs_anthropic_auth` disagree in the same response.
    #[test]
    fn migrated_llm_for_reconciles_legacy_v1_raw_contradiction() {
        let mut user_config = speedwave_runtime::config::SpeedwaveUserConfig::default();
        user_config
            .projects
            .push(speedwave_runtime::config::ProjectUserEntry {
                name: "proj".to_string(),
                dir: "/tmp/proj".to_string(),
                claude: Some(speedwave_runtime::config::ClaudeOverrides {
                    env: None,
                    settings: None,
                    llm: Some(speedwave_runtime::config::LlmConfig {
                        provider: Some("anthropic".to_string()),
                        ..Default::default()
                    }),
                }),
                integrations: None,
                plugin_settings: None,
            });

        let needs_anthropic_auth = setup_wizard::project_needs_anthropic_auth(&user_config, "proj");
        assert!(needs_anthropic_auth, "legacy v1 anthropic needs OAuth");

        let migrated = migrated_llm_for(
            &user_config,
            "proj",
            speedwave_runtime::config::AnthropicEvidence::None,
        );
        let provider_configured = !migrated.is_unconfigured();
        assert!(
            provider_configured,
            "a legacy v1 anthropic config must read as configured once migrated, \
             matching needs_anthropic_auth's already-correct 'true'"
        );
    }

    // -- anthropic_logout --

    #[test]
    fn anthropic_logout_calls_credentials_ssot_with_check_project() {
        let source = include_str!("auth_commands.rs");
        let fn_start = source
            .find("pub async fn anthropic_logout(")
            .expect("anthropic_logout Tauri command must exist");
        let fn_tail = &source[fn_start + 1..];
        let fn_end = fn_tail
            .find("pub async fn ")
            .or_else(|| fn_tail.find("pub fn "))
            .map(|i| fn_start + 1 + i)
            .unwrap_or(source.len());
        let fn_body = &source[fn_start..fn_end];
        assert!(
            fn_body.contains("check_project"),
            "anthropic_logout must validate the project"
        );
        assert!(
            fn_body.contains("remove_claude_credentials"),
            "anthropic_logout must clear credentials via the runtime SSOT, not reimplement deletion"
        );
    }

    // -- shell_escape_single_quoted tests --

    #[test]
    fn shell_escape_no_quotes() {
        assert_eq!(shell_escape_single_quoted("hello"), "hello");
    }

    #[test]
    fn shell_escape_with_single_quote() {
        assert_eq!(shell_escape_single_quoted("it's"), "it'\\''s");
    }

    #[test]
    fn shell_escape_multiple_quotes() {
        assert_eq!(shell_escape_single_quoted("a'b'c"), "a'\\''b'\\''c");
    }

    #[test]
    fn shell_escape_empty_string() {
        assert_eq!(shell_escape_single_quoted(""), "");
    }

    // -- login command path must match the install-path SSOT --

    #[test]
    fn login_command_path_matches_install_path() {
        let home = std::path::Path::new("/Users/test");
        let default_dd = home.join(".speedwave");
        let custom_dd = home.join(".speedwave-dev");
        let win_dd = std::path::Path::new("C:\\Users\\test\\.speedwave");
        let cases: [(bool, &std::path::Path, Option<&std::path::Path>); 4] = [
            (false, default_dd.as_path(), Some(default_dd.as_path())), // unix, non-pin
            (false, custom_dd.as_path(), Some(default_dd.as_path())),  // unix, env-pin
            (true, win_dd, Some(win_dd)),                              // windows, non-pin
            (true, win_dd, None),                                      // windows
        ];
        for (is_windows, dd, default) in cases {
            let install = speedwave_runtime::consts::cli_install_path_for(is_windows, home, dd);
            let cmd =
                build_auth_command_for_platform("proj", "/proj", home, dd, default, is_windows);
            assert!(
                cmd.contains(&install),
                "login command must reference install path {install}: got {cmd}"
            );
        }
    }

    // -- build_auth_command tests --

    #[test]
    fn build_auth_command_default_data_dir() {
        let home = std::path::Path::new("/Users/test");
        let dd = std::path::Path::new("/Users/test/.speedwave");
        let cmd = build_auth_command_for_platform(
            "myproj",
            "/Users/test/Projects",
            home,
            dd,
            Some(dd),
            false,
        );
        assert_eq!(
            cmd,
            "cd '/Users/test/Projects' && '/Users/test/.local/bin/speedwave' login --project 'myproj'"
        );
        assert!(!cmd.contains("export"));
    }

    #[test]
    fn build_auth_command_custom_data_dir() {
        let cmd = build_auth_command(
            "myproj",
            "/Users/test/Projects",
            std::path::Path::new("/Users/test"),
            std::path::Path::new("/Users/test/.speedwave-dev"),
            Some(std::path::Path::new("/Users/test/.speedwave")),
        );
        assert!(cmd.starts_with(&format!(
            "export {}=",
            speedwave_runtime::consts::DATA_DIR_ENV
        )));
        assert!(cmd.contains("/Users/test/.speedwave-dev"));
        assert!(cmd.contains("cd '/Users/test/Projects'"));
        assert!(cmd.ends_with("speedwave' login --project 'myproj'"));
    }

    #[test]
    fn build_auth_command_custom_data_dir_quotes_value() {
        let cmd = build_auth_command(
            "p",
            "/proj",
            std::path::Path::new("/Users/test"),
            std::path::Path::new("/Users/test/.speedwave-dev"),
            Some(std::path::Path::new("/Users/test/.speedwave")),
        );
        assert!(cmd.contains("='/Users/test/.speedwave-dev'"));
    }

    #[test]
    fn build_auth_command_no_default_data_dir() {
        let home = std::path::Path::new("/data");
        let dd = std::path::Path::new("/data/.speedwave");
        let cmd = build_auth_command_for_platform("p", "/projects", home, dd, None, false);
        assert_eq!(
            cmd,
            "cd '/projects' && '/data/.local/bin/speedwave' login --project 'p'"
        );
    }

    #[test]
    fn build_auth_command_quotes_paths_with_spaces() {
        let cmd = build_auth_command(
            "p",
            "/Users/John Smith/My Projects",
            std::path::Path::new("/Users/John Smith"),
            std::path::Path::new("/Users/John Smith/.speedwave"),
            Some(std::path::Path::new("/Users/John Smith/.speedwave")),
        );
        assert!(cmd.contains("cd '/Users/John Smith/My Projects'"));
    }

    #[test]
    fn build_auth_command_escapes_single_quotes_in_project_dir() {
        let cmd = build_auth_command(
            "p",
            "/Users/O'Brien/project",
            std::path::Path::new("/Users/O'Brien"),
            std::path::Path::new("/Users/O'Brien/.speedwave"),
            Some(std::path::Path::new("/Users/O'Brien/.speedwave")),
        );
        assert!(cmd.contains("O'\\''Brien"));
        assert!(cmd.contains("cd '"));
        assert!(cmd.ends_with("speedwave' login --project 'p'"));
    }

    #[test]
    fn build_auth_command_escapes_single_quotes_in_data_dir() {
        let cmd = build_auth_command(
            "p",
            "/projects",
            std::path::Path::new("/Users/O'Brien"),
            std::path::Path::new("/Users/O'Brien/.speedwave-dev"),
            Some(std::path::Path::new("/Users/O'Brien/.speedwave")),
        );
        assert!(cmd.contains("export"));
        assert!(cmd.contains("O'\\''Brien"));
    }

    #[test]
    fn build_auth_command_quotes_paths_with_special_chars() {
        let cmd = build_auth_command(
            "p",
            "/Users/test/proj&ect",
            std::path::Path::new("/Users/test"),
            std::path::Path::new("/Users/test/.speedwave"),
            Some(std::path::Path::new("/Users/test/.speedwave")),
        );
        assert!(cmd.contains("cd '/Users/test/proj&ect'"));
    }

    #[test]
    fn build_auth_command_unicode_paths() {
        let cmd = build_auth_command(
            "p",
            "/Users/tëst/プロジェクト",
            std::path::Path::new("/Users/tëst"),
            std::path::Path::new("/Users/tëst/.speedwave"),
            Some(std::path::Path::new("/Users/tëst/.speedwave")),
        );
        assert!(cmd.contains("プロジェクト"));
    }

    #[test]
    fn build_auth_command_trailing_slash_does_not_cause_mismatch() {
        // Unix path derives from home, not data_dir; a trailing slash on data_dir
        // must neither trigger env-pin nor change the CLI path.
        let home = std::path::Path::new("/Users/test");
        let dd = std::path::Path::new("/Users/test/.speedwave/");
        let cmd = build_auth_command_for_platform(
            "p",
            "/projects",
            home,
            dd,
            Some(std::path::Path::new("/Users/test/.speedwave")),
            false,
        );
        assert!(
            !cmd.contains("export"),
            "trailing slash must not trigger export (Path normalizes)"
        );
        assert_eq!(
            cmd,
            "cd '/projects' && '/Users/test/.local/bin/speedwave' login --project 'p'"
        );
    }

    #[test]
    fn build_auth_command_ordering() {
        let cmd = build_auth_command(
            "p",
            "/proj",
            std::path::Path::new("/data"),
            std::path::Path::new("/data-dev"),
            Some(std::path::Path::new("/data")),
        );
        let export_pos = cmd.find("export").unwrap();
        let cd_pos = cmd.find("cd ").unwrap();
        let sw_pos = cmd.find("speedwave").unwrap();
        assert!(export_pos < cd_pos);
        assert!(cd_pos < sw_pos);
    }

    #[test]
    fn build_auth_command_empty_project_dir() {
        let home = std::path::Path::new("/data");
        let dd = std::path::Path::new("/data/.speedwave");
        let cmd = build_auth_command_for_platform("p", "", home, dd, Some(dd), false);
        assert_eq!(
            cmd,
            "cd '' && '/data/.local/bin/speedwave' login --project 'p'"
        );
    }

    #[test]
    fn build_auth_command_includes_project_in_login_argument() {
        // Project name must flow into the trailing `--project '<name>'`.
        let cmd = build_auth_command(
            "specific-project-name",
            "/proj",
            std::path::Path::new("/data"),
            std::path::Path::new("/data"),
            Some(std::path::Path::new("/data")),
        );
        assert!(cmd.contains("--project 'specific-project-name'"));
    }

    #[test]
    fn build_auth_command_escapes_single_quote_in_project_name() {
        // Defensive escaping in case validation is relaxed.
        let cmd = build_auth_command(
            "weird'name",
            "/proj",
            std::path::Path::new("/data"),
            std::path::Path::new("/data"),
            Some(std::path::Path::new("/data")),
        );
        assert!(cmd.contains("--project 'weird'\\''name'"));
    }

    // -- strip_windows_extended_length_prefix tests --

    #[test]
    fn strip_prefix_uppercase_drive() {
        assert_eq!(
            strip_windows_extended_length_prefix(r"\\?\C:\Users\dev"),
            r"C:\Users\dev"
        );
    }

    #[test]
    fn strip_prefix_lowercase_drive() {
        assert_eq!(
            strip_windows_extended_length_prefix(r"\\?\d:\temp\proj"),
            r"d:\temp\proj"
        );
    }

    #[test]
    fn strip_prefix_forward_slash_separator() {
        assert_eq!(
            strip_windows_extended_length_prefix(r"\\?\C:/Users/dev"),
            r"C:/Users/dev"
        );
    }

    #[test]
    fn strip_prefix_already_stripped() {
        assert_eq!(
            strip_windows_extended_length_prefix(r"C:\Users\dev"),
            r"C:\Users\dev"
        );
    }

    #[test]
    fn strip_prefix_unc_path() {
        assert_eq!(
            strip_windows_extended_length_prefix(r"\\server\share"),
            r"\\server\share"
        );
    }

    #[test]
    fn strip_prefix_unc_extended_length() {
        assert_eq!(
            strip_windows_extended_length_prefix(r"\\?\UNC\server\share"),
            r"\\?\UNC\server\share"
        );
    }

    #[test]
    fn strip_prefix_posix_path() {
        assert_eq!(
            strip_windows_extended_length_prefix("/Users/dev"),
            "/Users/dev"
        );
    }

    #[test]
    fn strip_prefix_empty_string() {
        assert_eq!(strip_windows_extended_length_prefix(""), "");
    }

    #[test]
    fn strip_prefix_too_short() {
        assert_eq!(strip_windows_extended_length_prefix(r"\\?\"), r"\\?\");
    }

    #[test]
    fn strip_prefix_bare_drive_no_separator() {
        // \\?\C: is six bytes — must NOT strip (would yield "C:" which is drive-relative)
        assert_eq!(strip_windows_extended_length_prefix(r"\\?\C:"), r"\\?\C:");
    }

    #[test]
    fn strip_prefix_unicode_no_crash() {
        let s = "プロジェクト";
        assert_eq!(strip_windows_extended_length_prefix(s), s);
    }

    // -- ps_escape_single_quoted tests --

    #[test]
    fn ps_escape_no_quotes() {
        assert_eq!(ps_escape_single_quoted("hello"), "hello");
    }

    #[test]
    fn ps_escape_single_quote() {
        assert_eq!(ps_escape_single_quoted("it's"), "it''s");
    }

    #[test]
    fn ps_escape_multiple_quotes() {
        assert_eq!(ps_escape_single_quoted("a'b'c"), "a''b''c");
    }

    #[test]
    fn ps_escape_empty_string() {
        assert_eq!(ps_escape_single_quoted(""), "");
    }

    #[test]
    fn ps_escape_unicode_preserved() {
        assert_eq!(ps_escape_single_quoted("プロジェクト"), "プロジェクト");
    }

    // -- build_auth_command_for_platform Windows branch tests --

    #[test]
    fn build_auth_command_for_platform_windows_default_data_dir() {
        let cmd = build_auth_command_for_platform(
            "myproj",
            r"C:\Users\test\Projects",
            std::path::Path::new(r"C:\Users\test"),
            std::path::Path::new(r"C:\Users\test\.speedwave"),
            Some(std::path::Path::new(r"C:\Users\test\.speedwave")),
            true,
        );
        assert_eq!(
            cmd,
            r"Set-Location 'C:\Users\test\Projects'; & 'C:\Users\test\.speedwave\bin\speedwave.exe' login --project 'myproj'"
        );
        assert!(!cmd.contains("&&"));
        assert!(!cmd.contains("export"));
        assert!(!cmd.starts_with("cd "));
    }

    #[test]
    fn build_auth_command_for_platform_windows_custom_data_dir() {
        let cmd = build_auth_command_for_platform(
            "myproj",
            r"C:\Users\test\Projects",
            std::path::Path::new(r"C:\Users\test"),
            std::path::Path::new(r"C:\Users\test\.speedwave-dev"),
            Some(std::path::Path::new(r"C:\Users\test\.speedwave")),
            true,
        );
        assert_eq!(
            cmd,
            format!(
                "$env:{} = 'C:\\Users\\test\\.speedwave-dev'; \
                 Set-Location 'C:\\Users\\test\\Projects'; \
                 & 'C:\\Users\\test\\.speedwave-dev\\bin\\speedwave.exe' \
                 login --project 'myproj'",
                speedwave_runtime::consts::DATA_DIR_ENV,
            )
        );
        assert!(!cmd.contains("&&"));
        assert!(!cmd.contains("export "));
    }

    #[test]
    fn build_auth_command_for_platform_windows_custom_data_dir_pins_cli_path() {
        let cmd = build_auth_command_for_platform(
            "p",
            r"C:\proj",
            std::path::Path::new(r"C:\Users\test"),
            std::path::Path::new(r"C:\Users\test\.speedwave-dev"),
            Some(std::path::Path::new(r"C:\Users\test\.speedwave")),
            true,
        );
        assert!(
            cmd.contains(r"& 'C:\Users\test\.speedwave-dev\bin\speedwave.exe'"),
            "env-pinned PS command must invoke CLI via absolute data_dir path, got: {cmd}"
        );
        assert!(
            !cmd.contains("; speedwave login"),
            "bare `speedwave` would let PATH pick a foreign install, got: {cmd}"
        );
    }

    #[test]
    fn build_auth_command_for_platform_strips_extended_length_prefix_issue_612() {
        // Regression test for GitHub issue #612 — reproduces the exact failing input
        let cmd = build_auth_command_for_platform(
            "p",
            r"\\?\C:\Users\NikodemDeja\testproject",
            std::path::Path::new(r"C:\Users\test"),
            std::path::Path::new(r"C:\Users\NikodemDeja\.speedwave"),
            Some(std::path::Path::new(r"C:\Users\NikodemDeja\.speedwave")),
            true,
        );
        assert_eq!(
            cmd,
            r"Set-Location 'C:\Users\NikodemDeja\testproject'; & 'C:\Users\NikodemDeja\.speedwave\bin\speedwave.exe' login --project 'p'"
        );
        assert!(!cmd.contains(r"\\?\"));
        assert!(!cmd.contains(" && "));
        assert!(!cmd.contains("export "));
        assert!(!cmd.contains(" cd "));
    }

    #[test]
    fn build_auth_command_for_platform_windows_escapes_single_quote_in_path() {
        let cmd = build_auth_command_for_platform(
            "p",
            r"C:\Users\O'Brien\proj",
            std::path::Path::new(r"C:\Users\test"),
            std::path::Path::new(r"C:\Users\O'Brien\.speedwave"),
            Some(std::path::Path::new(r"C:\Users\O'Brien\.speedwave")),
            true,
        );
        assert!(cmd.contains("O''Brien"));
        assert!(!cmd.contains("O'\\''Brien"));
    }

    #[test]
    fn build_auth_command_for_platform_windows_unicode_path() {
        let cmd = build_auth_command_for_platform(
            "p",
            r"C:\Users\test\プロジェクト",
            std::path::Path::new(r"C:\Users\test"),
            std::path::Path::new(r"C:\Users\test\.speedwave"),
            Some(std::path::Path::new(r"C:\Users\test\.speedwave")),
            true,
        );
        assert!(cmd.contains("プロジェクト"));
    }

    #[test]
    fn build_auth_command_for_platform_windows_no_double_ampersand() {
        // Defence-in-depth: no Windows output may contain " && "
        let cmd_no_env = build_auth_command_for_platform(
            "p",
            r"C:\proj",
            std::path::Path::new(r"C:\Users\test"),
            std::path::Path::new(r"C:\.speedwave"),
            Some(std::path::Path::new(r"C:\.speedwave")),
            true,
        );
        assert!(!cmd_no_env.contains(" && "));

        let cmd_with_env = build_auth_command_for_platform(
            "p",
            r"C:\proj",
            std::path::Path::new(r"C:\Users\test"),
            std::path::Path::new(r"C:\.speedwave-dev"),
            Some(std::path::Path::new(r"C:\.speedwave")),
            true,
        );
        assert!(!cmd_with_env.contains(" && "));
    }

    #[test]
    fn build_auth_command_for_platform_windows_escapes_single_quote_in_data_dir() {
        // Custom data dir must use PS doubling (''), not POSIX ('\').
        let cmd = build_auth_command_for_platform(
            "p",
            r"C:\proj",
            std::path::Path::new(r"C:\Users\test"),
            std::path::Path::new(r"C:\Users\O'Brien\.speedwave-dev"),
            Some(std::path::Path::new(r"C:\Users\O'Brien\.speedwave")),
            true,
        );
        assert!(cmd.contains("O''Brien"));
        assert!(!cmd.contains("O'\\''Brien"));
        assert!(cmd.starts_with(&format!(
            "$env:{} = 'C:\\Users\\O''Brien\\.speedwave-dev'",
            speedwave_runtime::consts::DATA_DIR_ENV
        )));
    }

    #[test]
    fn build_auth_command_for_platform_windows_strips_extended_length_prefix_in_data_dir() {
        // Defence-in-depth: if data_dir carries \\?\, env var must be cleaned.
        let cmd = build_auth_command_for_platform(
            "p",
            r"C:\proj",
            std::path::Path::new(r"C:\Users\test"),
            std::path::Path::new(r"\\?\C:\Users\test\.speedwave-dev"),
            Some(std::path::Path::new(r"C:\Users\test\.speedwave")),
            true,
        );
        assert!(!cmd.contains(r"\\?\"));
        assert!(cmd.contains(r"$env:"));
        assert!(cmd.contains(r"'C:\Users\test\.speedwave-dev'"));
    }

    #[test]
    fn build_auth_command_for_platform_windows_passthrough_bare_drive() {
        // \\?\C: (bare drive, no separator) must pass through unchanged
        let cmd = build_auth_command_for_platform(
            "p",
            r"\\?\C:",
            std::path::Path::new(r"C:\Users\test"),
            std::path::Path::new(r"C:\.speedwave"),
            Some(std::path::Path::new(r"C:\.speedwave")),
            true,
        );
        assert!(cmd.contains(r"Set-Location '\\?\C:'"));
    }

    #[test]
    fn build_auth_command_for_platform_windows_escapes_single_quote_in_project_name() {
        // Defensive escaping in case validation changes.
        let cmd = build_auth_command_for_platform(
            "weird'name",
            r"C:\proj",
            std::path::Path::new(r"C:\Users\test"),
            std::path::Path::new(r"C:\.speedwave"),
            Some(std::path::Path::new(r"C:\.speedwave")),
            true,
        );
        assert!(cmd.contains("--project 'weird''name'"));
    }

    // -- CLI install-presence gate --

    #[test]
    fn cli_presence_gate_rejects_missing_and_accepts_existing() {
        let tmp = tempfile::tempdir().expect("tempdir");

        let missing = tmp.path().join("nope").join("speedwave");
        let err = super::ensure_cli_installed_at(&missing).expect_err("missing path must reject");
        assert!(err.contains("CLI not installed at"));
        assert!(err.contains(&missing.display().to_string()));
        assert!(err.contains("reopen the Speedwave app"));

        let present = tmp.path().join("speedwave");
        std::fs::write(&present, b"bin").expect("write");
        assert!(super::ensure_cli_installed_at(&present).is_ok());
    }

    // ── AuthStatusResponse wire-format ─────────────────────────────────────

    #[test]
    fn auth_status_response_serializes_all_fields() {
        let resp = crate::types::AuthStatusResponse::from_flags(
            true,  // api_key_configured
            false, // oauth_authenticated
            true,  // needs_anthropic_auth
            false, // provider_configured
        );
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["api_key_configured"], true);
        assert_eq!(json["oauth_authenticated"], false);
        assert_eq!(json["needs_anthropic_auth"], true);
        assert_eq!(json["provider_configured"], false);
        // Derived discriminant rides the same response (snake_case wire string).
        assert_eq!(json["status"], "no_provider");
    }

    #[test]
    fn auth_status_response_status_ready_wire_string() {
        let resp = crate::types::AuthStatusResponse::from_flags(true, false, true, true);
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["status"], "ready");
    }

    #[test]
    fn auth_status_response_status_auth_required_wire_string() {
        let resp = crate::types::AuthStatusResponse::from_flags(false, false, true, true);
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["status"], "auth_required");
    }
}
