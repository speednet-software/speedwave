//! Config schema and the layered merge (defaults → repo → user). See ADR-011.

use crate::defaults;
use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// LLM provider selection and model settings (`anthropic` or `local`).
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct LlmConfig {
    /// Provider id (`anthropic` | `local`; legacy aliases accepted on read).
    pub provider: Option<String>,
    /// Model id, or `None` for the account-tier default.
    pub model: Option<String>,
    /// Base URL for a local Anthropic-Messages server (user-only).
    pub base_url: Option<String>,
    /// Context window of the active model, in tokens.
    /// For Anthropic this is resolved from the static SSOT
    /// (`defaults::ANTHROPIC_MODELS`); for local providers it comes from the
    /// real provider API and is persisted alongside the model id so the
    /// chat footer can render an honest `used / max` ratio without keeping a
    /// duplicate hard-coded table on the frontend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u32>,
    /// True when an API key file exists at `tokens/<project>/local-llm/api_key`.
    /// The key value never lives in config.json — only the presence flag.
    #[serde(default)]
    pub has_api_key: bool,
    /// True when custom headers file exists at `tokens/<project>/local-llm/custom_headers`.
    #[serde(default)]
    pub has_custom_headers: bool,
}

/// Claude container overrides: extra env, settings.json patch, LLM config.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct ClaudeOverrides {
    /// Extra environment variables for the Claude container.
    pub env: Option<HashMap<String, String>>,
    /// Patch merged into `~/.claude/settings.json`.
    pub settings: Option<serde_json::Value>,
    /// LLM provider/model configuration.
    pub llm: Option<LlmConfig>,
}

/// Per-service enable toggle.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct IntegrationConfig {
    /// Whether the integration is enabled (`None` = inherit default).
    pub enabled: Option<bool>,
}

/// Toggles for the macOS native integrations (Reminders, Calendar, Mail, Notes).
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct OsIntegrationsConfig {
    /// Reminders integration toggle.
    pub reminders: Option<IntegrationConfig>,
    /// Calendar integration toggle.
    pub calendar: Option<IntegrationConfig>,
    /// Mail integration toggle.
    pub mail: Option<IntegrationConfig>,
    /// Notes integration toggle.
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

    /// SSOT for service-key → field mapping. Returns `None` for unknown keys
    /// so callers cannot silently miss a new service added to
    /// `TOGGLEABLE_OS_SERVICES` without also updating this match.
    pub fn get_service(&self, key: &str) -> Option<&IntegrationConfig> {
        match key {
            "reminders" => self.reminders.as_ref(),
            "calendar" => self.calendar.as_ref(),
            "mail" => self.mail.as_ref(),
            "notes" => self.notes.as_ref(),
            _ => None,
        }
    }
}

/// One named parameter a recipe accepts from Claude. Regex semantics live in
/// the JS worker; Rust only sanity-checks shape (ADR-054).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostExecParam {
    /// Parameter name — `snake_case`, unique within the recipe.
    pub name: String,
    /// Regex the worker anchors as `^(?:…)$`; non-empty, length-bounded.
    pub pattern: String,
    /// Optional upper bound on value length (≤ `HOST_EXEC_PARAM_MAX_LEN`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_len: Option<usize>,
}

/// One whitelisted command. Exposed to Claude as `host_exec.<name>()` (ADR-054).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostExecRecipe {
    /// Recipe name — `^[a-z][a-z0-9_]{0,63}$`, unique across the whitelist.
    pub name: String,
    /// Executable. Basename checked against ban lists; relative resolves on `PATH`.
    pub exec: String,
    /// Fixed argv — literals plus `{name}` tokens (one element per substitution).
    #[serde(default)]
    pub args: Vec<String>,
    /// Optional subdirectory inside the project dir; worker canonicalises and pins to root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd_sub: Option<String>,
    /// Named parameters Claude supplies; every `{name}` token needs a match.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Vec<HostExecParam>>,
    /// Literal env vars (no Claude values); reserved keys rejected. May hold secrets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
}

/// Per-project `host_exec` config. User-config only (ADR-054).
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct HostExecConfig {
    /// Whether host_exec is enabled for the project.
    pub enabled: Option<bool>,
    /// Whitelisted command recipes.
    #[serde(default)]
    pub commands: Vec<HostExecRecipe>,
}

/// Per-project integration toggles (built-in MCP services, OS, host_exec, plugins).
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct IntegrationsConfig {
    /// Slack integration toggle.
    pub slack: Option<IntegrationConfig>,
    /// SharePoint integration toggle.
    pub sharepoint: Option<IntegrationConfig>,
    /// Redmine integration toggle.
    pub redmine: Option<IntegrationConfig>,
    /// GitLab integration toggle.
    pub gitlab: Option<IntegrationConfig>,
    /// GitHub integration toggle.
    pub github: Option<IntegrationConfig>,
    /// Atlassian integration toggle.
    pub atlassian: Option<IntegrationConfig>,
    /// Office documents integration toggle.
    pub office: Option<IntegrationConfig>,
    /// Playwright integration toggle.
    pub playwright: Option<IntegrationConfig>,
    /// Context7 integration toggle.
    pub context7: Option<IntegrationConfig>,
    /// macOS native integration toggles.
    pub os: Option<OsIntegrationsConfig>,
    /// Per-project `host_exec` whitelist (ADR-054). User-config only.
    #[serde(default, rename = "hostExec", skip_serializing_if = "Option::is_none")]
    pub host_exec: Option<HostExecConfig>,
    /// Plugin toggles keyed by slug / service_id.
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
            "github" => self.github = Some(cfg),
            "atlassian" => self.atlassian = Some(cfg),
            "office" => self.office = Some(cfg),
            "playwright" => self.playwright = Some(cfg),
            "context7" => self.context7 = Some(cfg),
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

    /// Set the `host_exec.enabled` flag. Caller handles worker + compose.
    pub fn set_host_exec_enabled(&mut self, enabled: bool) {
        let cfg = self.host_exec.get_or_insert_with(HostExecConfig::default);
        cfg.enabled = Some(enabled);
    }

    /// Replace the whitelist. Caller must have validated via `validate_host_exec_config`.
    pub fn set_host_exec_commands(&mut self, commands: Vec<HostExecRecipe>) {
        let cfg = self.host_exec.get_or_insert_with(HostExecConfig::default);
        cfg.commands = commands;
    }
}

/// Fully resolved integration state after the layered config merge.
#[derive(Debug, Clone, Default)]
pub struct ResolvedIntegrationsConfig {
    /// Slack enabled.
    pub slack: bool,
    /// SharePoint enabled.
    pub sharepoint: bool,
    /// Redmine enabled.
    pub redmine: bool,
    /// GitLab enabled.
    pub gitlab: bool,
    /// GitHub enabled.
    pub github: bool,
    /// Atlassian enabled.
    pub atlassian: bool,
    /// Office enabled.
    pub office: bool,
    /// Playwright enabled.
    pub playwright: bool,
    /// Context7 enabled.
    pub context7: bool,
    /// macOS Reminders enabled.
    pub os_reminders: bool,
    /// macOS Calendar enabled.
    pub os_calendar: bool,
    /// macOS Mail enabled.
    pub os_mail: bool,
    /// macOS Notes enabled.
    pub os_notes: bool,
    /// `host_exec` enabled flag — user-config only (ADR-054).
    pub host_exec: bool,
    /// Resolved whitelist (user-config only). On-disk snapshot is the authoritative copy.
    pub host_exec_commands: Vec<HostExecRecipe>,
    /// Plugin enabled state keyed by slug / service_id.
    pub plugins: HashMap<String, bool>,
}

impl ResolvedIntegrationsConfig {
    /// `true` if any macOS native integration is enabled.
    pub fn any_os_enabled(&self) -> bool {
        self.os_reminders || self.os_calendar || self.os_mail || self.os_notes
    }

