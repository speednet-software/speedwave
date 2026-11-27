use speedwave_runtime::compose;
use speedwave_runtime::config;
use speedwave_runtime::consts;
use speedwave_runtime::runtime::LockedRuntime;

use super::session;
use crate::project_command::ProjectContext;
use crate::{cli_logger, redact_err, terminal_restore};

#[cfg(windows)]
const LOGIN_PASTE_STEP: &[&str] = &[
    "2. Paste it at the \"Paste code here\" prompt with Ctrl+Shift+V",
    "   or a right-click, then press Enter. Plain Ctrl+V may not paste there.",
];

#[cfg(not(windows))]
const LOGIN_PASTE_STEP: &[&str] =
    &["2. Paste it at the \"Paste code here\" prompt with Cmd+V, then press Enter."];

pub(super) fn run(project: ProjectContext, runtime: LockedRuntime) -> anyhow::Result<()> {
    if let Err(e) = select_anthropic_after_login(&project.name) {
        err!(
            "Login failed: could not select Anthropic: {}",
            redact_err(&e)
        );
        std::process::exit(1);
    }
    let user_config = config::load_user_config().unwrap_or_else(|e| {
        err!("Failed to load config: {err}", err = redact_err(&e));
        std::process::exit(1);
    });
    let project = ProjectContext {
        user_config,
        ..project
    };

    let started = session::bring_up(&project, &runtime)?;

    err!("{}", login_instructions());
    let instance_id = speedwave_runtime::session::new_instance_id();
    let cmd = session::stamped_exec_argv(
        &instance_id,
        build_login_exec_cmd(
            compose::PROXY_BASE_URL,
            compose::anthropic_login_unset_keys(),
        ),
    );
    let cmd_ref: Vec<&str> = cmd.iter().map(String::as_str).collect();
    let terminal = cli_logger::hand_over_terminal();
    let status_result = runtime
        .container_exec(&started.container_name, &cmd_ref)
        .status();
    terminal_restore::sanitize_host_terminal();
    drop(terminal);
    session::reap_instance(&runtime, &started.container_name, &instance_id);
    let status = status_result?;
    std::process::exit(
        status
            .code()
            .unwrap_or(if status.success() { 0 } else { 1 }),
    )
}

fn select_anthropic_after_login(project: &str) -> anyhow::Result<()> {
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        let evidence = config::AnthropicEvidence::detect_in(consts::data_dir().as_path(), project);
        if select_anthropic_in(&mut user_config, project, evidence) {
            config::save_user_config(&user_config)?;
        }
        Ok(())
    })
}

fn select_anthropic_in(
    user_config: &mut config::SpeedwaveUserConfig,
    project: &str,
    evidence: config::AnthropicEvidence,
) -> bool {
    let Some(entry) = user_config.find_project_mut(project) else {
        return false;
    };
    let claude = entry.claude.get_or_insert_with(Default::default);
    let llm = claude.llm.get_or_insert_with(Default::default);
    let migrated = config::migrate_llm(llm, evidence);
    let selected = llm.set_active_to_anthropic();
    selected || migrated
}

fn login_instructions() -> String {
    let mut lines = vec![
        "Anthropic sign-in".to_string(),
        String::new(),
        "1. Open the link printed below, sign in and copy the code it shows.".to_string(),
    ];
    lines.extend(LOGIN_PASTE_STEP.iter().map(|line| line.to_string()));
    lines.push("3. Close this terminal when sign-in is done.".to_string());
    framed(&lines)
}

fn framed(lines: &[String]) -> String {
    let width = lines
        .iter()
        .map(|line| line.chars().count())
        .max()
        .unwrap_or(0);
    let rule = "─".repeat(width + 2);
    let body: String = lines
        .iter()
        .map(|line| format!("│ {line:<width$} │\n"))
        .collect();
    format!("┌{rule}┐\n{body}└{rule}┘")
}

fn build_login_exec_cmd(base_url: &str, unset_keys: &[&str]) -> Vec<String> {
    let script = format!(
        "unset {}; export ANTHROPIC_BASE_URL={base_url}; exec {} auth login --claudeai",
        unset_keys.join(" "),
        consts::CLAUDE_BINARY,
    );
    vec!["sh".to_string(), "-lc".to_string(), script]
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test fixtures assert on setup that must not silently fail"
)]
mod tests {
    use super::*;

