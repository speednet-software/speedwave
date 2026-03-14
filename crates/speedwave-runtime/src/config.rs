use crate::defaults;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct LlmConfig {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub api_key_env: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct ClaudeOverrides {
    pub env: Option<HashMap<String, String>>,
    pub settings: Option<serde_json::Value>,
    pub llm: Option<LlmConfig>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct IntegrationConfig {
    pub enabled: Option<bool>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct OsIntegrationsConfig {
    pub reminders: Option<IntegrationConfig>,
    pub calendar: Option<IntegrationConfig>,
    pub mail: Option<IntegrationConfig>,
    pub notes: Option<IntegrationConfig>,
}

impl OsIntegrationsConfig {
    /// Sets the enabled state for an OS integration service by config key.
    /// Returns `false` if the key is unknown.
    pub fn set_service(&mut self, key: &str, cfg: IntegrationConfig) -> bool {
        match key {
            "reminders" => self.reminders = Some(cfg),
            "calendar" => self.calendar = Some(cfg),
            "mail" => self.mail = Some(cfg),
            "notes" => self.notes = Some(cfg),
            _ => return false,
        }
        true
    }
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct IntegrationsConfig {
    pub slack: Option<IntegrationConfig>,
    pub sharepoint: Option<IntegrationConfig>,
    pub redmine: Option<IntegrationConfig>,
    pub gitlab: Option<IntegrationConfig>,
    pub os: Option<OsIntegrationsConfig>,
    #[serde(default)]
    pub plugins: Option<HashMap<String, IntegrationConfig>>,
}

impl IntegrationsConfig {
    /// Sets the enabled state for a MCP service by config key.
    /// Returns `false` if the key is unknown.
    pub fn set_service(&mut self, key: &str, cfg: IntegrationConfig) -> bool {
        match key {
            "slack" => self.slack = Some(cfg),
            "sharepoint" => self.sharepoint = Some(cfg),
            "redmine" => self.redmine = Some(cfg),
            "gitlab" => self.gitlab = Some(cfg),
            _ => return false,
        }
        true
    }

    /// Set plugin enabled state. Does NOT validate against installed manifests
    /// (caller must do that). Separate from set_service() to prevent typos
    /// from silently creating plugin entries.
    pub fn set_plugin_enabled(&mut self, service_id: &str, enabled: bool) {
        let plugins = self.plugins.get_or_insert_with(HashMap::new);
        plugins.insert(
            service_id.to_string(),
            IntegrationConfig {
                enabled: Some(enabled),
            },
        );
    }
}

#[derive(Debug, Clone, Default)]
pub struct ResolvedIntegrationsConfig {
    pub slack: bool,
    pub sharepoint: bool,
    pub redmine: bool,
    pub gitlab: bool,
    pub os_reminders: bool,
    pub os_calendar: bool,
    pub os_mail: bool,
    pub os_notes: bool,
    pub plugins: HashMap<String, bool>,
}

impl ResolvedIntegrationsConfig {
    pub fn any_os_enabled(&self) -> bool {
        self.os_reminders || self.os_calendar || self.os_mail || self.os_notes
    }

    pub fn is_service_enabled(&self, key: &str) -> Option<bool> {
        match key {
            "slack" => Some(self.slack),
            "sharepoint" => Some(self.sharepoint),
            "redmine" => Some(self.redmine),
            "gitlab" => Some(self.gitlab),
            _ => None,
        }
    }

    pub fn is_plugin_enabled(&self, service_id: &str) -> bool {
        self.plugins.get(service_id).copied().unwrap_or(false)
    }

    pub fn enabled_plugin_service_ids(&self) -> Vec<&str> {
        self.plugins
            .iter()
            .filter(|(_, &enabled)| enabled)
            .map(|(id, _)| id.as_str())
            .collect()
    }

    pub fn is_os_service_enabled(&self, key: &str) -> Option<bool> {
        match key {
            "reminders" => Some(self.os_reminders),
            "calendar" => Some(self.os_calendar),
            "mail" => Some(self.os_mail),
            "notes" => Some(self.os_notes),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Default, Debug)]
pub struct ProjectRepoConfig {
    pub claude: Option<ClaudeOverrides>,
    pub integrations: Option<IntegrationsConfig>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProjectUserEntry {
    pub name: String,
    pub dir: String,
    pub claude: Option<ClaudeOverrides>,
    pub integrations: Option<IntegrationsConfig>,
    #[serde(default)]
    pub plugin_settings: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SelectedIde {
    pub ide_name: String,
    pub port: u16,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct SpeedwaveUserConfig {
    pub projects: Vec<ProjectUserEntry>,
    pub active_project: Option<String>,
    pub selected_ide: Option<SelectedIde>,
    pub log_level: Option<String>,
}

impl SpeedwaveUserConfig {
    /// Looks up a project by name.
    pub fn find_project(&self, name: &str) -> Option<&ProjectUserEntry> {
        self.projects.iter().find(|p| p.name == name)
    }

    /// Looks up a project by name, returning an error if not found.
    pub fn require_project(&self, name: &str) -> anyhow::Result<&ProjectUserEntry> {
        self.find_project(name)
            .ok_or_else(|| anyhow::anyhow!("project '{}' not found in config", name))
    }

    /// Looks up a project by name (mutable).
    pub fn find_project_mut(&mut self, name: &str) -> Option<&mut ProjectUserEntry> {
        self.projects.iter_mut().find(|p| p.name == name)
    }

    /// Looks up a project by name (mutable), returning an error if not found.
    pub fn require_project_mut(&mut self, name: &str) -> anyhow::Result<&mut ProjectUserEntry> {
        self.projects
            .iter_mut()
            .find(|p| p.name == name)
            .ok_or_else(|| anyhow::anyhow!("project '{}' not found in config", name))
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedClaudeConfig {
    pub env: HashMap<String, String>,
    pub flags: Vec<&'static str>,
    pub llm: LlmConfig,
}

/// Resolves both Claude config and integrations in a single pass,
/// reading the repo config file only once.
pub fn resolve_project_config(
    project_dir: &Path,
    user_config: &SpeedwaveUserConfig,
    project_name: &str,
) -> (ResolvedClaudeConfig, ResolvedIntegrationsConfig) {
    let repo = load_repo_config_logged(project_dir);

    let mut env = defaults::base_env();
    let mut llm = LlmConfig::default();
    let mut integrations = ResolvedIntegrationsConfig::default();

    // Layer 1: repo config (.speedwave.json)
    if let Some(repo) = repo {
        if let Some(c) = repo.claude {
            merge_env(&mut env, c.env);
            if let Some(repo_llm) = c.llm {
                merge_llm(&mut llm, &repo_llm);
            }
        }
        if let Some(repo_integrations) = repo.integrations {
            apply_integrations_layer(&mut integrations, &repo_integrations);
        }
    }

    // Layer 2: user config (highest priority)
    if let Some(user) = user_config.find_project(project_name) {
        if let Some(c) = &user.claude {
            merge_env(&mut env, c.env.clone());
            if let Some(user_llm) = &c.llm {
                merge_llm(&mut llm, user_llm);
            }
        }
        if let Some(user_integrations) = &user.integrations {
            apply_integrations_layer(&mut integrations, user_integrations);
        }
    }

    let claude = ResolvedClaudeConfig {
        env,
        flags: defaults::DEFAULT_FLAGS.to_vec(),
        llm,
    };
    (claude, integrations)
}

/// Merges: defaults -> repo config (.speedwave.json) -> user config (~/.speedwave/config.json).
/// User config has highest priority.
pub fn resolve_claude_config(
    project_dir: &Path,
    user_config: &SpeedwaveUserConfig,
    project_name: &str,
) -> ResolvedClaudeConfig {
    resolve_project_config(project_dir, user_config, project_name).0
}

/// Merges integrations config: defaults (all disabled) -> repo -> user.
pub fn resolve_integrations(
    project_dir: &Path,
    user_config: &SpeedwaveUserConfig,
    project_name: &str,
) -> ResolvedIntegrationsConfig {
    resolve_project_config(project_dir, user_config, project_name).1
}

fn apply_toggle(target: &mut bool, source: &Option<IntegrationConfig>) {
    if let Some(cfg) = source {
        if let Some(enabled) = cfg.enabled {
            *target = enabled;
        }
    }
}

fn apply_integrations_layer(result: &mut ResolvedIntegrationsConfig, layer: &IntegrationsConfig) {
    apply_toggle(&mut result.slack, &layer.slack);
    apply_toggle(&mut result.sharepoint, &layer.sharepoint);
    apply_toggle(&mut result.redmine, &layer.redmine);
    apply_toggle(&mut result.gitlab, &layer.gitlab);
    if let Some(ref os) = layer.os {
        apply_toggle(&mut result.os_reminders, &os.reminders);
        apply_toggle(&mut result.os_calendar, &os.calendar);
        apply_toggle(&mut result.os_mail, &os.mail);
        apply_toggle(&mut result.os_notes, &os.notes);
    }
    if let Some(ref plugins) = layer.plugins {
        for (service_id, cfg) in plugins {
            if let Some(enabled) = cfg.enabled {
                result.plugins.insert(service_id.clone(), enabled);
            }
        }
    }
}

pub fn load_repo_config(project_dir: &Path) -> anyhow::Result<ProjectRepoConfig> {
    let config_path = project_dir.join(".speedwave.json");
    let content = std::fs::read_to_string(&config_path)?;
    let config: ProjectRepoConfig = serde_json::from_str(&content)?;
    Ok(config)
}

fn load_repo_config_logged(project_dir: &Path) -> Option<ProjectRepoConfig> {
    match load_repo_config(project_dir) {
        Ok(repo) => Some(repo),
        Err(e) => {
            if project_dir.join(".speedwave.json").exists() {
                log::warn!("failed to parse .speedwave.json: {e}");
            }
            None
        }
    }
}

pub fn load_user_config() -> anyhow::Result<SpeedwaveUserConfig> {
    let config_path = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?
        .join(crate::consts::DATA_DIR)
        .join("config.json");
    load_user_config_from(&config_path)
}

pub(crate) fn load_user_config_from(path: &Path) -> anyhow::Result<SpeedwaveUserConfig> {
    if !path.exists() {
        return Ok(SpeedwaveUserConfig::default());
    }
    let content = std::fs::read_to_string(path)?;
    let config: SpeedwaveUserConfig = serde_json::from_str(&content)?;
    Ok(config)
}

pub fn save_user_config(config: &SpeedwaveUserConfig) -> anyhow::Result<()> {
    let config_path = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?
        .join(crate::consts::DATA_DIR)
        .join("config.json");
    save_user_config_to(config, &config_path)
}

pub(crate) fn save_user_config_to(config: &SpeedwaveUserConfig, path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let content = serde_json::to_string_pretty(config)?;
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &content)?;
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

fn merge_env(base: &mut HashMap<String, String>, overlay: Option<HashMap<String, String>>) {
    if let Some(overlay) = overlay {
        for (key, value) in overlay {
            base.insert(key, value);
        }
    }
}

fn merge_llm(base: &mut LlmConfig, overlay: &LlmConfig) {
    if overlay.provider.is_some() {
        base.provider.clone_from(&overlay.provider);
    }
    if overlay.model.is_some() {
        base.model.clone_from(&overlay.model);
    }
    if overlay.base_url.is_some() {
        base.base_url.clone_from(&overlay.base_url);
    }
    if overlay.api_key_env.is_some() {
        base.api_key_env.clone_from(&overlay.api_key_env);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_default_config_has_expected_env() {
        let defaults = defaults::base_env();
        assert_eq!(
            defaults.get("ANTHROPIC_MODEL"),
            Some(&"claude-sonnet-4-6".to_string())
        );
        assert_eq!(
            defaults.get("CLAUDE_CODE_ENABLE_TELEMETRY"),
            Some(&"0".to_string())
        );
        assert_eq!(defaults.get("DISABLE_AUTOUPDATER"), Some(&"1".to_string()));
    }

    #[test]
    fn test_resolve_without_any_overrides() {
        let user_config = SpeedwaveUserConfig::default();
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        assert_eq!(
            resolved.env.get("ANTHROPIC_MODEL"),
            Some(&"claude-sonnet-4-6".to_string())
        );
        assert!(resolved.flags.contains(&"--dangerously-skip-permissions"));
        assert!(resolved.flags.contains(&"--mcp-config"));
        assert!(resolved.flags.contains(&defaults::MCP_CONFIG_PATH));
        assert!(resolved.flags.contains(&"--strict-mcp-config"));
    }

    #[test]
    fn test_resolve_with_repo_config() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join(".speedwave.json");
        let mut f = std::fs::File::create(&config_path).unwrap();
        write!(
            f,
            r#"{{
                "claude": {{
                    "env": {{
                        "ANTHROPIC_MODEL": "claude-opus-4-6",
                        "CLAUDE_CODE_ENABLE_TELEMETRY": "1"
                    }}
                }}
            }}"#
        )
        .unwrap();

        let user_config = SpeedwaveUserConfig::default();
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        assert_eq!(
            resolved.env.get("ANTHROPIC_MODEL"),
            Some(&"claude-opus-4-6".to_string())
        );
        assert_eq!(
            resolved.env.get("CLAUDE_CODE_ENABLE_TELEMETRY"),
            Some(&"1".to_string())
        );
    }

    #[test]
    fn test_user_config_overrides_repo_config() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join(".speedwave.json");
        let mut f = std::fs::File::create(&config_path).unwrap();
        write!(
            f,
            r#"{{
                "claude": {{
                    "env": {{
                        "CLAUDE_CODE_ENABLE_TELEMETRY": "1"
                    }}
                }}
            }}"#
        )
        .unwrap();

        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "test-project".to_string(),
                dir: tmp.path().to_string_lossy().to_string(),
                claude: Some(ClaudeOverrides {
                    env: Some(HashMap::from([(
                        "CLAUDE_CODE_ENABLE_TELEMETRY".to_string(),
                        "0".to_string(),
                    )])),
                    settings: None,
                    llm: None,
                }),
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };

        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        // User override wins
        assert_eq!(
            resolved.env.get("CLAUDE_CODE_ENABLE_TELEMETRY"),
            Some(&"0".to_string())
        );
    }

    #[test]
    fn test_llm_config_merge() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join(".speedwave.json");
        let mut f = std::fs::File::create(&config_path).unwrap();
        write!(
            f,
            r#"{{
                "claude": {{
                    "llm": {{
                        "provider": "openai",
                        "model": "gpt-4o",
                        "api_key_env": "OPENAI_API_KEY"
                    }}
                }}
            }}"#
        )
        .unwrap();

        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "test-project".to_string(),
                dir: tmp.path().to_string_lossy().to_string(),
                claude: Some(ClaudeOverrides {
                    env: None,
                    settings: None,
                    llm: Some(LlmConfig {
                        provider: Some("ollama".to_string()),
                        model: Some("llama3.3".to_string()),
                        base_url: Some("http://host.docker.internal:11434".to_string()),
                        api_key_env: None,
                    }),
                }),
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };

        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        assert_eq!(resolved.llm.provider.as_deref(), Some("ollama"));
        assert_eq!(resolved.llm.model.as_deref(), Some("llama3.3"));
        assert_eq!(
            resolved.llm.base_url.as_deref(),
            Some("http://host.docker.internal:11434")
        );
    }

    #[test]
    fn test_serde_roundtrip_project_repo_config() {
        let config = ProjectRepoConfig {
            claude: Some(ClaudeOverrides {
                env: Some(HashMap::from([("KEY".to_string(), "value".to_string())])),
                settings: Some(serde_json::json!({"alwaysThinkingEnabled": true})),
                llm: None,
            }),
            integrations: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: ProjectRepoConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(
            parsed.claude.unwrap().env.unwrap().get("KEY"),
            Some(&"value".to_string())
        );
    }

    #[test]
    fn test_serde_roundtrip_user_config() {
        let config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "acme".to_string(),
                dir: "/home/user/projects/acme".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: Some("acme".to_string()),
            selected_ide: None,
            log_level: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: SpeedwaveUserConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.projects.len(), 1);
        assert_eq!(parsed.projects[0].name, "acme");
        assert_eq!(parsed.active_project, Some("acme".to_string()));
    }

    #[test]
    fn test_save_user_config_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.json");

        let config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "test".to_string(),
                dir: "/tmp/test".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: Some("test".to_string()),
            selected_ide: None,
            log_level: None,
        };

        save_user_config_to(&config, &config_path).unwrap();
        let loaded = load_user_config_from(&config_path).unwrap();

        assert_eq!(loaded.projects.len(), 1);
        assert_eq!(loaded.projects[0].name, "test");
        assert_eq!(loaded.projects[0].dir, "/tmp/test");
        assert_eq!(loaded.active_project, Some("test".to_string()));
    }

    #[test]
    fn test_save_user_config_creates_parent_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("nested").join("deep").join("config.json");

        let config = SpeedwaveUserConfig {
            projects: vec![],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };

        save_user_config_to(&config, &config_path).unwrap();
        assert!(config_path.exists());
    }

    #[test]
    fn test_save_user_config_atomic_no_tmp_left() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.json");

        let config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "test".to_string(),
                dir: "/tmp/test".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: Some("test".to_string()),
            selected_ide: None,
            log_level: None,
        };

        save_user_config_to(&config, &config_path).unwrap();

        assert!(config_path.exists(), "config file should exist");
        assert!(
            !config_path.with_extension("json.tmp").exists(),
            "tmp file should not exist after atomic write"
        );

        let loaded = load_user_config_from(&config_path).unwrap();
        assert_eq!(loaded.projects.len(), 1);
        assert_eq!(loaded.projects[0].name, "test");
        assert_eq!(loaded.active_project, Some("test".to_string()));
    }

    #[test]
    fn test_save_user_config_atomic_preserves_existing_on_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.json");

        // Write initial config
        let config_v1 = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "v1".to_string(),
                dir: "/tmp/v1".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: Some("v1".to_string()),
            selected_ide: None,
            log_level: None,
        };
        save_user_config_to(&config_v1, &config_path).unwrap();

        // Overwrite with v2
        let config_v2 = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "v2".to_string(),
                dir: "/tmp/v2".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: Some("v2".to_string()),
            selected_ide: None,
            log_level: None,
        };
        save_user_config_to(&config_v2, &config_path).unwrap();

        let loaded = load_user_config_from(&config_path).unwrap();
        assert_eq!(loaded.projects.len(), 1);
        assert_eq!(loaded.projects[0].name, "v2");
        assert_eq!(loaded.active_project, Some("v2".to_string()));
        assert!(
            !config_path.with_extension("json.tmp").exists(),
            "tmp file should not exist after atomic write"
        );
    }

    #[test]
    fn test_log_level_serde_roundtrip() {
        let config = SpeedwaveUserConfig {
            projects: vec![],
            active_project: None,
            selected_ide: None,
            log_level: Some("debug".to_string()),
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: SpeedwaveUserConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.log_level, Some("debug".to_string()));
    }

    #[test]
    fn test_log_level_absent_defaults_to_none() {
        let json = r#"{"projects":[],"active_project":null,"selected_ide":null}"#;
        let parsed: SpeedwaveUserConfig = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.log_level, None);
    }

    fn assert_all_integrations_disabled(r: &ResolvedIntegrationsConfig) {
        assert!(!r.slack, "slack should be disabled");
        assert!(!r.sharepoint, "sharepoint should be disabled");
        assert!(!r.redmine, "redmine should be disabled");
        assert!(!r.gitlab, "gitlab should be disabled");
        assert!(!r.os_reminders, "os_reminders should be disabled");
        assert!(!r.os_calendar, "os_calendar should be disabled");
        assert!(!r.os_mail, "os_mail should be disabled");
        assert!(!r.os_notes, "os_notes should be disabled");
    }

    #[test]
    fn test_default_integrations_all_disabled() {
        let resolved = ResolvedIntegrationsConfig::default();
        assert_all_integrations_disabled(&resolved);
    }

    #[test]
    fn test_integrations_serde_roundtrip() {
        let config = IntegrationsConfig {
            slack: Some(IntegrationConfig {
                enabled: Some(false),
            }),
            sharepoint: None,
            redmine: Some(IntegrationConfig {
                enabled: Some(true),
            }),
            gitlab: None,
            os: Some(OsIntegrationsConfig {
                reminders: Some(IntegrationConfig {
                    enabled: Some(false),
                }),
                calendar: None,
                mail: None,
                notes: None,
            }),
            plugins: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: IntegrationsConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.slack.unwrap().enabled, Some(false));
        assert_eq!(parsed.redmine.unwrap().enabled, Some(true));
        assert_eq!(parsed.os.unwrap().reminders.unwrap().enabled, Some(false));
    }

    #[test]
    fn test_resolve_integrations_defaults_without_config() {
        let user_config = SpeedwaveUserConfig::default();
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_integrations(tmp.path(), &user_config, "test-project");
        assert_all_integrations_disabled(&resolved);
    }

    #[test]
    fn test_resolve_integrations_user_overrides_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join(".speedwave.json");
        let mut f = std::fs::File::create(&config_path).unwrap();
        write!(
            f,
            r#"{{
                "integrations": {{
                    "slack": {{ "enabled": false }},
                    "gitlab": {{ "enabled": false }}
                }}
            }}"#
        )
        .unwrap();

        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "test-project".to_string(),
                dir: tmp.path().to_string_lossy().to_string(),
                claude: None,
                integrations: Some(IntegrationsConfig {
                    slack: Some(IntegrationConfig {
                        enabled: Some(true),
                    }),
                    sharepoint: None,
                    redmine: None,
                    gitlab: None,
                    os: None,
                    plugins: None,
                }),
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };

        let resolved = resolve_integrations(tmp.path(), &user_config, "test-project");
        assert!(resolved.slack); // user override wins
        assert!(!resolved.gitlab); // repo stays
        assert!(!resolved.sharepoint); // default is disabled
    }

    #[test]
    fn test_resolve_integrations_os_granular_disable() {
        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "test-project".to_string(),
                dir: "/tmp/test".to_string(),
                claude: None,
                integrations: Some(IntegrationsConfig {
                    slack: None,
                    sharepoint: None,
                    redmine: None,
                    gitlab: None,
                    os: Some(OsIntegrationsConfig {
                        reminders: Some(IntegrationConfig {
                            enabled: Some(false),
                        }),
                        calendar: None,
                        mail: Some(IntegrationConfig {
                            enabled: Some(false),
                        }),
                        notes: None,
                    }),
                    plugins: None,
                }),
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };

        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_integrations(tmp.path(), &user_config, "test-project");
        assert!(!resolved.os_reminders); // explicitly disabled
        assert!(!resolved.os_calendar); // default is disabled
        assert!(!resolved.os_mail); // explicitly disabled
        assert!(!resolved.os_notes); // default is disabled
    }

    #[test]
    fn test_resolve_user_override_enables_single_service() {
        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "test-project".to_string(),
                dir: "/tmp/test".to_string(),
                claude: None,
                integrations: Some(IntegrationsConfig {
                    slack: Some(IntegrationConfig {
                        enabled: Some(true),
                    }),
                    sharepoint: None,
                    redmine: None,
                    gitlab: None,
                    os: None,
                    plugins: None,
                }),
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };

        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_integrations(tmp.path(), &user_config, "test-project");
        assert!(resolved.slack);
        assert!(!resolved.sharepoint);
        assert!(!resolved.redmine);
        assert!(!resolved.gitlab);
        assert!(!resolved.os_reminders);
        assert!(!resolved.os_calendar);
        assert!(!resolved.os_mail);
        assert!(!resolved.os_notes);
    }

    #[test]
    fn test_integrations_is_peer_to_claude_not_nested() {
        let json = r#"{
            "name": "test",
            "dir": "/tmp/test",
            "claude": { "env": { "KEY": "val" } },
            "integrations": { "slack": { "enabled": false } }
        }"#;
        let entry: ProjectUserEntry = serde_json::from_str(json).unwrap();
        assert!(entry.claude.is_some());
        assert!(entry.integrations.is_some());
        assert_eq!(
            entry.integrations.unwrap().slack.unwrap().enabled,
            Some(false)
        );
    }

    #[test]
    fn test_any_os_enabled_all_disabled() {
        let r = ResolvedIntegrationsConfig::default();
        assert!(!r.any_os_enabled());
    }

    #[test]
    fn test_any_os_enabled_one_enabled() {
        let r = ResolvedIntegrationsConfig {
            os_calendar: true,
            ..Default::default()
        };
        assert!(r.any_os_enabled());
    }

    #[test]
    fn test_any_os_enabled_ignores_non_os() {
        let r = ResolvedIntegrationsConfig {
            slack: true,
            ..Default::default()
        };
        assert!(!r.any_os_enabled());
    }

    #[test]
    fn test_is_service_enabled_known_keys() {
        let r = ResolvedIntegrationsConfig {
            slack: true,
            gitlab: false,
            ..Default::default()
        };
        assert_eq!(r.is_service_enabled("slack"), Some(true));
        assert_eq!(r.is_service_enabled("sharepoint"), Some(false));
        assert_eq!(r.is_service_enabled("redmine"), Some(false));
        assert_eq!(r.is_service_enabled("gitlab"), Some(false));
    }

    #[test]
    fn test_is_service_enabled_unknown_key() {
        let r = ResolvedIntegrationsConfig::default();
        assert_eq!(r.is_service_enabled("unknown"), None);
        assert_eq!(r.is_service_enabled("os_reminders"), None);
    }

    #[test]
    fn test_load_repo_config_logged_missing_file_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(load_repo_config_logged(tmp.path()).is_none());
    }

    #[test]
    fn test_load_repo_config_logged_valid_file_returns_some() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join(".speedwave.json");
        std::fs::write(&config_path, r#"{"claude": {"env": {"K": "V"}}}"#).unwrap();
        let result = load_repo_config_logged(tmp.path());
        assert!(result.is_some());
        assert!(result.unwrap().claude.is_some());
    }

    #[test]
    fn test_load_repo_config_logged_invalid_json_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join(".speedwave.json");
        std::fs::write(&config_path, "not valid json").unwrap();
        let result = load_repo_config_logged(tmp.path());
        assert!(result.is_none());
    }

    #[test]
    fn test_resolve_project_config_reads_repo_file_once() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join(".speedwave.json");
        std::fs::write(
            &config_path,
            r#"{
                "claude": { "env": { "ANTHROPIC_MODEL": "claude-opus-4-6" } },
                "integrations": { "slack": { "enabled": true } }
            }"#,
        )
        .unwrap();

        let user_config = SpeedwaveUserConfig::default();
        let (claude, integrations) =
            resolve_project_config(tmp.path(), &user_config, "test-project");

        assert_eq!(
            claude.env.get("ANTHROPIC_MODEL"),
            Some(&"claude-opus-4-6".to_string())
        );
        assert!(integrations.slack);
        assert!(!integrations.gitlab);
    }

    #[test]
    fn test_integrations_config_set_service_known_keys() {
        let mut cfg = IntegrationsConfig::default();
        assert!(cfg.set_service(
            "slack",
            IntegrationConfig {
                enabled: Some(true)
            }
        ));
        assert!(cfg.set_service(
            "sharepoint",
            IntegrationConfig {
                enabled: Some(true)
            }
        ));
        assert!(cfg.set_service(
            "redmine",
            IntegrationConfig {
                enabled: Some(true)
            }
        ));
        assert!(cfg.set_service(
            "gitlab",
            IntegrationConfig {
                enabled: Some(true)
            }
        ));
        assert_eq!(cfg.slack.unwrap().enabled, Some(true));
    }

    #[test]
    fn test_integrations_config_set_service_unknown_key() {
        let mut cfg = IntegrationsConfig::default();
        assert!(!cfg.set_service(
            "unknown",
            IntegrationConfig {
                enabled: Some(true)
            }
        ));
        assert!(!cfg.set_service(
            "os",
            IntegrationConfig {
                enabled: Some(true)
            }
        ));
    }

    #[test]
    fn test_load_corrupt_config_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.json");
        std::fs::write(&config_path, "{{not valid json!!!").unwrap();

        let result = load_user_config_from(&config_path);
        assert!(
            result.is_err(),
            "corrupt config should return an error, not silently default"
        );
    }

    #[test]
    fn test_load_missing_config_returns_default() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("nonexistent-config.json");

        let result = load_user_config_from(&config_path).unwrap();
        assert!(result.projects.is_empty());
        assert!(result.active_project.is_none());
    }

    #[test]
    fn test_set_plugin_enabled() {
        let mut cfg = IntegrationsConfig::default();
        assert!(cfg.plugins.is_none());

        cfg.set_plugin_enabled("presale", true);
        let plugins = cfg.plugins.as_ref().unwrap();
        assert_eq!(plugins.get("presale").unwrap().enabled, Some(true));

        cfg.set_plugin_enabled("presale", false);
        let plugins = cfg.plugins.as_ref().unwrap();
        assert_eq!(plugins.get("presale").unwrap().enabled, Some(false));
    }

    #[test]
    fn test_is_plugin_enabled() {
        let resolved = ResolvedIntegrationsConfig {
            plugins: HashMap::from([
                ("presale".to_string(), true),
                ("analytics".to_string(), false),
            ]),
            ..Default::default()
        };
        assert!(resolved.is_plugin_enabled("presale"));
        assert!(!resolved.is_plugin_enabled("analytics"));
        assert!(!resolved.is_plugin_enabled("unknown"));
    }

    #[test]
    fn test_enabled_plugin_service_ids() {
        let resolved = ResolvedIntegrationsConfig {
            plugins: HashMap::from([
                ("presale".to_string(), true),
                ("analytics".to_string(), false),
                ("reporting".to_string(), true),
            ]),
            ..Default::default()
        };
        let mut enabled = resolved.enabled_plugin_service_ids();
        enabled.sort();
        assert_eq!(enabled, vec!["presale", "reporting"]);
    }

    #[test]
    fn test_resolve_integrations_with_plugins() {
        let tmp = tempfile::tempdir().unwrap();
        // No repo config (no .speedwave.json)

        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "test-project".to_string(),
                dir: tmp.path().to_string_lossy().to_string(),
                claude: None,
                integrations: Some(IntegrationsConfig {
                    slack: None,
                    sharepoint: None,
                    redmine: None,
                    gitlab: None,
                    os: None,
                    plugins: Some(HashMap::from([(
                        "presale".to_string(),
                        IntegrationConfig {
                            enabled: Some(true),
                        },
                    )])),
                }),
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };

        let resolved = resolve_integrations(tmp.path(), &user_config, "test-project");
        assert!(resolved.is_plugin_enabled("presale"));
        assert!(!resolved.is_plugin_enabled("unknown"));
        assert_eq!(resolved.enabled_plugin_service_ids(), vec!["presale"]);
    }

    // -- SpeedwaveUserConfig::find_project / require_project tests --

    fn make_config_with_projects() -> SpeedwaveUserConfig {
        SpeedwaveUserConfig {
            projects: vec![
                ProjectUserEntry {
                    name: "alpha".to_string(),
                    dir: "/tmp/alpha".to_string(),
                    claude: None,
                    integrations: None,
                    plugin_settings: None,
                },
                ProjectUserEntry {
                    name: "beta".to_string(),
                    dir: "/tmp/beta".to_string(),
                    claude: None,
                    integrations: None,
                    plugin_settings: None,
                },
            ],
            active_project: None,
            selected_ide: None,
            log_level: None,
        }
    }

    #[test]
    fn test_find_project_found() {
        let config = make_config_with_projects();
        let project = config.find_project("alpha");
        assert!(project.is_some());
        assert_eq!(project.unwrap().dir, "/tmp/alpha");
    }

    #[test]
    fn test_find_project_not_found() {
        let config = make_config_with_projects();
        assert!(config.find_project("missing").is_none());
    }

    #[test]
    fn test_find_project_empty_name() {
        let config = make_config_with_projects();
        assert!(config.find_project("").is_none());
    }

    #[test]
    fn test_require_project_found() {
        let config = make_config_with_projects();
        let project = config.require_project("beta").unwrap();
        assert_eq!(project.dir, "/tmp/beta");
    }

    #[test]
    fn test_require_project_not_found_returns_error() {
        let config = make_config_with_projects();
        let result = config.require_project("missing");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("missing"),
            "error should contain project name, got: {err}"
        );
    }

    #[test]
    fn test_find_project_mut_modifies_entry() {
        let mut config = make_config_with_projects();
        let project = config.find_project_mut("alpha").unwrap();
        project.dir = "/updated/path".to_string();
        assert_eq!(config.projects[0].dir, "/updated/path");
    }

    #[test]
    fn test_require_project_mut_modifies_entry() {
        let mut config = make_config_with_projects();
        let project = config.require_project_mut("beta").unwrap();
        project.dir = "/new/beta".to_string();
        assert_eq!(config.projects[1].dir, "/new/beta");
    }

    #[test]
    fn test_require_project_mut_not_found_returns_error() {
        let mut config = make_config_with_projects();
        let result = config.require_project_mut("missing");
        assert!(result.is_err());
    }

    // -- OsIntegrationsConfig::set_service tests --

    #[test]
    fn test_os_set_service_known_keys() {
        for key in &["reminders", "calendar", "mail", "notes"] {
            let mut cfg = OsIntegrationsConfig::default();
            let ic = IntegrationConfig {
                enabled: Some(true),
            };
            assert!(
                cfg.set_service(key, ic),
                "set_service should accept '{}'",
                key
            );
        }
    }

    #[test]
    fn test_os_set_service_unknown_key_returns_false() {
        let mut cfg = OsIntegrationsConfig::default();
        let ic = IntegrationConfig {
            enabled: Some(true),
        };
        assert!(!cfg.set_service("unknown", ic));
    }

    #[test]
    fn test_os_set_service_overwrite() {
        let mut cfg = OsIntegrationsConfig::default();
        cfg.set_service(
            "calendar",
            IntegrationConfig {
                enabled: Some(true),
            },
        );
        cfg.set_service(
            "calendar",
            IntegrationConfig {
                enabled: Some(false),
            },
        );
        assert_eq!(cfg.calendar.unwrap().enabled, Some(false));
    }

    // -- ResolvedIntegrationsConfig::is_os_service_enabled tests --

    #[test]
    fn test_is_os_service_enabled_known_keys() {
        let r = ResolvedIntegrationsConfig {
            os_reminders: true,
            os_calendar: false,
            os_mail: true,
            os_notes: false,
            ..Default::default()
        };
        assert_eq!(r.is_os_service_enabled("reminders"), Some(true));
        assert_eq!(r.is_os_service_enabled("calendar"), Some(false));
        assert_eq!(r.is_os_service_enabled("mail"), Some(true));
        assert_eq!(r.is_os_service_enabled("notes"), Some(false));
    }

    #[test]
    fn test_is_os_service_enabled_unknown_key() {
        let r = ResolvedIntegrationsConfig::default();
        assert_eq!(r.is_os_service_enabled("unknown"), None);
        assert_eq!(r.is_os_service_enabled("slack"), None);
    }
}