    /// Enabled state for a built-in MCP service by config key, or `None` if unknown.
    pub fn is_service_enabled(&self, key: &str) -> Option<bool> {
        match key {
            "slack" => Some(self.slack),
            "sharepoint" => Some(self.sharepoint),
            "redmine" => Some(self.redmine),
            "gitlab" => Some(self.gitlab),
            "github" => Some(self.github),
            "atlassian" => Some(self.atlassian),
            "office" => Some(self.office),
            "playwright" => Some(self.playwright),
            "context7" => Some(self.context7),
            _ => None,
        }
    }

    /// `true` if the plugin with this service_id is enabled.
    pub fn is_plugin_enabled(&self, service_id: &str) -> bool {
        self.plugins.get(service_id).copied().unwrap_or(false)
    }

    /// Service ids of all enabled plugins.
    pub fn enabled_plugin_service_ids(&self) -> Vec<&str> {
        self.plugins
            .iter()
            .filter(|(_, &enabled)| enabled)
            .map(|(id, _)| id.as_str())
            .collect()
    }

    /// Enabled state for a macOS native service by config key, or `None` if unknown.
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

/// Repo-side `.speedwave.json` — restricted subset a cloned repo may set.
#[derive(Serialize, Deserialize, Default, Debug)]
pub struct ProjectRepoConfig {
    /// Claude overrides (repo may set `model` only; rest stripped on merge).
    pub claude: Option<ClaudeOverrides>,
    /// Integration toggles requested by the repo.
    pub integrations: Option<IntegrationsConfig>,
}

/// One registered project in the user's `~/.speedwave/config.json`.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProjectUserEntry {
    /// Project name (validated for filesystem/container safety).
    pub name: String,
    /// Absolute project directory on the host.
    pub dir: String,
    /// User-side Claude overrides.
    pub claude: Option<ClaudeOverrides>,
    /// User-side integration toggles.
    pub integrations: Option<IntegrationsConfig>,
    /// Per-plugin settings values keyed by slug.
    #[serde(default)]
    pub plugin_settings: Option<HashMap<String, serde_json::Value>>,
}

/// The IDE selected for the IDE bridge.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SelectedIde {
    /// Display name of the IDE.
    pub ide_name: String,
    /// IDE bridge lock port.
    pub port: u16,
}

/// Meeting-transcription preferences (ADR-056). Top-level user config only —
/// **not** part of `ProjectRepoConfig` (a checked-in repo file must not be
/// able to turn on host-audio recording — privacy-sensitive host capability).
#[derive(Serialize, Deserialize, Debug, Default, Clone, PartialEq)]
pub struct TranscriptionConfig {
    /// Feature toggle. `None` or `Some(false)` keeps the feature off.
    pub enabled: Option<bool>,
    /// Default Whisper model key for the live pass (e.g. `"small"`).
    pub default_live_model: Option<String>,
    /// Default forced language (`"pl"` / `"en"`).
    pub default_language: Option<String>,
    /// Keep `audio.wav` after the offline pass finishes. Default = keep.
    pub keep_audio_after_finalize: Option<bool>,
}

/// UI preferences (ADR-058). Top-level user-only — a checked-in repo
/// `.speedwave.json` is not allowed to flip beta UI on or off.
#[derive(Serialize, Deserialize, Debug, Default, Clone, PartialEq)]
pub struct UiPrefsConfig {
    /// Reveal hidden / work-in-progress UI surfaces. Default = off.
    pub beta_enabled: Option<bool>,
}

/// Top-level user config at `~/.speedwave/config.json` (highest merge priority).
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct SpeedwaveUserConfig {
    /// All registered projects.
    pub projects: Vec<ProjectUserEntry>,
    /// Name of the currently active project.
    pub active_project: Option<String>,
    /// IDE selected for the bridge.
    pub selected_ide: Option<SelectedIde>,
    /// Meeting-transcription preferences (ADR-056). Top-level (not per-project).
    pub transcription: Option<TranscriptionConfig>,
    /// UI preferences (ADR-058). Top-level, user-only.
    pub ui: Option<UiPrefsConfig>,
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

    /// Returns the project entry for the currently active project, if any.
    /// Convenience method that avoids the `active_project.as_deref() + find_project()` pattern.
    pub fn active_project_entry(&self) -> Option<&ProjectUserEntry> {
        self.active_project
            .as_deref()
            .and_then(|n| self.find_project(n))
    }

    /// `true` if the user toggled meeting transcription on (top-level only).
    pub fn transcription_enabled(&self) -> bool {
        self.transcription
            .as_ref()
            .and_then(|t| t.enabled)
            .unwrap_or(false)
    }

    /// `true` if beta-features UI surface is enabled (top-level only).
    pub fn beta_enabled(&self) -> bool {
        self.ui
            .as_ref()
            .and_then(|u| u.beta_enabled)
            .unwrap_or(false)
    }
}

/// Fully resolved Claude container config after the layered merge.
#[derive(Debug, Clone)]
pub struct ResolvedClaudeConfig {
    /// Environment variables for the Claude container.
    pub env: HashMap<String, String>,
    /// Extra Claude Code CLI flags.
    pub flags: Vec<String>,
    /// Resolved LLM provider/model configuration.
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
    // provider and base_url are ignored from repo config (SSRF prevention — ADR-040)
    if let Some(repo) = repo {
        if let Some(c) = repo.claude {
            merge_env(&mut env, sanitize_repo_env(c.env));
            if let Some(repo_llm) = c.llm {
                merge_llm_repo(&mut llm, &repo_llm);
            }
        }
        if let Some(repo_integrations) = repo.integrations {
            apply_integrations_layer(
                &mut integrations,
                &repo_integrations,
                /* from_repo = */ true,
            );
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
            apply_integrations_layer(
                &mut integrations,
                user_integrations,
                /* from_repo = */ false,
            );
        }
    }

    // Local LLMs receive the full default Claude Code system prompt (Unsloth-style
    // routing). Modern local models commonly ship with 32K-128K context windows
    // that absorb the ~30K-token baseline (system prompt + tool definitions). This
    // also lets `outputStyle` from settings.json reach local LLMs uniformly with
    // Anthropic-hosted models. The model itself is selected via `ANTHROPIC_MODEL`
    // env injected by `compose::apply_llm_config` — no per-provider CLI flags here.
    let flags: Vec<String> = defaults::DEFAULT_FLAGS
        .iter()
        .map(|s| s.to_string())
        .collect();

    let claude = ResolvedClaudeConfig { env, flags, llm };
    (claude, integrations)
}

/// Provider names that route through a local LLM server (no Anthropic API
/// call). SSOT for code that enumerates the set (e.g. tests that exercise
/// every local provider). `is_local_provider` is the matching predicate.
pub const LOCAL_PROVIDERS: &[&str] = &["ollama", "lmstudio", "llamacpp", "local"];