    #[test]
    fn framed_pads_every_line_to_the_widest_one() {
        let boxed = framed(&["ab".to_string(), "abcd".to_string(), String::new()]);
        let rows: Vec<&str> = boxed.lines().collect();
        assert_eq!(
            rows,
            ["┌──────┐", "│ ab   │", "│ abcd │", "│      │", "└──────┘"]
        );
    }

    #[test]
    fn framed_counts_characters_not_bytes() {
        let boxed = framed(&["zażółć".to_string(), "abcdef".to_string()]);
        let widths: Vec<usize> = boxed.lines().map(|row| row.chars().count()).collect();
        assert!(widths.iter().all(|w| *w == widths[0]), "{boxed}");
    }

    #[test]
    fn framed_without_lines_is_an_empty_box() {
        assert_eq!(framed(&[]), "┌──┐\n└──┘");
    }

    #[test]
    fn login_instructions_fit_an_80_column_terminal() {
        let boxed = login_instructions();
        let widest = boxed.lines().map(|row| row.chars().count()).max();
        assert!(widest.is_some_and(|w| w <= 80), "{boxed}");
    }

    #[test]
    fn build_login_exec_cmd_unsets_and_execs_auth_login() {
        let cmd = build_login_exec_cmd(
            "http://proxy:4000",
            &["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"],
        );
        assert_eq!(cmd[0], "sh");
        assert_eq!(cmd[1], "-lc");
        let script = &cmd[2];
        assert!(
            script.contains("unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL"),
            "{script}"
        );
        assert!(
            script.contains("export ANTHROPIC_BASE_URL=http://proxy:4000"),
            "{script}"
        );
        let exec_pos = script.find("exec ").expect("exec present");
        let unset_pos = script.find("unset ").unwrap();
        assert!(unset_pos < exec_pos, "unset must precede exec: {script}");
        assert!(
            script.contains(&format!("{} auth login --claudeai", consts::CLAUDE_BINARY)),
            "auth login subcommand: {script}"
        );
    }

    #[test]
    fn build_login_exec_cmd_uses_runtime_ssot_unset_list() {
        let cmd = build_login_exec_cmd(
            compose::PROXY_BASE_URL,
            compose::anthropic_login_unset_keys(),
        );
        let script = &cmd[2];
        for key in compose::anthropic_login_unset_keys() {
            assert!(script.contains(key), "unset list missing `{key}`: {script}");
        }
        assert!(script.contains(compose::PROXY_BASE_URL), "{script}");
    }

    fn user_config_with_project(
        project: &str,
        claude: Option<config::ClaudeOverrides>,
    ) -> config::SpeedwaveUserConfig {
        let mut user_config = config::SpeedwaveUserConfig::default();
        user_config.projects.push(config::ProjectUserEntry {
            name: project.to_string(),
            dir: "/tmp/proj".to_string(),
            claude,
            integrations: None,
            plugin_settings: None,
            policy: None,
            effort_pin: None,
            read_only: false,
        });
        user_config
    }

    #[test]
    fn select_anthropic_in_creates_llm_override_for_fresh_project() {
        let mut user_config = user_config_with_project("proj", None);
        assert!(select_anthropic_in(
            &mut user_config,
            "proj",
            config::AnthropicEvidence::None
        ));
        let llm = user_config
            .find_project_mut("proj")
            .unwrap()
            .claude
            .as_ref()
            .unwrap()
            .llm
            .as_ref()
            .unwrap();
        assert!(!llm.is_unconfigured());
        assert_eq!(
            llm.active.as_ref().unwrap().provider_id,
            config::ANTHROPIC_PROVIDER_ID,
            "fresh project must select anthropic, not just stop being fresh"
        );
    }

    #[test]
    fn select_anthropic_in_creates_llm_override_when_claude_present_but_llm_absent() {
        let mut user_config = user_config_with_project(
            "proj",
            Some(config::ClaudeOverrides {
                env: None,
                settings: None,
                llm: None,
            }),
        );
        assert!(select_anthropic_in(
            &mut user_config,
            "proj",
            config::AnthropicEvidence::None
        ));
        assert!(!user_config
            .find_project_mut("proj")
            .unwrap()
            .claude
            .as_ref()
            .unwrap()
            .llm
            .as_ref()
            .unwrap()
            .is_unconfigured());
    }