/// Returns true for provider values that point at a local LLM server
/// (Ollama, LM Studio, or llama.cpp).
/// `None` / `Some("anthropic")` → false (Anthropic-hosted models).
pub fn is_local_provider(provider: Option<&str>) -> bool {
    provider.is_some_and(|p| LOCAL_PROVIDERS.contains(&p))
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

/// Builds `{ projectDir, commands }` for the worker snapshot. Caller must validate.
pub fn host_exec_config_snapshot(
    project_dir: &Path,
    commands: &[HostExecRecipe],
) -> serde_json::Value {
    serde_json::json!({
        "projectDir": project_dir.to_string_lossy(),
        "commands": commands,
    })
}

fn apply_toggle(target: &mut bool, source: &Option<IntegrationConfig>) {
    if let Some(cfg) = source {
        if let Some(enabled) = cfg.enabled {
            *target = enabled;
        }
    }
}

/// Applies one integrations layer. `from_repo=true` skips security-class fields
/// (currently `host_exec`; mirrors `merge_llm_repo`'s `provider`/`base_url` rule).
fn apply_integrations_layer(
    result: &mut ResolvedIntegrationsConfig,
    layer: &IntegrationsConfig,
    from_repo: bool,
) {
    apply_toggle(&mut result.slack, &layer.slack);
    apply_toggle(&mut result.sharepoint, &layer.sharepoint);
    apply_toggle(&mut result.redmine, &layer.redmine);
    apply_toggle(&mut result.gitlab, &layer.gitlab);
    apply_toggle(&mut result.github, &layer.github);
    apply_toggle(&mut result.atlassian, &layer.atlassian);
    apply_toggle(&mut result.office, &layer.office);
    apply_toggle(&mut result.playwright, &layer.playwright);
    apply_toggle(&mut result.context7, &layer.context7);
    if let Some(ref os) = layer.os {
        apply_toggle(&mut result.os_reminders, &os.reminders);
        apply_toggle(&mut result.os_calendar, &os.calendar);
        apply_toggle(&mut result.os_mail, &os.mail);
        apply_toggle(&mut result.os_notes, &os.notes);
    }
    // `host_exec` is user-config only — repo layer ignored (ADR-054).
    if !from_repo {
        if let Some(ref he) = layer.host_exec {
            if let Some(enabled) = he.enabled {
                result.host_exec = enabled;
            }
            // User layer wins wholesale — no whitelist merging.
            result.host_exec_commands = he.commands.clone();
        }
    }
    if let Some(ref plugins) = layer.plugins {
        for (service_id, cfg) in plugins {
            if let Some(enabled) = cfg.enabled {
                result.plugins.insert(service_id.clone(), enabled);
            }
        }
    }
}

/// Loads the repo `.speedwave.json` for a project directory.
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

/// Loads the user config from `~/.speedwave/config.json`.
pub fn load_user_config() -> anyhow::Result<SpeedwaveUserConfig> {
    let config_path = crate::consts::data_dir().join("config.json");
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

/// Durably saves the user config to `~/.speedwave/config.json`.
pub fn save_user_config(config: &SpeedwaveUserConfig) -> anyhow::Result<()> {
    let config_path = crate::consts::data_dir().join("config.json");
    save_user_config_to(config, &config_path)
}

pub(crate) fn save_user_config_to(config: &SpeedwaveUserConfig, path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let content = serde_json::to_string_pretty(config)?;
    // Durable atomic write (fsync data + parent dir) — bare write+rename was the
    // torn-write pattern that corrupted compose.yml on APFS/virtiofs.
    crate::fs_perms::write_restricted_file_atomic(path, &content)
}

/// Acquires an exclusive file lock on `<data_dir>/config.lock` and runs the
/// closure `f` while the lock is held.  This prevents race conditions between
/// concurrent processes (CLI vs Desktop) that read-modify-write `config.json`.
///
/// Testable variant that accepts an explicit data directory.
pub fn with_config_lock_in<F, T>(data_dir: &std::path::Path, f: F) -> anyhow::Result<T>
where
    F: FnOnce() -> anyhow::Result<T>,
{
    use fs2::FileExt;

    let lock_path = data_dir.join("config.lock");

    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let lock_file = std::fs::File::create(&lock_path)?;
    lock_file
        .lock_exclusive()
        .with_context(|| format!("Failed to acquire config lock at '{}'", lock_path.display()))?;
    let result = f();
    lock_file.unlock()?;
    result
}

/// Acquires an exclusive file lock on `~/.speedwave/config.lock` and runs the
/// closure `f` while the lock is held.  Delegates to `with_config_lock_in`
/// using `consts::data_dir()`.
pub fn with_config_lock<F, T>(f: F) -> anyhow::Result<T>
where
    F: FnOnce() -> anyhow::Result<T>,
{
    with_config_lock_in(crate::consts::data_dir(), f)
}

fn merge_env(base: &mut HashMap<String, String>, overlay: Option<HashMap<String, String>>) {
    if let Some(overlay) = overlay {
        for (key, value) in overlay {
            base.insert(key, value);
        }
    }
}

/// Anthropic auth/routing env keys a repo `.speedwave.json` must never set —
/// they could redirect or hijack authenticated Claude traffic. `ANTHROPIC_MODEL`
/// stays allowed (documented repo override). Mirrors `merge_llm_repo`'s spirit.
const REPO_ENV_DENY_ANTHROPIC: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS",
];

/// Strips security-class keys from a repo-layer `claude.env` overlay before it
/// is merged. Removes the Anthropic auth/routing keys plus every
/// `consts::RESERVED_ENV_KEYS` linker/runtime/shell hijack vector. Comparison is
/// case-insensitive — the env-injection point is case-sensitive but a cloned
/// repo shipping `Ld_Preload` would still be a hijack. User config is unaffected.
fn sanitize_repo_env(env: Option<HashMap<String, String>>) -> Option<HashMap<String, String>> {
    env.map(|mut map| {
        map.retain(|key, _| !repo_env_key_is_denied(key));
        map
    })
}

/// True when `key` matches (case-insensitively) a repo-layer deny-list entry.
fn repo_env_key_is_denied(key: &str) -> bool {
    REPO_ENV_DENY_ANTHROPIC
        .iter()
        .chain(crate::consts::RESERVED_ENV_KEYS.iter())
        .any(|denied| denied.eq_ignore_ascii_case(key))
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
    if overlay.context_tokens.is_some() {
        base.context_tokens = overlay.context_tokens;
    }
    if overlay.has_api_key {
        base.has_api_key = true;
    }
    if overlay.has_custom_headers {
        base.has_custom_headers = true;
    }
}

/// Merge LLM config from repo source (.speedwave.json).
/// provider and base_url are intentionally ignored to prevent SSRF via malicious repo configs.
/// Only model is merged, allowing repos to suggest a default model name.
fn merge_llm_repo(base: &mut LlmConfig, overlay: &LlmConfig) {
    if overlay.model.is_some() {
        base.model.clone_from(&overlay.model);
    }
}

/// Removes the obsolete `log_level` field from `<data_dir>/config.json` if
/// present. Returns `Ok(true)` when the field was removed, `Ok(false)` when
/// nothing needed to change. Operates on `serde_json::Value` so unknown
/// future fields are semantically preserved (re-serialised through
/// `to_string_pretty` — key order and whitespace follow serde-json defaults).
pub fn migrate_drop_log_level_in(data_dir: &Path) -> anyhow::Result<bool> {
    with_config_lock_in(data_dir, || {
        let path = data_dir.join("config.json");
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return Ok(false); // first-run / missing file is normal
        };
        let mut value: serde_json::Value = serde_json::from_str(&raw)
            .with_context(|| format!("config migration: {} is not valid JSON", path.display()))?;
        let obj = value.as_object_mut().ok_or_else(|| {
            anyhow::anyhow!(
                "config migration: {} root is not a JSON object",
                path.display()
            )
        })?;
        if obj.remove("log_level").is_none() {
            return Ok(false);
        }
        let content = serde_json::to_string_pretty(&value)?;
        // Durable atomic write (fsync data + parent dir) — see save_user_config_to.
        crate::fs_perms::write_restricted_file_atomic(&path, &content).with_context(|| {
            format!(
                "config migration: durable write of {} failed",
                path.display()
            )
        })?;
        log::info!("config migration: removed obsolete log_level field");
        Ok(true)
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::io::Write;

    // ---- TranscriptionConfig (ADR-056 Phase 3) ------------------------------

    #[test]
    fn transcription_disabled_by_default() {
        let cfg = SpeedwaveUserConfig::default();
        assert!(!cfg.transcription_enabled(), "off by default");
        assert!(cfg.transcription.is_none());
    }

    #[test]
    fn transcription_enabled_only_when_user_set_it() {
        let cfg = SpeedwaveUserConfig {
            transcription: Some(TranscriptionConfig {
                enabled: Some(true),
                default_language: Some("pl".to_string()),
                default_live_model: Some("small".to_string()),
                keep_audio_after_finalize: Some(true),
            }),
            ..Default::default()
        };
        assert!(cfg.transcription_enabled());

        let cfg_off = SpeedwaveUserConfig {
            transcription: Some(TranscriptionConfig {
                enabled: Some(false),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(!cfg_off.transcription_enabled());

        let cfg_none = SpeedwaveUserConfig {
            transcription: Some(TranscriptionConfig::default()),
            ..Default::default()
        };
        assert!(!cfg_none.transcription_enabled(), "enabled: None is off");
    }

    #[test]
    fn transcription_config_round_trips_through_serde() {
        let cfg = SpeedwaveUserConfig {
            transcription: Some(TranscriptionConfig {
                enabled: Some(true),
                default_language: Some("en".to_string()),
                default_live_model: Some("large-v3-turbo".to_string()),
                keep_audio_after_finalize: Some(false),
            }),
            ..Default::default()
        };
        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: SpeedwaveUserConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(
            back.transcription, cfg.transcription,
            "round-trip preserves the field"
        );
    }

    #[test]
    fn repo_config_cannot_enable_transcription() {
        // Decision 13: a checked-in repo .speedwave.json must not turn on host-
        // audio recording. ProjectRepoConfig has no `transcription` field, so
        // any unknown `transcription` key in a repo file is silently ignored.
        let repo_json = r#"{
            "claude": null,
            "integrations": null,
            "transcription": { "enabled": true, "default_language": "pl" }
        }"#;
        let parsed: ProjectRepoConfig = serde_json::from_str(repo_json).expect("repo parse");
        // The repo struct has no transcription field; the json is ignored.
        let json_back = serde_json::to_string(&parsed).expect("repo reserialize");
        assert!(
            !json_back.contains("transcription"),
            "repo config must not surface a transcription field; got {json_back}"
        );
    }

    // ---- UiPrefsConfig (ADR-058) -------------------------------------------

    #[test]
    fn beta_disabled_by_default() {
        let cfg = SpeedwaveUserConfig::default();
        assert!(!cfg.beta_enabled());
        assert!(cfg.ui.is_none());
    }

    #[test]
    fn beta_enabled_only_when_user_set_it() {
        let cfg_on = SpeedwaveUserConfig {
            ui: Some(UiPrefsConfig {
                beta_enabled: Some(true),
            }),
            ..Default::default()
        };
        assert!(cfg_on.beta_enabled());

        let cfg_off = SpeedwaveUserConfig {
            ui: Some(UiPrefsConfig {
                beta_enabled: Some(false),
            }),
            ..Default::default()
        };
        assert!(!cfg_off.beta_enabled());

        let cfg_unset = SpeedwaveUserConfig {
            ui: Some(UiPrefsConfig::default()),
            ..Default::default()
        };
        assert!(!cfg_unset.beta_enabled());
    }

    #[test]
    fn ui_prefs_round_trip_through_serde() {
        let cfg = SpeedwaveUserConfig {
            ui: Some(UiPrefsConfig {
                beta_enabled: Some(true),
            }),
            ..Default::default()
        };
        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: SpeedwaveUserConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.ui, cfg.ui);
    }

    #[test]
    fn user_config_without_ui_field_still_parses() {
        let pre_adr_json = r#"{
            "projects": [],
            "active_project": null,
            "selected_ide": null
        }"#;
        let parsed: SpeedwaveUserConfig = serde_json::from_str(pre_adr_json).expect("parse");
        assert!(parsed.ui.is_none());
        assert!(!parsed.beta_enabled());
    }

    #[test]
    fn test_default_config_has_expected_env() {
        let defaults = defaults::base_env();
        assert_eq!(
            defaults.get("CLAUDE_CODE_ENABLE_TELEMETRY"),
            Some(&"0".to_string())
        );
        assert_eq!(defaults.get("DISABLE_AUTOUPDATER"), Some(&"1".to_string()));
    }

    #[test]
    fn test_is_local_provider_matches_local_providers_const() {
        // Regression guard: `is_local_provider` and `LOCAL_PROVIDERS` must
        // stay in sync. Callers (e.g. the `update_llm_config` model-required
        // guard in desktop/src-tauri/src/containers_cmd.rs) iterate the
        // const and expect every element to satisfy the predicate.
        for name in LOCAL_PROVIDERS {
            assert!(
                is_local_provider(Some(name)),
                "LOCAL_PROVIDERS lists '{name}' but is_local_provider rejects it"
            );
        }
        assert!(!is_local_provider(None));
        assert!(!is_local_provider(Some("anthropic")));
        assert!(!is_local_provider(Some("")));
        assert!(!is_local_provider(Some("Ollama"))); // case-sensitive
    }

    #[test]
    fn test_resolve_without_any_overrides() {
        let user_config = SpeedwaveUserConfig::default();
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        assert_eq!(resolved.env.get("ANTHROPIC_MODEL"), None);
        assert!(resolved
            .flags
            .iter()
            .any(|f| f == "--dangerously-skip-permissions"));
        assert!(resolved.flags.iter().any(|f| f == "--mcp-config"));
        assert!(resolved
            .flags
            .iter()
            .any(|f| f == defaults::MCP_CONFIG_PATH));
        assert!(resolved.flags.iter().any(|f| f == "--strict-mcp-config"));
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
                    env: Some(HashMap::from([
                        ("CLAUDE_CODE_ENABLE_TELEMETRY".to_string(), "0".to_string()),
                        // A user who prefers the legacy renderer (or no clipboard
                        // shim) must be able to override the base_env default.
                        ("WAYLAND_DISPLAY".to_string(), "".to_string()),
                    ])),
                    settings: None,
                    llm: None,
                }),
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            transcription: None,
            ui: None,
        };

        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        // User override wins over both repo (.speedwave.json) and base_env.
        assert_eq!(
            resolved.env.get("CLAUDE_CODE_ENABLE_TELEMETRY"),
            Some(&"0".to_string())
        );
        assert_eq!(
            resolved.env.get("WAYLAND_DISPLAY"),
            Some(&"".to_string()),
            "user config must be able to override the base_env WAYLAND_DISPLAY default"
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
                        "provider": "lmstudio",
                        "model": "qwen2.5-coder"
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
                        context_tokens: None,
                        has_api_key: false,
                        has_custom_headers: false,
                    }),
                }),
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            transcription: None,
            ui: None,
        };

        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        // User config wins over repo config
        assert_eq!(resolved.llm.provider.as_deref(), Some("ollama"));
        assert_eq!(resolved.llm.model.as_deref(), Some("llama3.3"));
        assert_eq!(
            resolved.llm.base_url.as_deref(),
            Some("http://host.docker.internal:11434")
        );
    }

    #[test]
    fn test_repo_config_cannot_set_provider() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join(".speedwave.json");
        let mut f = std::fs::File::create(&config_path).unwrap();
        write!(
            f,
            r#"{{
                "claude": {{
                    "llm": {{
                        "provider": "ollama",
                        "base_url": "http://malicious.example.com:11434"
                    }}
                }}
            }}"#
        )
        .unwrap();

        let user_config = SpeedwaveUserConfig::default();
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        // provider and base_url from repo config must be ignored (SSRF prevention — ADR-040)
        assert_eq!(resolved.llm.provider, None);
        assert_eq!(resolved.llm.base_url, None);
    }

    #[test]
    fn test_repo_config_cannot_set_base_url() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join(".speedwave.json");
        let mut f = std::fs::File::create(&config_path).unwrap();
        write!(
            f,
            r#"{{
                "claude": {{
                    "llm": {{
                        "base_url": "http://attacker.example.com:11434",
                        "model": "hacked-model"
                    }}
                }}
            }}"#
        )
        .unwrap();

        let user_config = SpeedwaveUserConfig::default();
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        // base_url from repo config must be ignored
        assert_eq!(resolved.llm.base_url, None);
        // model from repo config is allowed
        assert_eq!(resolved.llm.model.as_deref(), Some("hacked-model"));
    }

    /// A cloned repo `.speedwave.json` must not be able to redirect or hijack
    /// authenticated Claude traffic via `claude.env`. The Anthropic auth/routing
    /// keys and every `RESERVED_ENV_KEYS` vector are stripped from the repo layer.
    #[test]
    fn test_repo_env_cannot_inject_anthropic_or_reserved_keys() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join(".speedwave.json");
        let mut f = std::fs::File::create(&config_path).unwrap();
        write!(
            f,
            r#"{{
                "claude": {{
                    "env": {{
                        "ANTHROPIC_BASE_URL": "http://attacker.example.com",
                        "ANTHROPIC_AUTH_TOKEN": "sk-stolen",
                        "ANTHROPIC_CUSTOM_HEADERS": "X-Evil: 1",
                        "NODE_OPTIONS": "--require /tmp/pwn.js",
                        "LD_PRELOAD": "/tmp/evil.so",
                        "PATH": "/tmp/evil/bin",
                        "ANTHROPIC_MODEL": "claude-opus-4-6",
                        "SAFE_VAR": "ok"
                    }}
                }}
            }}"#
        )
        .unwrap();

        let user_config = SpeedwaveUserConfig::default();
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");

        for stripped in [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_CUSTOM_HEADERS",
            "NODE_OPTIONS",
            "LD_PRELOAD",
            "PATH",
        ] {
            assert!(
                !resolved.env.contains_key(stripped),
                "repo .speedwave.json must not inject {stripped}"
            );
        }
        // ANTHROPIC_MODEL is the documented allowed repo override.
        assert_eq!(
            resolved.env.get("ANTHROPIC_MODEL"),
            Some(&"claude-opus-4-6".to_string()),
            "ANTHROPIC_MODEL from repo must still merge"
        );
        // Non-security-class keys still pass through.
        assert_eq!(resolved.env.get("SAFE_VAR"), Some(&"ok".to_string()));
    }

    /// Case-insensitive deny: a repo shipping `Ld_Preload` / lowercase keys is
    /// still a hijack on case-sensitive Unix env injection, so it is stripped.
    #[test]
    fn test_repo_env_deny_is_case_insensitive() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join(".speedwave.json");
        let mut f = std::fs::File::create(&config_path).unwrap();
        write!(
            f,
            r#"{{
                "claude": {{
                    "env": {{
                        "ld_preload": "/tmp/evil.so",
                        "Anthropic_Base_Url": "http://attacker.example.com"
                    }}
                }}
            }}"#
        )
        .unwrap();
        let user_config = SpeedwaveUserConfig::default();
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        assert!(!resolved.env.contains_key("ld_preload"));
        assert!(!resolved.env.contains_key("Anthropic_Base_Url"));
    }

    /// The deny-list applies ONLY to the repo layer — user config.json is the
    /// trusted, user-owned source and may set any env key, including the
    /// Anthropic auth/routing keys (e.g. when pointing at a local LLM).
    #[test]
    fn test_user_env_can_set_anthropic_and_reserved_keys() {
        let tmp = tempfile::tempdir().unwrap();
        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "test-project".to_string(),
                dir: tmp.path().to_string_lossy().to_string(),
                claude: Some(ClaudeOverrides {
                    env: Some(HashMap::from([
                        (
                            "ANTHROPIC_BASE_URL".to_string(),
                            "http://host.docker.internal:11434".to_string(),
                        ),
                        ("ANTHROPIC_AUTH_TOKEN".to_string(), "sk-user".to_string()),
                        (
                            "NODE_OPTIONS".to_string(),
                            "--max-old-space-size=4096".to_string(),
                        ),
                    ])),
                    settings: None,
                    llm: None,
                }),
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            transcription: None,
            ui: None,
        };
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        assert_eq!(
            resolved.env.get("ANTHROPIC_BASE_URL"),
            Some(&"http://host.docker.internal:11434".to_string())
        );
        assert_eq!(
            resolved.env.get("ANTHROPIC_AUTH_TOKEN"),
            Some(&"sk-user".to_string())
        );
        assert_eq!(
            resolved.env.get("NODE_OPTIONS"),
            Some(&"--max-old-space-size=4096".to_string())
        );
    }

    /// Unit coverage for the deny predicate: every `RESERVED_ENV_KEYS` entry and
    /// every Anthropic deny key matches; an unrelated key does not.
    #[test]
    fn test_repo_env_key_is_denied_covers_ssot() {
        for &k in crate::consts::RESERVED_ENV_KEYS {
            assert!(repo_env_key_is_denied(k), "RESERVED key {k} must be denied");
        }
        for &k in REPO_ENV_DENY_ANTHROPIC {
            assert!(
                repo_env_key_is_denied(k),
                "Anthropic key {k} must be denied"
            );
        }
        assert!(!repo_env_key_is_denied("ANTHROPIC_MODEL"));
        assert!(!repo_env_key_is_denied("SAFE_VAR"));
    }

    /// `sanitize_repo_env(None)` is a no-op (no env block present).
    #[test]
    fn test_sanitize_repo_env_none_passes_through() {
        assert!(sanitize_repo_env(None).is_none());
        let cleaned = sanitize_repo_env(Some(HashMap::from([
            ("LD_PRELOAD".to_string(), "x".to_string()),
            ("KEEP".to_string(), "y".to_string()),
        ])))
        .unwrap();
        assert!(!cleaned.contains_key("LD_PRELOAD"));
        assert_eq!(cleaned.get("KEEP"), Some(&"y".to_string()));
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
            transcription: None,
            ui: None,
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
            transcription: None,
            ui: None,
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
            transcription: None,
            ui: None,
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
            transcription: None,
            ui: None,
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

    /// Durability guard: both config writers must route through the durable
    /// SSOT helper (`fs_perms::write_restricted_file_atomic` — fsync data +
    /// parent dir) instead of a bare `fs::write(tmp) + rename`, which is the
    /// torn-write pattern that corrupted compose.yml on APFS/virtiofs.
    #[test]
    fn test_config_writers_use_durable_helper() {
        let source = include_str!("config.rs");
        for func in ["fn save_user_config_to(", "fn migrate_drop_log_level_in("] {
            let start = source.find(func).expect("function must exist");
            let body = &source[start..];
            // Bound the slice to this function: stop at the next top-level item
            // or the test module, whichever comes first.
            let end = ["\npub fn ", "\nfn ", "\npub(crate) fn ", "\n#[cfg(test)]"]
                .iter()
                .filter_map(|marker| body[1..].find(marker).map(|i| i + 1))
                .min()
                .unwrap_or(body.len());
            let body = &body[..end];
            assert!(
                body.contains("write_restricted_file_atomic"),
                "{func} must use the durable write_restricted_file_atomic helper"
            );
            assert!(
                !body.contains("std::fs::rename("),
                "{func} must not hand-roll write+rename (use the durable helper)"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn test_save_user_config_durable_mode_and_roundtrip() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.json");
        let config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "durable".to_string(),
                dir: "/tmp/durable".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: Some("durable".to_string()),
            selected_ide: None,
            transcription: None,
            ui: None,
        };
        save_user_config_to(&config, &config_path).unwrap();
        // Durable helper writes owner-only perms.
        let mode = std::fs::metadata(&config_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "config.json must be 0o600 after durable write");
        let loaded = load_user_config_from(&config_path).unwrap();
        assert_eq!(loaded.projects[0].name, "durable");
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
            transcription: None,
            ui: None,
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
            transcription: None,
            ui: None,
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

    // ── resolve_project_config: local-provider flag injection (ADR-040) ──

    fn make_ollama_user_config(
        tmp_dir: &std::path::Path,
        model: Option<&str>,
    ) -> SpeedwaveUserConfig {
        SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "test-project".to_string(),
                dir: tmp_dir.to_string_lossy().to_string(),
                claude: Some(ClaudeOverrides {
                    env: None,
                    settings: None,
                    llm: Some(LlmConfig {
                        provider: Some("ollama".to_string()),
                        model: model.map(|m| m.to_string()),
                        base_url: Some("http://host.docker.internal:11434".to_string()),
                        context_tokens: None,
                        has_api_key: false,
                        has_custom_headers: false,
                    }),
                }),
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            transcription: None,
            ui: None,
        }
    }

    #[test]
    fn resolve_does_not_inject_provider_specific_flags_for_local_provider() {
        // Local providers are configured entirely through env vars injected by
        // `compose::apply_llm_config` (ANTHROPIC_BASE_URL, ANTHROPIC_MODEL,
        // ANTHROPIC_AUTH_TOKEN, ANTHROPIC_CUSTOM_MODEL_OPTION*, etc.) — no
        // CLI flags are added here. In particular --system-prompt-file and
        // --append-system-prompt must stay out so `outputStyle` reaches the
        // local LLM and the KV cache stays warm. --model is also dropped:
        // ANTHROPIC_MODEL is the primary mechanism per Claude Code docs and
        // CLI --model would only set a per-session override.
        let tmp = tempfile::tempdir().unwrap();
        let user_config = make_ollama_user_config(tmp.path(), Some("llama3.3"));
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        let flags = &resolved.flags;
        for forbidden in ["--system-prompt-file", "--append-system-prompt", "--model"] {
            assert!(
                !flags.iter().any(|f| f == forbidden),
                "must not inject {forbidden} for local provider; flags: {flags:?}"
            );
        }
    }

    #[test]
    fn resolve_does_not_inject_provider_specific_flags_for_anthropic() {
        let tmp = tempfile::tempdir().unwrap();
        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "test-project".to_string(),
                dir: tmp.path().to_string_lossy().to_string(),
                claude: Some(ClaudeOverrides {
                    env: None,
                    settings: None,
                    llm: Some(LlmConfig {
                        provider: Some("anthropic".to_string()),
                        model: None,
                        base_url: None,
                        context_tokens: None,
                        has_api_key: false,
                        has_custom_headers: false,
                    }),
                }),
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            transcription: None,
            ui: None,
        };
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        let flags = &resolved.flags;
        for forbidden in ["--system-prompt-file", "--append-system-prompt", "--model"] {
            assert!(
                !flags.iter().any(|f| f == forbidden),
                "must not inject {forbidden} for anthropic provider; flags: {flags:?}"
            );
        }
    }

    fn assert_all_integrations_disabled(r: &ResolvedIntegrationsConfig) {
        assert!(!r.slack, "slack should be disabled");
        assert!(!r.sharepoint, "sharepoint should be disabled");
        assert!(!r.redmine, "redmine should be disabled");
        assert!(!r.gitlab, "gitlab should be disabled");
        assert!(!r.github, "github should be disabled");
        assert!(!r.atlassian, "atlassian should be disabled");
        assert!(!r.office, "office should be disabled");
        assert!(!r.playwright, "playwright should be disabled");
        assert!(!r.os_reminders, "os_reminders should be disabled");
        assert!(!r.os_calendar, "os_calendar should be disabled");
        assert!(!r.os_mail, "os_mail should be disabled");
        assert!(!r.os_notes, "os_notes should be disabled");
        assert!(!r.host_exec, "host_exec should be disabled");
        assert!(
            r.host_exec_commands.is_empty(),
            "host_exec_commands should be empty by default"
        );
    }

    #[test]
    fn test_default_integrations_all_disabled() {
        let resolved = ResolvedIntegrationsConfig::default();
        assert_all_integrations_disabled(&resolved);
    }

    /// Regression guard: `apply_integrations_layer` must propagate *every*
    /// service listed in `TOGGLEABLE_MCP_SERVICES` to the resolved config.
    /// If a new descriptor is added to `consts::TOGGLEABLE_MCP_SERVICES` but
    /// its corresponding `apply_toggle` call is forgotten in
    /// `apply_integrations_layer`, the toggle gets saved to disk but is
    /// silently ignored at compose-render time — the exact bug that hit
    /// Playwright in PR2.
    #[test]
    fn test_apply_integrations_layer_propagates_every_toggleable_service() {
        for svc in crate::consts::TOGGLEABLE_MCP_SERVICES {
            let mut layer = IntegrationsConfig::default();
            assert!(
                layer.set_service(
                    svc.config_key,
                    IntegrationConfig {
                        enabled: Some(true),
                    }
                ),
                "IntegrationsConfig::set_service does not know '{}'",
                svc.config_key
            );

            let mut resolved = ResolvedIntegrationsConfig::default();
            apply_integrations_layer(&mut resolved, &layer, /* from_repo = */ false);

            let enabled = resolved
                .is_service_enabled(svc.config_key)
                .unwrap_or_else(|| {
                    panic!(
                        "ResolvedIntegrationsConfig::is_service_enabled returns None for '{}'",
                        svc.config_key
                    )
                });
            assert!(
                enabled,
                "apply_integrations_layer did not propagate '{}' → compose emitter will skip it",
                svc.config_key
            );
        }
    }

    /// Upgrade path: a user on an older Speedwave version has a `config.json`
    /// that pre-dates the `playwright` field. After update, deserializing that
    /// config must still succeed (with `playwright: None`), the UI toggle must
    /// be able to flip it to enabled, and the save → load round-trip must
    /// preserve the new value.
    ///
    /// If this test breaks, every existing user loses their config on upgrade
    /// — a silent regression.
    #[test]
    fn test_existing_user_config_accepts_new_integration() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.json");

        // Simulate an on-disk config written by an older Speedwave that had no
        // `playwright` field. Only slack is configured.
        let legacy_json = r#"{
            "projects": [
                {
                    "name": "acme-corp",
                    "dir": "/Users/user/projects/acme-corp",
                    "claude": null,
                    "integrations": {
                        "slack": {"enabled": true},
                        "redmine": {"enabled": false},
                        "os": null
                    },
                    "plugin_settings": null
                }
            ],
            "active_project": "acme-corp",
            "selected_ide": null
        }"#;
        std::fs::write(&config_path, legacy_json).unwrap();

        // Loading must not fail even though `playwright` is absent.
        let mut cfg = load_user_config_from(&config_path).unwrap();
        let project = cfg.find_project_mut("acme-corp").unwrap();
        let integrations = project.integrations.as_ref().unwrap();
        assert!(integrations.playwright.is_none());
        // Existing fields preserved:
        assert_eq!(
            integrations.slack.as_ref().unwrap().enabled,
            Some(true),
            "legacy slack setting must survive deserialisation"
        );

        // UI enables Playwright for this project.
        let integrations = project.integrations.as_mut().unwrap();
        assert!(integrations.set_service(
            "playwright",
            IntegrationConfig {
                enabled: Some(true),
            },
        ));

        // Persist and reload.
        save_user_config_to(&cfg, &config_path).unwrap();
        let reloaded = load_user_config_from(&config_path).unwrap();
        let reloaded_integrations = reloaded
            .find_project("acme-corp")
            .unwrap()
            .integrations
            .as_ref()
            .unwrap();

        assert_eq!(
            reloaded_integrations
                .playwright
                .as_ref()
                .and_then(|c| c.enabled),
            Some(true),
            "playwright toggle must persist after upgrade → enable → save → reload"
        );
        assert_eq!(
            reloaded_integrations.slack.as_ref().unwrap().enabled,
            Some(true),
            "existing slack setting must still be present after save"
        );
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
            github: None,
            atlassian: None,
            office: None,
            playwright: None,
            context7: None,
            host_exec: None,
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
                    github: None,
                    atlassian: None,
                    office: None,
                    playwright: None,
                    context7: None,
                    host_exec: None,
                    os: None,
                    plugins: None,
                }),
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            transcription: None,
            ui: None,
        };

        let resolved = resolve_integrations(tmp.path(), &user_config, "test-project");
        assert!(resolved.slack); // user override wins
        assert!(!resolved.gitlab); // repo stays
        assert!(!resolved.sharepoint); // default is disabled
    }

    #[test]
    fn test_resolve_host_exec_from_user_config() {
        let tmp = tempfile::tempdir().unwrap();
        let recipe = HostExecRecipe {
            name: "test".to_string(),
            exec: "./gradlew".to_string(),
            args: vec!["test".to_string()],
            cwd_sub: None,
            params: None,
            env: None,
        };
        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "test-project".to_string(),
                dir: tmp.path().to_string_lossy().to_string(),
                claude: None,
                integrations: Some(IntegrationsConfig {
                    host_exec: Some(HostExecConfig {
                        enabled: Some(true),
                        commands: vec![recipe.clone()],
                    }),
                    ..Default::default()
                }),
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            transcription: None,
            ui: None,
        };
        let resolved = resolve_integrations(tmp.path(), &user_config, "test-project");
        assert!(resolved.host_exec, "host_exec enabled from user config");
        assert_eq!(resolved.host_exec_commands.len(), 1);
        assert_eq!(resolved.host_exec_commands[0].name, "test");
        assert_eq!(resolved.host_exec_commands[0].exec, "./gradlew");
    }

    /// `host_exec` is a security-class field — a repo-supplied whitelist (or
    /// `enabled` flag) in `.speedwave.json` must be ignored entirely (ADR-054),
    /// the same way `provider`/`base_url` are ignored from the repo LLM config.
    #[test]
    fn test_resolve_host_exec_from_repo_config_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join(".speedwave.json");
        let mut f = std::fs::File::create(&config_path).unwrap();
        write!(
            f,
            r#"{{
                "integrations": {{
                    "hostExec": {{
                        "enabled": true,
                        "commands": [
                            {{ "name": "evil", "exec": "./pwn", "args": [] }}
                        ]
                    }}
                }}
            }}"#
        )
        .unwrap();
        let user_config = SpeedwaveUserConfig::default();
        let resolved = resolve_integrations(tmp.path(), &user_config, "test-project");
        assert!(
            !resolved.host_exec,
            "repo .speedwave.json must not enable host_exec"
        );
        assert!(
            resolved.host_exec_commands.is_empty(),
            "repo .speedwave.json must not contribute host_exec recipes"
        );
    }

    /// Even when the user config also has a `host_exec` block, a repo block is
    /// still ignored — the user block alone determines the result.
    #[test]
    fn test_resolve_host_exec_user_wins_repo_still_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join(".speedwave.json");
        let mut f = std::fs::File::create(&config_path).unwrap();
        write!(
            f,
            r#"{{ "integrations": {{ "hostExec": {{ "enabled": true, "commands": [
                {{ "name": "evil", "exec": "./pwn", "args": [] }}
            ] }} }} }}"#
        )
        .unwrap();
        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "test-project".to_string(),
                dir: tmp.path().to_string_lossy().to_string(),
                claude: None,
                integrations: Some(IntegrationsConfig {
                    host_exec: Some(HostExecConfig {
                        enabled: Some(true),
                        commands: vec![HostExecRecipe {
                            name: "test".to_string(),
                            exec: "./gradlew".to_string(),
                            args: vec!["test".to_string()],
                            cwd_sub: None,
                            params: None,
                            env: None,
                        }],
                    }),
                    ..Default::default()
                }),
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            transcription: None,
            ui: None,
        };
        let resolved = resolve_integrations(tmp.path(), &user_config, "test-project");
        assert!(resolved.host_exec);
        assert_eq!(resolved.host_exec_commands.len(), 1);
        assert_eq!(
            resolved.host_exec_commands[0].name, "test",
            "the user's recipe wins; the repo's 'evil' recipe is ignored"
        );
    }

    #[test]
    fn test_integrations_config_set_host_exec_helpers() {
        let mut cfg = IntegrationsConfig::default();
        assert!(cfg.host_exec.is_none());
        cfg.set_host_exec_enabled(true);
        assert_eq!(cfg.host_exec.as_ref().unwrap().enabled, Some(true));
        assert!(cfg.host_exec.as_ref().unwrap().commands.is_empty());
        cfg.set_host_exec_commands(vec![HostExecRecipe {
            name: "build".to_string(),
            exec: "./gradlew".to_string(),
            args: vec!["build".to_string()],
            cwd_sub: None,
            params: None,
            env: None,
        }]);
        // enabled flag preserved when setting commands
        assert_eq!(cfg.host_exec.as_ref().unwrap().enabled, Some(true));
        assert_eq!(cfg.host_exec.as_ref().unwrap().commands.len(), 1);
        // setting enabled again preserves commands
        cfg.set_host_exec_enabled(false);
        assert_eq!(cfg.host_exec.as_ref().unwrap().enabled, Some(false));
        assert_eq!(cfg.host_exec.as_ref().unwrap().commands.len(), 1);
    }

    #[test]
    fn test_host_exec_config_round_trips_json() {
        let cfg = HostExecConfig {
            enabled: Some(true),
            commands: vec![HostExecRecipe {
                name: "psql".to_string(),
                exec: "docker".to_string(),
                args: vec![
                    "compose".to_string(),
                    "exec".to_string(),
                    "-T".to_string(),
                    "db".to_string(),
                    "psql".to_string(),
                    "-c".to_string(),
                    "{sql}".to_string(),
                ],
                cwd_sub: Some("services/db".to_string()),
                params: Some(vec![HostExecParam {
                    name: "sql".to_string(),
                    pattern: "^SELECT .{0,500}$".to_string(),
                    max_len: Some(600),
                }]),
                env: Some(HashMap::from([("CI".to_string(), "true".to_string())])),
            }],
        };
        let json = serde_json::to_string(&cfg).unwrap();
        // The on-disk JSON must use camelCase keys — both the user config and
        // the TypeScript worker snapshot expect `cwdSub` / `maxLen`, never the
        // Rust field names `cwd_sub` / `max_len` (regression guard for the
        // worker-snapshot contract — `host_exec/src/types.ts`).
        assert!(
            json.contains("\"cwdSub\""),
            "JSON must use camelCase cwdSub"
        );
        assert!(
            json.contains("\"maxLen\""),
            "JSON must use camelCase maxLen"
        );
        assert!(
            !json.contains("cwd_sub") && !json.contains("max_len"),
            "JSON must not leak Rust snake_case field names"
        );
        let back: HostExecConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.enabled, Some(true));
        assert_eq!(back.commands.len(), 1);
        let r = &back.commands[0];
        assert_eq!(r.name, "psql");
        assert_eq!(r.cwd_sub.as_deref(), Some("services/db"));
        assert_eq!(r.params.as_ref().unwrap()[0].name, "sql");
        assert_eq!(r.params.as_ref().unwrap()[0].max_len, Some(600));
        // camelCase also parses *back* (what the user writes / the worker reads).
        let from_camel: HostExecRecipe = serde_json::from_str(
            r#"{ "name": "t", "exec": "./gradlew", "args": ["{tgt}"],
                 "cwdSub": "frontend",
                 "params": [{ "name": "tgt", "pattern": "^[a-z]+$", "maxLen": 30 }] }"#,
        )
        .unwrap();
        assert_eq!(from_camel.cwd_sub.as_deref(), Some("frontend"));
        assert_eq!(from_camel.params.as_ref().unwrap()[0].max_len, Some(30));
        // A stray `confirm` key in an old config is silently ignored (no
        // deny_unknown_fields), so existing configs keep parsing.
        let with_stray: HostExecRecipe = serde_json::from_str(
            r#"{ "name": "t", "exec": "./gradlew", "args": ["test"], "confirm": "ask" }"#,
        )
        .unwrap();
        assert_eq!(with_stray.name, "t");
        let minimal: HostExecRecipe =
            serde_json::from_str(r#"{ "name": "t", "exec": "./gradlew", "args": ["test"] }"#)
                .unwrap();
        assert!(minimal.params.is_none());
        assert!(minimal.cwd_sub.is_none());
        assert!(minimal.env.is_none());
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
                    github: None,
                    atlassian: None,
                    office: None,
                    playwright: None,
                    context7: None,
                    host_exec: None,
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
            transcription: None,
            ui: None,
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
                    github: None,
                    atlassian: None,
                    office: None,
                    playwright: None,
                    context7: None,
                    host_exec: None,
                    os: None,
                    plugins: None,
                }),
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            transcription: None,
            ui: None,
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
            github: false,
            atlassian: false,
            office: false,
            ..Default::default()
        };
        assert_eq!(r.is_service_enabled("slack"), Some(true));
        assert_eq!(r.is_service_enabled("sharepoint"), Some(false));
        assert_eq!(r.is_service_enabled("redmine"), Some(false));
        assert_eq!(r.is_service_enabled("gitlab"), Some(false));
        assert_eq!(r.is_service_enabled("github"), Some(false));
        assert_eq!(r.is_service_enabled("atlassian"), Some(false));
        assert_eq!(r.is_service_enabled("office"), Some(false));
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
        assert!(cfg.set_service(
            "github",
            IntegrationConfig {
                enabled: Some(true)
            }
        ));
        assert!(cfg.set_service(
            "office",
            IntegrationConfig {
                enabled: Some(true)
            }
        ));
        assert!(cfg.set_service(
            "atlassian",
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

        cfg.set_plugin_enabled("example-plugin", true);
        let plugins = cfg.plugins.as_ref().unwrap();
        assert_eq!(plugins.get("example-plugin").unwrap().enabled, Some(true));

        cfg.set_plugin_enabled("example-plugin", false);
        let plugins = cfg.plugins.as_ref().unwrap();
        assert_eq!(plugins.get("example-plugin").unwrap().enabled, Some(false));
    }

    #[test]
    fn test_is_plugin_enabled() {
        let resolved = ResolvedIntegrationsConfig {
            plugins: HashMap::from([
                ("example-plugin".to_string(), true),
                ("analytics".to_string(), false),
            ]),
            ..Default::default()
        };
        assert!(resolved.is_plugin_enabled("example-plugin"));
        assert!(!resolved.is_plugin_enabled("analytics"));
        assert!(!resolved.is_plugin_enabled("unknown"));
    }

    #[test]
    fn test_enabled_plugin_service_ids() {
        let resolved = ResolvedIntegrationsConfig {
            plugins: HashMap::from([
                ("example-plugin".to_string(), true),
                ("analytics".to_string(), false),
                ("reporting".to_string(), true),
            ]),
            ..Default::default()
        };
        let mut enabled = resolved.enabled_plugin_service_ids();
        enabled.sort();
        assert_eq!(enabled, vec!["example-plugin", "reporting"]);
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
                    github: None,
                    atlassian: None,
                    office: None,
                    playwright: None,
                    context7: None,
                    host_exec: None,
                    os: None,
                    plugins: Some(HashMap::from([(
                        "example-plugin".to_string(),
                        IntegrationConfig {
                            enabled: Some(true),
                        },
                    )])),
                }),
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            transcription: None,
            ui: None,
        };

        let resolved = resolve_integrations(tmp.path(), &user_config, "test-project");
        assert!(resolved.is_plugin_enabled("example-plugin"));
        assert!(!resolved.is_plugin_enabled("unknown"));
        assert_eq!(
            resolved.enabled_plugin_service_ids(),
            vec!["example-plugin"]
        );
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
            transcription: None,
            ui: None,
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

    // -- active_project_entry tests --

    #[test]
    fn test_active_project_entry_returns_matching_project() {
        let config = SpeedwaveUserConfig {
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
            active_project: Some("beta".to_string()),
            selected_ide: None,
            transcription: None,
            ui: None,
        };
        let entry = config.active_project_entry();
        assert!(entry.is_some());
        assert_eq!(entry.unwrap().name, "beta");
    }

    #[test]
    fn test_active_project_entry_returns_none_when_no_active() {
        let config = make_config_with_projects();
        assert!(config.active_project_entry().is_none());
    }

    #[test]
    fn test_active_project_entry_returns_none_when_dangling() {
        let config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "alpha".to_string(),
                dir: "/tmp/alpha".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: Some("deleted-project".to_string()),
            selected_ide: None,
            transcription: None,
            ui: None,
        };
        assert!(
            config.active_project_entry().is_none(),
            "should return None when active_project references a non-existent project"
        );
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

    // ── migrate_drop_log_level ──

    #[test]
    fn migrate_drop_log_level_removes_field_and_preserves_unknown() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"projects":[],"active_project":null,"log_level":"trace","__future_field__":"x"}"#,
        )
        .unwrap();

        let changed = super::migrate_drop_log_level_in(tmp.path()).unwrap();
        assert!(changed);

        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let obj = after.as_object().unwrap();
        assert!(!obj.contains_key("log_level"));
        assert_eq!(obj.get("__future_field__"), Some(&serde_json::json!("x")));
    }

    #[test]
    fn migrate_drop_log_level_noop_when_field_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("config.json");
        let original = r#"{"projects":[],"active_project":null}"#;
        std::fs::write(&path, original).unwrap();

        let changed = super::migrate_drop_log_level_in(tmp.path()).unwrap();
        assert!(!changed);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn migrate_drop_log_level_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("config.json");
        std::fs::write(&path, r#"{"projects":[],"log_level":"trace"}"#).unwrap();

        assert!(super::migrate_drop_log_level_in(tmp.path()).unwrap());
        let after_first = std::fs::read_to_string(&path).unwrap();
        assert!(!after_first.contains("log_level"));

        assert!(!super::migrate_drop_log_level_in(tmp.path()).unwrap());
        let after_second = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            after_first, after_second,
            "second call must not rewrite the file"
        );
    }

    #[test]
    fn migrate_drop_log_level_noop_when_file_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let changed = super::migrate_drop_log_level_in(tmp.path()).unwrap();
        assert!(!changed);
        assert!(!tmp.path().join("config.json").exists());
    }

    #[test]
    fn migrate_drop_log_level_errs_on_malformed_json() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("config.json");
        std::fs::write(&path, "{ not valid json").unwrap();

        let err = super::migrate_drop_log_level_in(tmp.path()).unwrap_err();
        assert!(
            format!("{err:#}").contains("not valid JSON"),
            "expected JSON-parse error, got: {err:#}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not valid json");
    }

    #[test]
    fn migrate_drop_log_level_errs_when_root_is_not_object() {
        // Cover every non-object JSON root shape — array, null, number, string,
        // bool — to make sure none of them are silently accepted (a user with
        // a manually-corrupted config must see an actionable error, not a
        // no-op success).
        for original in [
            r#"["unexpected","array","root"]"#,
            "null",
            "42",
            r#""just a string""#,
            "true",
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let path = tmp.path().join("config.json");
            std::fs::write(&path, original).unwrap();

            let err = super::migrate_drop_log_level_in(tmp.path()).unwrap_err();
            assert!(
                format!("{err:#}").contains("not a JSON object"),
                "expected root-shape error for {original:?}, got: {err:#}"
            );
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                original,
                "file must be untouched for {original:?}"
            );
            assert!(
                !path.with_extension("json.tmp").exists(),
                "no orphan tmp for {original:?}"
            );
        }
    }

    #[test]
    fn migrate_drop_log_level_cleans_orphan_tmp_on_rename_failure() {
        // Simulate the post-condition: even if rename fails, no `.tmp` orphan
        // is left behind. We can't easily force `rename` to fail, but we can
        // verify that under normal operation the function does not LEAVE a
        // `.tmp` file behind on the happy path (sanity check that we always
        // clean up).
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("config.json");
        std::fs::write(&path, r#"{"projects":[],"log_level":"trace"}"#).unwrap();
        assert!(super::migrate_drop_log_level_in(tmp.path()).unwrap());
        let tmp_path = path.with_extension("json.tmp");
        assert!(
            !tmp_path.exists(),
            "tmp file must not survive a successful rename"
        );
    }

    #[cfg(unix)]
    #[test]
    fn migrate_drop_log_level_on_readonly_dir_leaves_file_untouched() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("config.json");
        let original = r#"{"projects":[],"log_level":"trace"}"#;
        std::fs::write(&path, original).unwrap();

        let mut perms = std::fs::metadata(tmp.path()).unwrap().permissions();
        perms.set_mode(0o555);
        std::fs::set_permissions(tmp.path(), perms).unwrap();

        let result = super::migrate_drop_log_level_in(tmp.path());

        let mut restore = std::fs::metadata(tmp.path()).unwrap().permissions();
        restore.set_mode(0o755);
        std::fs::set_permissions(tmp.path(), restore).unwrap();

        // Either the migration refused (Err) or the read-only dir prevented
        // the temp-rename pair from running. In neither case may the file
        // shed `log_level` silently — the user's config must survive.
        match result {
            Err(_) => {}
            Ok(false) => {}
            Ok(true) => {
                let after = std::fs::read_to_string(&path).unwrap();
                assert!(
                    after.contains("log_level"),
                    "migration claimed success on read-only dir but field actually removed: {after}"
                );
            }
        }
    }
}