    #[test]
    fn select_anthropic_in_reactivates_explicit_logout() {
        let llm = config::LlmConfig {
            schema_version: Some(config::LLM_SCHEMA_VERSION),
            providers: vec![config::LlmProviderEntry {
                id: config::ANTHROPIC_PROVIDER_ID.to_string(),
                kind: config::LlmProviderKind::AnthropicOauth,
                base_url: None,
                model: None,
                has_api_key: false,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: None,
            ..Default::default()
        };
        assert!(
            llm.is_unconfigured(),
            "precondition: logged-out is unconfigured"
        );
        let mut user_config = user_config_with_project(
            "proj",
            Some(config::ClaudeOverrides {
                env: None,
                settings: None,
                llm: Some(llm),
            }),
        );
        assert!(select_anthropic_in(
            &mut user_config,
            "proj",
            config::AnthropicEvidence::None
        ));
        assert!(!user_config
            .find_project_mut("proj")
            .unwrap()
            .claude
            .as_ref()
            .unwrap()
            .llm
            .as_ref()
            .unwrap()
            .is_unconfigured());
    }

    #[test]
    fn select_anthropic_in_preserves_raw_v1_local_config() {
        let mut user_config = user_config_with_project(
            "proj",
            Some(config::ClaudeOverrides {
                env: None,
                settings: None,
                llm: Some(config::LlmConfig {
                    provider: Some("lmstudio".into()),
                    base_url: Some("http://localhost:1234".into()),
                    model: Some("qwen".into()),
                    ..Default::default()
                }),
            }),
        );
        assert!(select_anthropic_in(
            &mut user_config,
            "proj",
            config::AnthropicEvidence::Oauth
        ));
        let binding = user_config.find_project_mut("proj").unwrap();
        let llm = binding.claude.as_ref().unwrap().llm.as_ref().unwrap();
        let local = llm
            .providers
            .iter()
            .find(|p| p.id == "local")
            .expect("local entry must survive the lift");
        assert_eq!(local.base_url.as_deref(), Some("http://localhost:1234"));
        assert_eq!(local.model.as_deref(), Some("qwen"));
        assert_eq!(
            llm.active.as_ref().unwrap().provider_id,
            config::ANTHROPIC_PROVIDER_ID
        );
    }

    #[test]
    fn select_anthropic_in_preserves_v1_pinned_anthropic_model() {
        let mut user_config = user_config_with_project(
            "proj",
            Some(config::ClaudeOverrides {
                env: None,
                settings: None,
                llm: Some(config::LlmConfig {
                    provider: Some(config::ANTHROPIC_PROVIDER_ID.to_string()),
                    model: Some("claude-opus-4-6".into()),
                    ..Default::default()
                }),
            }),
        );
        select_anthropic_in(&mut user_config, "proj", config::AnthropicEvidence::Oauth);
        let binding = user_config.find_project_mut("proj").unwrap();
        let llm = binding.claude.as_ref().unwrap().llm.as_ref().unwrap();
        assert_eq!(
            llm.effective_active_model().as_deref(),
            Some("claude-opus-4-6")
        );
    }

    #[test]
    fn select_anthropic_in_noop_when_project_not_found() {
        let mut user_config = config::SpeedwaveUserConfig::default();
        assert!(!select_anthropic_in(
            &mut user_config,
            "ghost-project",
            config::AnthropicEvidence::None
        ));
        assert!(user_config.find_project_mut("ghost-project").is_none());
    }

    #[test]
    fn select_anthropic_in_idempotent_when_already_anthropic() {
        let mut llm = config::LlmConfig {
            schema_version: Some(config::LLM_SCHEMA_VERSION),
            providers: vec![config::LlmProviderEntry {
                id: config::ANTHROPIC_PROVIDER_ID.to_string(),
                kind: config::LlmProviderKind::AnthropicOauth,
                base_url: None,
                model: None,
                has_api_key: false,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: None,
            ..Default::default()
        };
        assert!(
            llm.set_active_to_anthropic(),
            "first activation changes state"
        );
        config::migrate_llm(&mut llm, config::AnthropicEvidence::None);
        let mut user_config = user_config_with_project(
            "proj",
            Some(config::ClaudeOverrides {
                env: None,
                settings: None,
                llm: Some(llm),
            }),
        );
        assert!(
            !select_anthropic_in(&mut user_config, "proj", config::AnthropicEvidence::None),
            "already-active anthropic must not report a change"
        );
    }
}
