//! Config schema and the layered merge (defaults → repo → user). See ADR-011.

use crate::defaults;
use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// LLM config schema version. v2: provider list + active (ADR-073). v3:
/// provenance quarantine ([`quarantine_foreign_anthropic_models`]).
pub const LLM_SCHEMA_VERSION: u32 = 3;

/// Canonical id of the built-in Anthropic provider entry; persisted in
/// on-disk configs, so it must never change.
pub const ANTHROPIC_PROVIDER_ID: &str = "anthropic";

/// What class of backend a configured provider entry is (ADR-073).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LlmProviderKind {
    /// Anthropic via the user's Claude subscription (OAuth managed by Claude
    /// Code, ADR-052). Inference passes through the proxy's `/anthropic` route.
    AnthropicOauth,
    /// Anthropic via a raw API key (key in the llm token namespace).
    AnthropicApiKey,
    /// Local or remote Anthropic-Messages server at a custom URL (Ollama, LM
    /// Studio, llama.cpp, vLLM, …), key optional.
    Local,
    /// OpenRouter (key required).
    OpenRouter,
}

impl LlmProviderKind {
    /// True for the two Anthropic kinds (OAuth + raw API key).
    pub fn is_anthropic(self) -> bool {
        matches!(self, Self::AnthropicOauth | Self::AnthropicApiKey)
    }
}

/// SSOT predicate (ADR-073): a `provider/model`-shaped id is foreign to
/// Anthropic — shape check, not catalog membership; retired `claude-*` kept.
pub fn is_foreign_anthropic_model(model: &str) -> bool {
    // Mirrored in llm-provider.component.ts::isForeignModel (frontend can't call Rust).
    model.contains('/')
}

/// One configured LLM provider (ADR-073). Key VALUES never live here —
/// they sit in `tokens/<project>/llm/<id>_api_key`; only presence flags do.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LlmProviderEntry {
    /// Stable user-scoped plugin-grade slug (`^[a-z][a-z0-9-]{0,63}$`);
    /// becomes the token file name segment + proxy `SPW_KEY_<ID>` env name.
    pub id: String,
    /// Backend class.
    pub kind: LlmProviderKind,
    /// Base URL for the `Local` kind (user-only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Model this provider routes (per-provider SSOT). Routing derives from
    /// here via [`LlmConfig::effective_active_model`]; `active.model` is a pointer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// True when `tokens/<project>/llm/<id>_api_key` exists. Re-derived from
    /// disk at resolve (the SSOT), never the persisted echo (`sync_has_api_key_from_disk_in`).
    #[serde(default)]
    pub has_api_key: bool,
    /// Context window of this provider's selected model, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u32>,
    /// True when the legacy `local-llm/custom_headers` file applies (Local
    /// entries migrated from v1 only).
    #[serde(default)]
    pub has_custom_headers: bool,
}

/// The provider+model a project's sessions start with (ADR-073).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LlmActive {
    /// `LlmProviderEntry::id` of the selected provider.
    pub provider_id: String,
    /// Pointer to the active provider's model. Routing derives via
    /// [`LlmConfig::effective_active_model`], not read raw from here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// LLM provider selection and model settings (ADR-073 migration). v1 = legacy
/// flat fields; v2 = `providers` + `active`; v3 = + foreign-model quarantine.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct LlmConfig {
    /// Provider id (`anthropic` | `local`; legacy aliases accepted on read).
    pub provider: Option<String>,
    /// Model id, or `None` for the account-tier default.
    pub model: Option<String>,
    /// Base URL for a local Anthropic-Messages server (user-only).
    pub base_url: Option<String>,
    /// Context window of the active model, in tokens; persisted per provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u32>,
    /// True when an API key file exists at `tokens/<project>/local-llm/api_key`.
    /// The key value never lives in config.json — only the presence flag.
    #[serde(default)]
    pub has_api_key: bool,
    /// True when custom headers file exists at `tokens/<project>/local-llm/custom_headers`.
    #[serde(default)]
    pub has_custom_headers: bool,
    /// LLM schema version; `None` = legacy v1 (see [`LLM_SCHEMA_VERSION`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<u32>,
    /// Kill-switch (ADR-073): `false` routes Claude Code direct at the provider
    /// (pre-proxy). Default `true`. User-only — `merge_llm_repo` ignores it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_enabled: Option<bool>,
    /// Configured providers (v2). Entries with invalid slugs are dropped on
    /// resolve with a warning — the id reaches file paths and env names.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub providers: Vec<LlmProviderEntry>,
    /// Active provider+model selection (v2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<LlmActive>,
}

impl LlmConfig {
    /// The active provider entry, when both halves of the v2 shape agree.
    pub fn active_provider(&self) -> Option<&LlmProviderEntry> {
        let active = self.active.as_ref()?;
        self.providers.iter().find(|p| p.id == active.provider_id)
    }

    /// Whether this is a v2-shaped config (vs. fresh/legacy-v1). Used only by
    /// [`is_logged_out`](Self::is_logged_out) to pick bail wording.
    fn is_v2_shaped(&self) -> bool {
        self.schema_version.is_some() || !self.providers.is_empty() || self.active.is_some()
    }

    /// SSOT for "is LLM configured?" — negate this, never re-derive it.
    pub fn is_unconfigured(&self) -> bool {
        self.active_provider().is_none()
    }

    /// Narrower than [`is_unconfigured`](Self::is_unconfigured): true only for an
    /// explicit logout (v2-shaped, active cleared) vs. never-configured. Exists
    /// solely to pick bail wording in `apply_llm_config_in` — not a gate.
    pub(crate) fn is_logged_out(&self) -> bool {
        self.is_v2_shaped() && self.active.is_none()
    }

    /// Selects an Anthropic provider as active, adding an `anthropic` OAuth
    /// entry if none exists. The active pointer mirrors the entry's own model
    /// (provenance, ADR-073; foreign shapes cleared). True when state changed.
    pub fn set_active_to_anthropic(&mut self) -> bool {
        let (id, model) = match self.providers.iter().find(|p| p.kind.is_anthropic()) {
            Some(entry) => (entry.id.clone(), entry.model.clone()),
            None => {
                self.providers.push(LlmProviderEntry {
                    id: ANTHROPIC_PROVIDER_ID.to_string(),
                    kind: LlmProviderKind::AnthropicOauth,
                    base_url: None,
                    model: None,
                    has_api_key: false,
                    context_tokens: None,
                    has_custom_headers: false,
                });
                self.schema_version = Some(LLM_SCHEMA_VERSION);
                (ANTHROPIC_PROVIDER_ID.to_string(), None)
            }
        };
        if self.active.as_ref().map(|a| &a.provider_id) == Some(&id) {
            return false;
        }
        self.active = Some(LlmActive {
            provider_id: id,
            model: model.filter(|m| !is_foreign_anthropic_model(m)),
        });
        true
    }

    /// Routing model for the active provider, enforcing provenance (ADR-073):
    /// the entry's `model` wins over a disagreeing `active.model`.
    pub fn effective_active_model(&self) -> Option<String> {
        let entry = self.active_provider()?;
        let entry_model = entry
            .model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let active_model = self
            .active
            .as_ref()
            .and_then(|a| a.model.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        match (active_model, entry_model) {
            (Some(a), Some(e)) if a == e => Some(a.to_string()),
            // Disagreement or active-only: trust the provider entry (provenance).
            (_, Some(e)) => {
                if active_model.is_some_and(|a| a != e) {
                    log::debug!(
                        "llm: active.model disagrees with entry — using entry (provenance)"
                    );
                }
                Some(e.to_string())
            }
            // Entry has no model: active-only is unattributable → drop it.
            (_, None) => None,
        }
    }

    /// Sets each provider's `has_api_key` from its key file's existence — the
    /// authoritative source (ADR-073), so a stale echo never reaches the renderer.
    pub fn sync_has_api_key_from_disk_in(&mut self, data_dir: &Path, project: &str) {
        for entry in &mut self.providers {
            if let Ok(key_path) =
                crate::compose::llm_provider_key_path_in(data_dir, project, &entry.id)
            {
                entry.has_api_key = key_path.exists();
            }
        }
    }
}

/// Anthropic credential evidence for the v1→v2 lift: which credential the
/// project demonstrably uses on disk (an API key beats OAuth when both exist).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnthropicEvidence {
    /// No Anthropic credential on disk.
    None,
    /// `secrets/<project>/anthropic_api_key` exists.
    ApiKey,
    /// Claude Code OAuth credentials exist in the project's claude-home.
    Oauth,
}

impl AnthropicEvidence {
    /// Detects on-disk evidence for `project` under `data_dir`.
    pub fn detect_in(data_dir: &Path, project: &str) -> Self {
        if anthropic_secret_exists_in(data_dir, project) {
            Self::ApiKey
        } else if crate::claude_home::has_anthropic_oauth_credentials(data_dir, project) {
            Self::Oauth
        } else {
            Self::None
        }
    }
}

/// Migrates an `LlmConfig` to [`LLM_SCHEMA_VERSION`] (lift v1, drop invalid ids,
/// quarantine foreign). Idempotent; `true` if changed. `evidence`: see [`AnthropicEvidence`].
pub fn migrate_llm(llm: &mut LlmConfig, evidence: AnthropicEvidence) -> bool {
    let snapshot_before = serde_json::to_string(&*llm).ok();
    if llm.schema_version.is_none() && llm.providers.is_empty() {
        let legacy_provider = llm.provider.as_deref();
        if is_local_provider(legacy_provider) {
            llm.providers.push(LlmProviderEntry {
                id: "local".to_string(),
                kind: LlmProviderKind::Local,
                // v0.13.3 filled the per-alias default port at render time; an
                // unset base_url must keep that identity through the lift.
                base_url: llm
                    .base_url
                    .clone()
                    .or_else(|| legacy_provider.and_then(crate::compose::default_base_url)),
                model: llm.model.clone(),
                has_api_key: llm.has_api_key,
                context_tokens: llm.context_tokens,
                has_custom_headers: llm.has_custom_headers,
            });
            llm.active = Some(LlmActive {
                provider_id: "local".to_string(),
                model: llm.model.clone(),
            });
        } else if legacy_provider.is_some() || evidence != AnthropicEvidence::None {
            // v0.13.3 defaulted an unset provider to anthropic, so credentialed
            // upgraders migrate; truly fresh (no creds) falls through (render refuses).
            let kind = if evidence == AnthropicEvidence::ApiKey {
                LlmProviderKind::AnthropicApiKey
            } else {
                LlmProviderKind::AnthropicOauth
            };
            llm.providers.push(LlmProviderEntry {
                id: ANTHROPIC_PROVIDER_ID.to_string(),
                kind,
                base_url: None,
                model: llm.model.clone(),
                has_api_key: evidence == AnthropicEvidence::ApiKey,
                context_tokens: llm.context_tokens,
                has_custom_headers: false,
            });
            llm.active = Some(LlmActive {
                provider_id: ANTHROPIC_PROVIDER_ID.to_string(),
                model: llm.model.clone(),
            });
        }
    }
    llm.schema_version = Some(LLM_SCHEMA_VERSION);

    // Lift the flat model into active only when it belongs to the active entry;
    // a foreign one would be cleared by the quarantine step below anyway.
    let flat = llm.model.as_deref().map(str::trim);
    let flat_belongs_to_active = llm
        .active_provider()
        .map(|e| e.model.as_deref().map(str::trim) == flat)
        .unwrap_or(false);
    if flat_belongs_to_active {
        if let Some(active) = &mut llm.active {
            if active.model.is_none() && llm.model.is_some() {
                active.model.clone_from(&llm.model);
            }
        }
    }

    // v3: clear any foreign model left under an Anthropic entry (provenance).
    quarantine_foreign_anthropic_models(llm);

    // Validate ids — they reach token file paths and env names.
    let before = llm.providers.len();
    llm.providers.retain(|p| {
        let ok = crate::plugin::is_valid_slug(&p.id);
        if !ok {
            log::warn!("llm config: dropping provider with invalid id slug");
        }
        ok
    });
    if llm.providers.len() != before {
        if let Some(active) = &llm.active {
            if !llm.providers.iter().any(|p| p.id == active.provider_id) {
                llm.active = llm.providers.first().map(|p| LlmActive {
                    provider_id: p.id.clone(),
                    model: None,
                });
            }
        }
    }

    sync_llm_legacy_fields(llm);

    // Serialization failure → can't tell, assume unchanged (avoid spurious heal writes).
    snapshot_before
        .and_then(|b| serde_json::to_string(&*llm).ok().map(|after| b != after))
        .unwrap_or(false)
}

/// v3 self-heal: clear a `provider/model`-shaped (foreign) model stored under
/// an Anthropic entry, and reconcile `active.model` to it. Idempotent.
fn quarantine_foreign_anthropic_models(llm: &mut LlmConfig) {
    for entry in &mut llm.providers {
        let foreign = entry
            .model
            .as_deref()
            .is_some_and(is_foreign_anthropic_model);
        if entry.kind.is_anthropic() && foreign {
            log::warn!(
                "llm config: quarantining foreign model '{}' under anthropic entry '{}' (account default)",
                entry.model.as_deref().unwrap_or(""),
                entry.id
            );
            entry.model = None;
        }
    }
    // Reconcile the active pointer to the entry's model (the routing SSOT), so
    // a disagreeing active.model never persists — not just the cleared case.
    let routed = llm.effective_active_model();
    if let Some(active) = &mut llm.active {
        if active.model != routed {
            active.model = routed;
        }
    }
}

/// Downgrade story (one release): derive the legacy flat fields from the
/// active v2 entry so an older Speedwave reading this config keeps working.
pub fn sync_llm_legacy_fields(llm: &mut LlmConfig) {
    let Some(active) = llm.active.clone() else {
        return;
    };
    let Some(entry) = llm.providers.iter().find(|p| p.id == active.provider_id) else {
        return;
    };
    match entry.kind {
        LlmProviderKind::Local => {
            llm.provider = Some("local".to_string());
            llm.base_url.clone_from(&entry.base_url);
            llm.has_api_key = entry.has_api_key;
            llm.has_custom_headers = entry.has_custom_headers;
            // Local model belongs to the provider — flat pair stays consistent.
            llm.model.clone_from(&entry.model);
        }
        LlmProviderKind::AnthropicOauth | LlmProviderKind::AnthropicApiKey => {
            llm.provider = Some(ANTHROPIC_PROVIDER_ID.to_string());
            llm.base_url = None;
            llm.has_api_key = false;
            llm.has_custom_headers = false;
            llm.model.clone_from(&entry.model);
        }
        // No v1 equivalent — flat masquerades as anthropic, so its model must
        // NOT carry the OpenRouter id (404s a downgrade reader); v2 fields keep it.
        LlmProviderKind::OpenRouter => {
            llm.provider = Some(ANTHROPIC_PROVIDER_ID.to_string());
            llm.base_url = None;
            llm.has_api_key = false;
            llm.has_custom_headers = false;
            llm.model = None;
        }
    }
    llm.context_tokens = entry.context_tokens;
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

    /// SSOT for service-key → field mapping; `None` for unknown keys so a new
    /// `TOGGLEABLE_OS_SERVICES` entry can't be silently missed without this match.
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

/// Per-project integration toggles (built-in MCP services, OS, plugins).
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
    /// (caller's job). Separate from `set_service` so typos can't create entries.
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

    /// Service ids of all enabled plugins, sorted — env values built from
    /// this list must be deterministic or config-hash convergence flaps.
    pub fn enabled_plugin_service_ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self
            .plugins
            .iter()
            .filter(|(_, &enabled)| enabled)
            .map(|(id, _)| id.as_str())
            .collect();
        ids.sort_unstable();
        ids
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

/// UI preferences (ADR-058). Top-level user-only — a checked-in repo
/// `.speedwave.json` is not allowed to flip beta UI on or off.
#[derive(Serialize, Deserialize, Debug, Default, Clone, PartialEq)]
pub struct UiPrefsConfig {
    /// Reveal hidden / work-in-progress UI surfaces. Default = off.
    pub beta_enabled: Option<bool>,
}

/// OTLP transport protocol for the telemetry exporter.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum OtlpProtocol {
    /// gRPC (default), typically on port 4317.
    #[default]
    #[serde(rename = "grpc")]
    Grpc,
    /// HTTP with protobuf payloads, typically on port 4318.
    #[serde(rename = "http/protobuf")]
    HttpProtobuf,
    /// HTTP with JSON payloads.
    #[serde(rename = "http/json")]
    HttpJson,
}

/// User-layer OTLP telemetry config. Top-level user-only, like `ui`. Field
/// semantics mirror [`TelemetryField`](crate::telemetry_env::TelemetryField).
#[derive(Serialize, Deserialize, Debug, Default, Clone, PartialEq)]
pub struct TelemetryConfig {
    /// Master switch: emit telemetry at all.
    pub enabled: Option<bool>,
    /// OTLP collector endpoint URL.
    pub endpoint: Option<String>,
    /// OTLP transport protocol.
    pub protocol: Option<OtlpProtocol>,
    /// Export the metrics signal.
    pub export_metrics: Option<bool>,
    /// Export the logs/events signal.
    pub export_logs: Option<bool>,
    /// Collector auth headers (`Key=Value,…`; secret).
    pub headers: Option<String>,
    /// Custom resource attributes (`key=value,…`).
    pub resource_attributes: Option<String>,
    /// Include the account UUID attribute in metrics.
    pub include_account_uuid: Option<bool>,
    /// Privacy gate: include user prompt content.
    pub log_user_prompts: Option<bool>,
    /// Privacy gate: include assistant response content.
    pub log_assistant_responses: Option<bool>,
    /// Privacy gate: include tool command/parameter details.
    pub log_tool_details: Option<bool>,
    /// Privacy gate: include raw API request/response bodies.
    pub log_raw_api_bodies: Option<bool>,
    /// Metrics export interval in milliseconds.
    pub metric_export_interval_ms: Option<u64>,
    /// Logs export interval in milliseconds.
    pub logs_export_interval_ms: Option<u64>,
}

/// MDM-layer telemetry policy. Presence IS the lock; unknown keys are rejected
/// (fail-closed) so a misspelled admin key never silently unlocks (ADR-076).
#[derive(Serialize, Deserialize, Debug, Default, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ManagedTelemetryConfig {
    /// Force the master switch (kill-switch when `false`).
    pub enabled: Option<bool>,
    /// Force the collector endpoint.
    pub endpoint: Option<String>,
    /// Force the transport protocol.
    pub protocol: Option<OtlpProtocol>,
    /// Force the metrics signal on/off.
    pub export_metrics: Option<bool>,
    /// Force the logs signal on/off.
    pub export_logs: Option<bool>,
    /// Force the collector auth headers.
    pub headers: Option<String>,
    /// Force the resource attributes.
    pub resource_attributes: Option<String>,
    /// Force the account-UUID attribute.
    pub include_account_uuid: Option<bool>,
    /// Force the user-prompt privacy gate.
    pub log_user_prompts: Option<bool>,
    /// Force the assistant-response privacy gate.
    pub log_assistant_responses: Option<bool>,
    /// Force the tool-details privacy gate.
    pub log_tool_details: Option<bool>,
    /// Force the raw-API-bodies privacy gate.
    pub log_raw_api_bodies: Option<bool>,
    /// Force the metrics export interval (ms).
    pub metric_export_interval_ms: Option<u64>,
    /// Force the logs export interval (ms).
    pub logs_export_interval_ms: Option<u64>,
}

/// Fully resolved telemetry after the per-field merge + cross-field gates.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ResolvedTelemetry {
    /// Resolved master switch.
    pub enabled: bool,
    /// Resolved collector endpoint (`None` when disabled).
    pub endpoint: Option<String>,
    /// Resolved transport protocol.
    pub protocol: OtlpProtocol,
    /// Whether the metrics signal is exported.
    pub export_metrics: bool,
    /// Whether the logs signal is exported.
    pub export_logs: bool,
    /// Resolved collector auth headers (secret; `None` when disabled).
    pub headers: Option<String>,
    /// Resolved resource attributes.
    pub resource_attributes: Option<String>,
    /// Whether the account-UUID attribute is included.
    pub include_account_uuid: bool,
    /// Privacy gate: user prompt content.
    pub log_user_prompts: bool,
    /// Privacy gate: assistant response content.
    pub log_assistant_responses: bool,
    /// Privacy gate: tool command/parameter details.
    pub log_tool_details: bool,
    /// Privacy gate: raw API request/response bodies.
    pub log_raw_api_bodies: bool,
    /// Resolved metrics export interval (ms).
    pub metric_export_interval_ms: Option<u64>,
    /// Resolved logs export interval (ms).
    pub logs_export_interval_ms: Option<u64>,
    /// Env-var keys MDM locked (user cannot override these).
    pub locked_keys: std::collections::BTreeSet<String>,
    /// True when MDM locked at least one field.
    pub any_locked: bool,
    /// True when MDM forced telemetry off (kill-switch).
    pub kill_switch: bool,
}

impl ResolvedTelemetry {
    /// All-off value used as the fail-closed placeholder when resolution fails;
    /// the invalid policy is hard-stopped at boot, not carried onward.
    pub fn disabled() -> Self {
        Self::default()
    }

    /// True when MDM locked the given field. `Enabled` maps to the master switch
    /// (`ENABLE_KEY`), not an OTEL_* key, so it is special-cased.
    pub fn is_field_locked(&self, field: crate::telemetry_env::TelemetryField) -> bool {
        use crate::telemetry_env::{env_key_for, TelemetryField, ENABLE_KEY};
        match field {
            TelemetryField::Enabled => self.locked_keys.contains(ENABLE_KEY),
            f => env_key_for(f).is_some_and(|k| self.locked_keys.contains(k)),
        }
    }
}

/// Advisory only: gRPC conventionally serves :4317, HTTP :4318. A mismatch often
/// means the export silently fails at the collector; never a hard error.
fn warn_on_protocol_port_mismatch(protocol: OtlpProtocol, endpoint: Option<&str>) {
    let Some(port) = endpoint
        .and_then(|e| e.parse::<url::Url>().ok())
        .and_then(|u| u.port())
    else {
        return;
    };
    let mismatch = match protocol {
        OtlpProtocol::Grpc => port == 4318,
        OtlpProtocol::HttpProtobuf | OtlpProtocol::HttpJson => port == 4317,
    };
    if mismatch {
        log::warn!(
            "OTLP protocol {protocol:?} with port {port} looks mismatched (gRPC=4317, HTTP=4318)"
        );
    }
}

/// Merges the user and MDM telemetry layers per-field (MDM wins + locks), then
/// gates: `enabled=false` suppresses output, `enabled=true` w/o endpoint fails closed.
pub fn resolve_telemetry(
    user: Option<&TelemetryConfig>,
    managed: Option<&ManagedTelemetryConfig>,
) -> anyhow::Result<ResolvedTelemetry> {
    use crate::telemetry_env::{env_key_for, TelemetryField, ENABLE_KEY};
    use std::collections::BTreeSet;
    let mut locked_keys: BTreeSet<String> = BTreeSet::new();
    let mut any_locked = false;

    // A macro (not a closure) so it doesn't hold a long-lived borrow of
    // any_locked/locked_keys that would conflict with the `enabled` branch below.
    macro_rules! note_lock {
        ($field:expr) => {{
            any_locked = true;
            if let Some(k) = env_key_for($field) {
                locked_keys.insert(k.to_string());
            }
        }};
    }

    macro_rules! merge {
        ($field:expr, $mval:expr, $umf:expr, $default:expr) => {{
            match $mval {
                Some(v) => {
                    note_lock!($field);
                    v.clone()
                }
                None => $umf.clone().unwrap_or($default),
            }
        }};
    }
    macro_rules! merge_opt {
        ($field:expr, $mval:expr, $uval:expr) => {{
            match $mval {
                Some(v) => {
                    note_lock!($field);
                    Some(v.clone())
                }
                None => $uval,
            }
        }};
    }

    use TelemetryField as F;
    // `enabled` locks the CLAUDE_CODE_* master switch (not an OTEL_* key) by
    // inserting ENABLE_KEY directly, so MDM can force it un-bypassably.
    let enabled = match managed.and_then(|m| m.enabled) {
        Some(v) => {
            any_locked = true;
            locked_keys.insert(ENABLE_KEY.to_string());
            v
        }
        None => user.and_then(|u| u.enabled).unwrap_or(false),
    };
    let endpoint_opt = merge_opt!(
        F::Endpoint,
        managed.and_then(|m| m.endpoint.as_ref()),
        user.and_then(|u| u.endpoint.clone())
    );
    let protocol = merge!(
        F::Protocol,
        managed.and_then(|m| m.protocol.as_ref()),
        user.and_then(|u| u.protocol),
        OtlpProtocol::default()
    );
    let export_metrics = merge!(
        F::ExportMetrics,
        managed.and_then(|m| m.export_metrics.as_ref()),
        user.and_then(|u| u.export_metrics),
        true
    );
    let export_logs = merge!(
        F::ExportLogs,
        managed.and_then(|m| m.export_logs.as_ref()),
        user.and_then(|u| u.export_logs),
        false
    );
    let headers_opt = merge_opt!(
        F::Headers,
        managed.and_then(|m| m.headers.as_ref()),
        user.and_then(|u| u.headers.clone())
    );
    let resource_attributes_opt = merge_opt!(
        F::ResourceAttributes,
        managed.and_then(|m| m.resource_attributes.as_ref()),
        user.and_then(|u| u.resource_attributes.clone())
    );
    let include_account_uuid = merge!(
        F::IncludeAccountUuid,
        managed.and_then(|m| m.include_account_uuid.as_ref()),
        user.and_then(|u| u.include_account_uuid),
        true
    );
    let log_user_prompts = merge!(
        F::LogUserPrompts,
        managed.and_then(|m| m.log_user_prompts.as_ref()),
        user.and_then(|u| u.log_user_prompts),
        false
    );
    let log_assistant_responses = merge!(
        F::LogAssistantResponses,
        managed.and_then(|m| m.log_assistant_responses.as_ref()),
        user.and_then(|u| u.log_assistant_responses),
        false
    );
    let log_tool_details = merge!(
        F::LogToolDetails,
        managed.and_then(|m| m.log_tool_details.as_ref()),
        user.and_then(|u| u.log_tool_details),
        false
    );
    let log_raw_api_bodies = merge!(
        F::LogRawApiBodies,
        managed.and_then(|m| m.log_raw_api_bodies.as_ref()),
        user.and_then(|u| u.log_raw_api_bodies),
        false
    );
    let metric_export_interval_ms = merge_opt!(
        F::MetricExportInterval,
        managed.and_then(|m| m.metric_export_interval_ms.as_ref()),
        user.and_then(|u| u.metric_export_interval_ms)
    );
    let logs_export_interval_ms = merge_opt!(
        F::LogsExportInterval,
        managed.and_then(|m| m.logs_export_interval_ms.as_ref()),
        user.and_then(|u| u.logs_export_interval_ms)
    );

    // Kill-switch = MDM set enabled=false (presence is the lock).
    let kill_switch = managed.and_then(|m| m.enabled) == Some(false);

    // Cross-field gate: enabled=false suppresses ALL output — everything off
    // (via `disabled()`) except the resolved lock bookkeeping and cardinality.
    if !enabled {
        return Ok(ResolvedTelemetry {
            protocol,
            include_account_uuid,
            locked_keys,
            any_locked,
            kill_switch,
            ..ResolvedTelemetry::disabled()
        });
    }

    // Cross-field gate: enabled=true needs a valid endpoint (fail-closed).
    match &endpoint_opt {
        Some(ep) => {
            crate::url_validation::validate_collector_url(
                ep,
                crate::url_validation::PrivatePolicy::AllowLoopback,
            )
            .map_err(|e| anyhow::anyhow!("invalid OTLP endpoint: {e}"))?;
        }
        None => anyhow::bail!("telemetry enabled but no OTLP endpoint configured"),
    }
    if let Some(h) = &headers_opt {
        if h.chars().any(|c| c.is_control()) {
            anyhow::bail!("OTLP headers must not contain control characters");
        }
    }
    // A zero interval makes the OTEL exporter rapid-fire; reject on either layer.
    if metric_export_interval_ms == Some(0) || logs_export_interval_ms == Some(0) {
        anyhow::bail!("OTLP export interval must be greater than 0");
    }
    warn_on_protocol_port_mismatch(protocol, endpoint_opt.as_deref());

    Ok(ResolvedTelemetry {
        enabled: true,
        endpoint: endpoint_opt,
        protocol,
        export_metrics,
        export_logs,
        headers: headers_opt,
        resource_attributes: resource_attributes_opt,
        include_account_uuid,
        log_user_prompts,
        log_assistant_responses,
        log_tool_details,
        log_raw_api_bodies,
        metric_export_interval_ms,
        logs_export_interval_ms,
        locked_keys,
        any_locked,
        kill_switch,
    })
}

/// Global boot gate: resolves the telemetry policy once so every MDM error class
/// fails closed at startup. A malformed user config degrades to defaults (ADR-076).
pub fn check_telemetry_policy_at_boot() -> anyhow::Result<()> {
    let user = load_user_config().unwrap_or_default();
    let managed = crate::managed_config::load_managed_config()?.and_then(|m| m.telemetry);
    resolve_telemetry(user.telemetry.as_ref(), managed.as_ref())?;
    Ok(())
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
    /// UI preferences (ADR-058). Top-level, user-only.
    pub ui: Option<UiPrefsConfig>,
    /// OTLP telemetry config. Top-level, user-only.
    pub telemetry: Option<TelemetryConfig>,
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

    /// `true` if beta-features UI surface is enabled (top-level only).
    pub fn beta_enabled(&self) -> bool {
        self.ui
            .as_ref()
            .and_then(|u| u.beta_enabled)
            .unwrap_or(false)
    }
}

/// Fully resolved Claude container config after the layered merge.
#[derive(Debug, Clone, Default)]
pub struct ResolvedClaudeConfig {
    /// Environment variables for the Claude container.
    pub env: HashMap<String, String>,
    /// Extra Claude Code CLI flags.
    pub flags: Vec<String>,
    /// Resolved LLM provider/model configuration.
    pub llm: LlmConfig,
    /// Merged telemetry the renderer reads for the managed-settings mount.
    /// An unresolvable policy degrades to `disabled()`; it is hard-stopped at boot.
    pub telemetry: ResolvedTelemetry,
}

/// Resolves both Claude config and integrations in a single pass,
/// reading the repo config file only once.
pub fn resolve_project_config(
    project_dir: &Path,
    user_config: &SpeedwaveUserConfig,
    project_name: &str,
) -> (ResolvedClaudeConfig, ResolvedIntegrationsConfig) {
    resolve_project_config_in(
        crate::consts::data_dir(),
        project_dir,
        user_config,
        project_name,
    )
}

/// Testable variant of [`resolve_project_config`] with an explicit data dir —
/// every on-disk lookup (legacy-key migration, has_api_key disk-sync, anthropic
/// secret) resolves under `data_dir` so the migrate→sync ordering can be tested.
pub(crate) fn resolve_project_config_in(
    data_dir: &Path,
    project_dir: &Path,
    user_config: &SpeedwaveUserConfig,
    project_name: &str,
) -> (ResolvedClaudeConfig, ResolvedIntegrationsConfig) {
    resolve_project_config_in_with_load(
        data_dir,
        project_dir,
        user_config,
        project_name,
        crate::managed_config::load_managed_config(),
    )
}

/// Core of [`resolve_project_config_in`] taking the raw MDM load result. A load
/// error fails closed to telemetry off; it is hard-stopped at boot (ADR-076).
pub(crate) fn resolve_project_config_in_with_load(
    data_dir: &Path,
    project_dir: &Path,
    user_config: &SpeedwaveUserConfig,
    project_name: &str,
    managed_load: anyhow::Result<Option<crate::managed_config::ManagedConfig>>,
) -> (ResolvedClaudeConfig, ResolvedIntegrationsConfig) {
    match managed_load {
        Ok(managed) => {
            let managed_telemetry = managed.and_then(|m| m.telemetry);
            resolve_project_config_in_with_managed(
                data_dir,
                project_dir,
                user_config,
                project_name,
                managed_telemetry.as_ref(),
            )
        }
        Err(_) => {
            let (mut claude, integrations) = resolve_project_config_in_with_managed(
                data_dir,
                project_dir,
                user_config,
                project_name,
                None,
            );
            // Fail closed: drop any telemetry env the user layer added, force off.
            let disabled = ResolvedTelemetry::disabled();
            for f in crate::telemetry_env::TelemetryField::ALL {
                if let Some(k) = crate::telemetry_env::env_key_for(*f) {
                    claude.env.remove(k);
                }
            }
            claude
                .env
                .extend(crate::telemetry_env::telemetry_env_map(&disabled));
            claude.telemetry = disabled;
            (claude, integrations)
        }
    }
}

/// Core of [`resolve_project_config_in`] with the MDM telemetry policy injected
/// explicitly (tests supply it without touching the system path).
pub(crate) fn resolve_project_config_in_with_managed(
    data_dir: &Path,
    project_dir: &Path,
    user_config: &SpeedwaveUserConfig,
    project_name: &str,
    managed_telemetry: Option<&ManagedTelemetryConfig>,
) -> (ResolvedClaudeConfig, ResolvedIntegrationsConfig) {
    let repo = load_repo_config_logged(project_dir);

    let mut env = defaults::base_env();
    let mut llm = LlmConfig::default();
    let mut integrations = ResolvedIntegrationsConfig::default();

    // Baseline goes in BEFORE the user merge (user wins for non-locked keys);
    // locked keys are re-forced AFTER, below. Map built ONCE and reused.
    let resolved_tel = resolve_telemetry(user_config.telemetry.as_ref(), managed_telemetry);
    let tel_env = resolved_tel
        .as_ref()
        .ok()
        .map(crate::telemetry_env::telemetry_env_map)
        .unwrap_or_default();
    for (k, v) in &tel_env {
        env.insert(k.clone(), v.clone());
    }

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
            apply_integrations_layer(&mut integrations, &repo_integrations);
        }
    }
    // Captured pre-user-layer so the documented repo suggestion survives migration.
    let repo_model_suggestion = llm.model.clone();

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

    // Re-force: strip any user value for an MDM-locked key, then set the locked
    // value from the built map — this is what the user cannot beat.
    if let Ok(tel) = &resolved_tel {
        env.retain(|k, _| !tel.locked_keys.contains(k));
        for (k, v) in &tel_env {
            if tel.locked_keys.contains(k) {
                env.insert(k.clone(), v.clone());
            }
        }
    }

    // Migrate to the current LLM schema (ADR-073).
    migrate_llm(
        &mut llm,
        AnthropicEvidence::detect_in(data_dir, project_name),
    );
    apply_repo_model_suggestion(&mut llm, repo_model_suggestion);

    // Lift a legacy `local-llm/api_key` into the llm token namespace BEFORE the
    // disk-sync below — otherwise the sync re-derives has_api_key from the (still
    // empty) new path and the migration, gated on the new file, never runs.
    crate::compose::migrate_legacy_local_key_in(data_dir, project_name, &llm);

    // Re-derive each provider's `has_api_key` from disk — the key file is the
    // SSOT, the persisted flag only an echo. Every renderer (proxy/compose
    // injection) reads the resolved config, so this is the single sync point.
    llm.sync_has_api_key_from_disk_in(data_dir, project_name);

    // Local LLMs keep the full default system prompt; two local-only additions
    // help small open models: stable prompt prefix (KV cache) + skill recall.
    let mut flags: Vec<String> = defaults::DEFAULT_FLAGS
        .iter()
        .map(|s| s.to_string())
        .collect();
    if llm
        .active_provider()
        .is_some_and(|e| e.kind == LlmProviderKind::Local)
    {
        flags.push("--exclude-dynamic-system-prompt-sections".to_string());
        flags.push("--append-system-prompt".to_string());
        flags.push(crate::prompts::local_llm_skills_nudge().to_string());
    }

    // Fail-closed: an unresolvable policy degrades to disabled(); the invalid
    // policy is hard-stopped at boot by check_telemetry_policy_at_boot.
    let telemetry = resolved_tel.unwrap_or_else(|_| ResolvedTelemetry::disabled());

    let claude = ResolvedClaudeConfig {
        env,
        flags,
        llm,
        telemetry,
    };
    (claude, integrations)
}

/// Repo model suggestion (docs contract): fills the resolved model only when
/// the active entry has none of its own. In-memory only, never persisted.
fn apply_repo_model_suggestion(llm: &mut LlmConfig, suggestion: Option<String>) {
    let Some(model) = suggestion
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    if llm.effective_active_model().is_some() {
        return;
    }
    let Some(entry) = llm.active_provider() else {
        return;
    };
    if entry.kind.is_anthropic() && is_foreign_anthropic_model(&model) {
        log::warn!("llm config: ignoring foreign repo model suggestion under anthropic provider");
        return;
    }
    let id = entry.id.clone();
    if let Some(e) = llm.providers.iter_mut().find(|p| p.id == id) {
        e.model = Some(model.clone());
    }
    if let Some(active) = &mut llm.active {
        active.model = Some(model.clone());
    }
    // Flat mirror for the legacy (proxy_enabled=false) renderer.
    llm.model = Some(model);
}

/// True when `secrets/<project>/anthropic_api_key` exists under `data_dir`.
fn anthropic_secret_exists_in(data_dir: &Path, project_name: &str) -> bool {
    data_dir
        .join("secrets")
        .join(project_name)
        .join("anthropic_api_key")
        .is_file()
}

/// Provider names that route through a local LLM server. SSOT for the set;
/// `is_local_provider` is the matching predicate.
pub const LOCAL_PROVIDERS: &[&str] = &["ollama", "lmstudio", "llamacpp", "local"];

/// True for provider values pointing at a local LLM server;
/// `None` / `Some("anthropic")` → false (Anthropic-hosted).
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

fn apply_toggle(target: &mut bool, source: &Option<IntegrationConfig>) {
    if let Some(cfg) = source {
        if let Some(enabled) = cfg.enabled {
            *target = enabled;
        }
    }
}

/// Applies one integrations layer over the resolved result.
fn apply_integrations_layer(result: &mut ResolvedIntegrationsConfig, layer: &IntegrationsConfig) {
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
    // Durable atomic write (fsync data + parent dir).
    crate::fs_perms::write_restricted_file_atomic(path, &content)
}

/// Runs `f` holding an exclusive lock on `<data_dir>/config.lock` (serialises
/// CLI/Desktop read-modify-write of `config.json`); explicit data dir variant.
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

/// Runs `f` holding an exclusive lock on `~/.speedwave/config.lock`.
/// Delegates to `with_config_lock_in` with `consts::data_dir()`.
pub fn with_config_lock<F, T>(f: F) -> anyhow::Result<T>
where
    F: FnOnce() -> anyhow::Result<T>,
{
    with_config_lock_in(crate::consts::data_dir(), f)
}

/// One-shot self-heal: migrate every project's LLM config and persist if
/// changed. Idempotent once all are at [`LLM_SCHEMA_VERSION`]; under the config lock.
pub fn heal_llm_config_on_disk() -> anyhow::Result<()> {
    heal_llm_config_in(crate::consts::data_dir())
}

/// Testable variant of [`heal_llm_config_on_disk`] with an explicit data dir.
pub fn heal_llm_config_in(data_dir: &Path) -> anyhow::Result<()> {
    with_config_lock_in(data_dir, || {
        let config_path = data_dir.join("config.json");
        let mut config = load_user_config_from(&config_path)?;
        let mut changed = false;
        for project in &mut config.projects {
            let evidence = AnthropicEvidence::detect_in(data_dir, &project.name);
            let has_llm = project.claude.as_ref().is_some_and(|c| c.llm.is_some());
            if has_llm {
                if let Some(llm) = project.claude.as_mut().and_then(|c| c.llm.as_mut()) {
                    changed |= migrate_llm(llm, evidence);
                }
            } else if evidence != AnthropicEvidence::None {
                // v0.13.3 default population: no llm block but working Anthropic
                // credentials — fabricate the entry so the project keeps chatting.
                let mut llm = LlmConfig::default();
                migrate_llm(&mut llm, evidence);
                project.claude.get_or_insert_with(Default::default).llm = Some(llm);
                changed = true;
            }
        }
        if changed {
            save_user_config_to(&config, &config_path)?;
            log::info!("llm config: healed on-disk config to schema v{LLM_SCHEMA_VERSION}");
        }
        Ok(())
    })
}

fn merge_env(base: &mut HashMap<String, String>, overlay: Option<HashMap<String, String>>) {
    if let Some(overlay) = overlay {
        for (key, value) in overlay {
            base.insert(key, value);
        }
    }
}

/// Anthropic auth/routing env keys a repo `.speedwave.json` must never set
/// (hijack risk); `ANTHROPIC_MODEL` stays allowed as a documented override.
const REPO_ENV_DENY_ANTHROPIC: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS",
];

/// Strips security-class keys (Anthropic auth/routing + `RESERVED_ENV_KEYS`,
/// case-insensitive) from a repo-layer `claude.env`; user config is unaffected.
fn sanitize_repo_env(env: Option<HashMap<String, String>>) -> Option<HashMap<String, String>> {
    env.map(|mut map| {
        map.retain(|key, _| !repo_env_key_is_denied(key));
        map
    })
}

/// True when `key` matches (case-insensitively) a repo-layer deny-list entry;
/// telemetry keys come from the `telemetry_env` SSOT (ADR-076).
fn repo_env_key_is_denied(key: &str) -> bool {
    let telemetry_denied = std::iter::once(crate::telemetry_env::ENABLE_KEY).chain(
        crate::telemetry_env::TelemetryField::ALL
            .iter()
            .filter_map(|f| crate::telemetry_env::env_key_for(*f)),
    );
    REPO_ENV_DENY_ANTHROPIC
        .iter()
        .copied()
        .chain(crate::consts::RESERVED_ENV_KEYS.iter().copied())
        .chain(telemetry_denied)
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
    // v2 (ADR-073): the user layer carries the provider list wholesale.
    if overlay.schema_version.is_some() {
        base.schema_version = overlay.schema_version;
    }
    if overlay.proxy_enabled.is_some() {
        base.proxy_enabled = overlay.proxy_enabled;
    }
    if !overlay.providers.is_empty() {
        base.providers.clone_from(&overlay.providers);
    }
    if overlay.active.is_some() {
        base.active.clone_from(&overlay.active);
    }
}

/// Merge LLM config from repo source; provider/base_url/v2-fields ignored (SSRF prevention).
/// Only model is merged as a suggestion; see ADR-073 for the full SSRF policy.
fn merge_llm_repo(base: &mut LlmConfig, overlay: &LlmConfig) {
    if overlay.model.is_some() {
        base.model.clone_from(&overlay.model);
    }
}

/// Removes the obsolete `log_level` field from `<data_dir>/config.json`;
/// `Ok(true)` = removed. Unknown fields preserved (operates on `Value`).
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
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test fixtures assert on setup that must not silently fail"
)]
mod tests {
    use super::*;
    use std::io::Write;

    fn anthropic_entry() -> LlmProviderEntry {
        LlmProviderEntry {
            id: "anthropic".into(),
            kind: LlmProviderKind::AnthropicOauth,
            base_url: None,
            model: None,
            has_api_key: false,
            context_tokens: None,
            has_custom_headers: false,
        }
    }

    #[test]
    fn is_unconfigured_true_for_fresh_default() {
        // Never-touched project: no llm override fields set at all → render must refuse.
        assert!(LlmConfig::default().is_unconfigured());
        assert!(!LlmConfig::default().is_logged_out());
    }

    #[test]
    fn is_unconfigured_true_for_explicit_logout() {
        // Emptied v2 (logout): schema + providers + no active → both true,
        // is_logged_out picks the distinct "Run speedwave login" wording.
        let llm = LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![anthropic_entry()],
            active: None,
            ..Default::default()
        };
        assert!(llm.is_unconfigured());
        assert!(llm.is_logged_out());
    }

    #[test]
    fn is_unconfigured_true_for_dangling_active() {
        // Dangling active (points at a missing entry) is unconfigured: render
        // must refuse rather than silently fall back to the Anthropic default
        // for a config that names a provider id which doesn't exist.
        let llm = LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![],
            active: Some(LlmActive {
                provider_id: "ghost".into(),
                model: None,
            }),
            ..Default::default()
        };
        assert!(llm.is_unconfigured());
        // Not a logout (active is Some, just dangling) — distinct bail wording.
        assert!(!llm.is_logged_out());
    }

    #[test]
    fn is_unconfigured_true_for_legacy_v1_with_provider_before_migration() {
        // Legacy `provider` alone is not resolvable until migrated.
        let llm = LlmConfig {
            provider: Some("anthropic".into()),
            ..Default::default()
        };
        assert!(llm.is_unconfigured());
    }

    #[test]
    fn is_unconfigured_false_for_configured_v2() {
        let llm = LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![anthropic_entry()],
            active: Some(LlmActive {
                provider_id: "anthropic".into(),
                model: None,
            }),
            ..Default::default()
        };
        assert!(!llm.is_unconfigured());
    }

    #[test]
    fn unhealed_config_with_providers_no_active_is_unconfigured() {
        // Regression: a not-yet-healed config (no schema, but providers + no
        // active) has no resolvable active provider → unconfigured.
        let llm = LlmConfig {
            schema_version: None,
            providers: vec![anthropic_entry()],
            active: None,
            ..Default::default()
        };
        assert!(llm.is_unconfigured());
    }

    #[test]
    fn anthropic_provider_id_is_pinned_for_on_disk_compat() {
        // Persisted config.json files carry this id — changing it orphans them.
        assert_eq!(ANTHROPIC_PROVIDER_ID, "anthropic");
    }

    #[test]
    fn set_active_to_anthropic_selects_existing_entry() {
        let mut llm = LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![anthropic_entry()],
            active: None,
            ..Default::default()
        };
        assert!(llm.set_active_to_anthropic());
        assert_eq!(llm.active.as_ref().unwrap().provider_id, "anthropic");
        assert_eq!(
            llm.active.as_ref().unwrap().model,
            None,
            "entry has no model — pointer stays empty"
        );
        assert_eq!(llm.providers.len(), 1, "no duplicate entry added");
        assert!(!llm.is_unconfigured());
    }

    #[test]
    fn set_active_to_anthropic_mirrors_existing_entry_model() {
        // Previously selected Anthropic model (per-provider SSOT) is not discarded.
        let mut llm = LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![LlmProviderEntry {
                model: Some("claude-opus-4-6".into()),
                ..anthropic_entry()
            }],
            active: None,
            ..Default::default()
        };
        assert!(llm.set_active_to_anthropic());
        let active = llm.active.as_ref().unwrap();
        assert_eq!(active.model.as_deref(), Some("claude-opus-4-6"));
        assert_eq!(
            llm.effective_active_model().as_deref(),
            Some("claude-opus-4-6")
        );
    }

    #[test]
    fn set_active_to_anthropic_clears_foreign_entry_model() {
        // Corrupt pre-quarantine state: a provider/model shape under an
        // Anthropic entry must not leak into the active pointer.
        let mut llm = LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![LlmProviderEntry {
                model: Some("openrouter/z-ai/glm-5.2".into()),
                ..anthropic_entry()
            }],
            active: None,
            ..Default::default()
        };
        assert!(llm.set_active_to_anthropic());
        assert_eq!(llm.active.as_ref().unwrap().model, None);
    }

    #[test]
    fn set_active_to_anthropic_adds_entry_when_absent() {
        // Switching from an active non-Anthropic entry: its model must not
        // carry over to the fresh Anthropic entry's pointer.
        let mut llm = LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![LlmProviderEntry {
                id: "local".into(),
                kind: LlmProviderKind::Local,
                base_url: Some("http://host.docker.internal:1234".into()),
                model: Some("qwen".into()),
                has_api_key: false,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: Some(LlmActive {
                provider_id: "local".into(),
                model: Some("qwen".into()),
            }),
            ..Default::default()
        };
        assert!(llm.set_active_to_anthropic());
        assert_eq!(llm.active.as_ref().unwrap().provider_id, "anthropic");
        assert_eq!(
            llm.active.as_ref().unwrap().model,
            None,
            "local model must not follow the provider switch"
        );
        assert!(llm.providers.iter().any(|p| p.kind.is_anthropic()));
    }

    #[test]
    fn set_active_to_anthropic_noop_when_already_active() {
        let mut llm = LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![LlmProviderEntry {
                model: Some("claude-opus-4-6".into()),
                ..anthropic_entry()
            }],
            active: Some(LlmActive {
                provider_id: "anthropic".into(),
                model: None,
            }),
            ..Default::default()
        };
        assert!(
            !llm.set_active_to_anthropic(),
            "no change when already active"
        );
        assert_eq!(
            llm.active.as_ref().unwrap().model,
            None,
            "noop must not rewrite the pointer (migrate_llm reconciles it)"
        );
    }

    // ---- LlmProviderKind Rust↔TS mirror (ADR-073) ---------------------------

    #[test]
    fn llm_provider_kind_matches_ts_union() {
        // TS union must list exactly the Rust serde strings (cf. allowed_auth_field_types_match_ts_union).
        let all = [
            LlmProviderKind::AnthropicOauth,
            LlmProviderKind::AnthropicApiKey,
            LlmProviderKind::Local,
            LlmProviderKind::OpenRouter,
        ];
        // Exhaustiveness gate: a new variant fails to compile until added above.
        for kind in all {
            match kind {
                LlmProviderKind::AnthropicOauth
                | LlmProviderKind::AnthropicApiKey
                | LlmProviderKind::Local
                | LlmProviderKind::OpenRouter => {}
            }
        }
        let mut rust_kinds: Vec<String> = all
            .iter()
            .map(|k| {
                serde_json::to_value(k)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        rust_kinds.sort();

        let src = include_str!("../../../desktop/src/src/app/models/llm.ts");
        let re = regex::Regex::new(r"export\s+type\s+LlmProviderKind\s*=\s*([^;]+);").unwrap();
        let cap = re
            .captures(src)
            .expect("llm.ts must declare `export type LlmProviderKind`");
        let mut ts_kinds: Vec<String> = cap[1]
            .split('|')
            .map(|s| s.trim().trim_matches(['\'', '"']).to_string())
            .filter(|s| !s.is_empty())
            .collect();
        ts_kinds.sort();

        assert_eq!(
            rust_kinds, ts_kinds,
            "TS LlmProviderKind union must match Rust LlmProviderKind serde strings"
        );
    }

    #[test]
    fn otlp_protocol_matches_ts() {
        let all = [
            OtlpProtocol::Grpc,
            OtlpProtocol::HttpProtobuf,
            OtlpProtocol::HttpJson,
        ];
        // Exhaustiveness gate: a new variant fails to compile until added above.
        for p in all {
            match p {
                OtlpProtocol::Grpc | OtlpProtocol::HttpProtobuf | OtlpProtocol::HttpJson => {}
            }
        }
        let mut rust: Vec<String> = all
            .iter()
            .map(|p| {
                serde_json::to_value(p)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        rust.sort();

        let src = include_str!("../../../desktop/src/src/app/models/telemetry.ts");
        let re = regex::Regex::new(r"export\s+type\s+OtlpProtocol\s*=\s*([^;]+);").unwrap();
        let cap = re
            .captures(src)
            .expect("telemetry.ts must declare `export type OtlpProtocol`");
        let mut ts: Vec<String> = cap[1]
            .split('|')
            .map(|s| s.trim().trim_matches(['\'', '"']).to_string())
            .filter(|s| !s.is_empty())
            .collect();
        ts.sort();

        assert_eq!(
            rust, ts,
            "TS OtlpProtocol union must match Rust OtlpProtocol serde strings"
        );
    }

    #[test]
    fn telemetry_locks_field_set_matches_ts() {
        // Every TelemetryField's snake_case name must appear as a key in the TS
        // TelemetryLocks interface, so a renamed/added field can't silently drift.
        use crate::telemetry_env::TelemetryField as F;
        let field_names = [
            (F::Enabled, "enabled"),
            (F::Endpoint, "endpoint"),
            (F::Protocol, "protocol"),
            (F::ExportMetrics, "export_metrics"),
            (F::ExportLogs, "export_logs"),
            (F::Headers, "headers"),
            (F::ResourceAttributes, "resource_attributes"),
            (F::IncludeAccountUuid, "include_account_uuid"),
            (F::LogUserPrompts, "log_user_prompts"),
            (F::LogAssistantResponses, "log_assistant_responses"),
            (F::LogToolDetails, "log_tool_details"),
            (F::LogRawApiBodies, "log_raw_api_bodies"),
            (F::MetricExportInterval, "metric_export_interval_ms"),
            (F::LogsExportInterval, "logs_export_interval_ms"),
        ];
        // Exhaustiveness: covers every variant (compile error if one is missing).
        assert_eq!(field_names.len(), F::ALL.len());

        let src = include_str!("../../../desktop/src/src/app/models/telemetry.ts");
        let re = regex::Regex::new(r"export\s+interface\s+TelemetryLocks\s*\{([^}]*)\}").unwrap();
        let body = re
            .captures(src)
            .expect("telemetry.ts must declare `export interface TelemetryLocks`")[1]
            .to_string();
        for (_f, name) in field_names {
            assert!(
                body.contains(&format!("{name}:")),
                "TelemetryLocks in telemetry.ts is missing field '{name}'"
            );
        }
    }

    // ---- Transcription config retired (ADR-056) -----------------------------

    #[test]
    fn old_user_config_with_a_transcription_block_still_loads() {
        // The `transcription` field was removed; a config still carrying the
        // block must deserialize fine (the key is tolerated as unknown).
        let old_json = r#"{
            "projects": [],
            "transcription": {
                "enabled": true,
                "default_language": "pl",
                "default_live_model": "small",
                "keep_audio_after_finalize": false
            },
            "ui": { "beta_enabled": true }
        }"#;
        let cfg: SpeedwaveUserConfig = serde_json::from_str(old_json).expect("deserialize");
        assert!(cfg.beta_enabled(), "the rest of the config still parses");
        let json_back = serde_json::to_string(&cfg).expect("reserialize");
        assert!(
            !json_back.contains("transcription"),
            "the retired field is not re-emitted; got {json_back}"
        );
    }

    #[test]
    fn repo_config_has_no_transcription_field() {
        // Repo .speedwave.json has no transcription field — a stray key is dropped.
        let repo_json = r#"{
            "claude": null,
            "integrations": null,
            "transcription": { "enabled": true }
        }"#;
        let parsed: ProjectRepoConfig = serde_json::from_str(repo_json).expect("repo parse");
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

    /// `sync_has_api_key_from_disk_in` derives the flag from the key file's
    /// existence, overriding whatever was persisted (stale-true and stale-false).
    #[test]
    fn sync_has_api_key_from_disk_overrides_persisted_flag() {
        let dir = tempfile::tempdir().unwrap();
        let provider = |id: &str, has_api_key: bool| LlmProviderEntry {
            id: id.into(),
            kind: LlmProviderKind::OpenRouter,
            base_url: None,
            model: None,
            has_api_key,
            context_tokens: None,
            has_custom_headers: false,
        };
        let mut llm = LlmConfig {
            providers: vec![
                // Persisted true, but no key file on disk → must flip to false.
                provider("stale-true", true),
                // Persisted false, but key file exists → must flip to true.
                provider("stale-false", false),
            ],
            ..Default::default()
        };
        crate::compose::write_llm_provider_key_in(dir.path(), "proj", "stale-false", "sk-x")
            .unwrap();

        llm.sync_has_api_key_from_disk_in(dir.path(), "proj");

        assert!(!llm.providers[0].has_api_key, "no key file → false");
        assert!(llm.providers[1].has_api_key, "key file present → true");
    }

    /// Edge: empty provider list is a no-op (no panic, nothing to sync).
    #[test]
    fn sync_has_api_key_from_disk_empty_providers_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let mut llm = LlmConfig::default();
        llm.sync_has_api_key_from_disk_in(dir.path(), "proj");
        assert!(llm.providers.is_empty());
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
        // `is_local_provider` and `LOCAL_PROVIDERS` must stay in sync.
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
        assert!(resolved.flags.iter().any(|f| f == "--ide"));
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
        // A repo `.speedwave.json` cannot enable telemetry (deny-listed, ADR-076);
        // the compiled default stays off.
        assert_eq!(
            resolved.env.get("CLAUDE_CODE_ENABLE_TELEMETRY"),
            Some(&"0".to_string())
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
                        // User can override the base_env default.
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
            ui: None,
            telemetry: None,
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

    // ── telemetry: resolve_telemetry ────────────────────────────────────────

    #[test]
    fn telemetry_defaults_off_when_no_config() {
        let r = resolve_telemetry(None, None).unwrap();
        assert!(!r.enabled);
        assert!(!r.any_locked);
        assert!(!r.kill_switch);
        assert!(r.endpoint.is_none());
    }

    #[test]
    fn telemetry_user_values_pass_through_when_no_mdm() {
        let user = TelemetryConfig {
            enabled: Some(true),
            endpoint: Some("https://collector.example.com:4318".into()),
            export_metrics: Some(true),
            ..Default::default()
        };
        let r = resolve_telemetry(Some(&user), None).unwrap();
        assert!(r.enabled);
        assert_eq!(
            r.endpoint.as_deref(),
            Some("https://collector.example.com:4318")
        );
        assert!(!r.any_locked);
    }

    #[test]
    fn telemetry_mdm_wins_per_field_and_locks() {
        let user = TelemetryConfig {
            enabled: Some(true),
            endpoint: Some("https://user.example.com:4318".into()),
            export_metrics: Some(true),
            ..Default::default()
        };
        let managed = ManagedTelemetryConfig {
            endpoint: Some("https://corp.example.com:4318".into()),
            ..Default::default()
        };
        let r = resolve_telemetry(Some(&user), Some(&managed)).unwrap();
        assert_eq!(r.endpoint.as_deref(), Some("https://corp.example.com:4318"));
        assert!(r.any_locked);
        assert!(r.locked_keys.contains("OTEL_EXPORTER_OTLP_ENDPOINT"));
        assert!(r.enabled);
    }

    #[test]
    fn telemetry_every_managed_field_reaches_resolved() {
        // Guards the merge seam: every value below differs from the Resolved
        // default, so a field forgotten in resolve_telemetry fails the assert.
        let managed = ManagedTelemetryConfig {
            enabled: Some(true),
            endpoint: Some("https://corp.example.com:4318".into()),
            protocol: Some(OtlpProtocol::HttpJson),
            export_metrics: Some(true),
            export_logs: Some(true),
            headers: Some("Authorization=Bearer x".into()),
            resource_attributes: Some("a=b".into()),
            include_account_uuid: Some(true),
            log_user_prompts: Some(true),
            log_assistant_responses: Some(true),
            log_tool_details: Some(true),
            log_raw_api_bodies: Some(true),
            metric_export_interval_ms: Some(5000),
            logs_export_interval_ms: Some(7000),
        };
        let r = resolve_telemetry(None, Some(&managed)).unwrap();
        assert!(r.enabled);
        assert_eq!(r.endpoint.as_deref(), Some("https://corp.example.com:4318"));
        assert_eq!(r.protocol, OtlpProtocol::HttpJson);
        assert!(r.export_metrics);
        assert!(r.export_logs);
        assert_eq!(r.headers.as_deref(), Some("Authorization=Bearer x"));
        assert_eq!(r.resource_attributes.as_deref(), Some("a=b"));
        assert!(r.include_account_uuid);
        assert!(r.log_user_prompts);
        assert!(r.log_assistant_responses);
        assert!(r.log_tool_details);
        assert!(r.log_raw_api_bodies);
        assert_eq!(r.metric_export_interval_ms, Some(5000));
        assert_eq!(r.logs_export_interval_ms, Some(7000));
    }

    #[test]
    fn telemetry_kill_switch_suppresses_all_output() {
        let user = TelemetryConfig {
            enabled: Some(true),
            endpoint: Some("https://user.example.com:4318".into()),
            headers: Some("Authorization=Bearer x".into()),
            export_metrics: Some(true),
            ..Default::default()
        };
        let managed = ManagedTelemetryConfig {
            enabled: Some(false),
            ..Default::default()
        };
        let r = resolve_telemetry(Some(&user), Some(&managed)).unwrap();
        assert!(r.kill_switch);
        assert!(!r.enabled);
        assert!(r.endpoint.is_none());
        assert!(r.headers.is_none());
        assert!(!r.export_metrics);
        // P0: the master switch itself is locked, so it is re-forced / written to managed-settings.
        assert!(r.locked_keys.contains("CLAUDE_CODE_ENABLE_TELEMETRY"));
    }

    #[test]
    fn telemetry_locked_enabled_without_endpoint_is_error() {
        let managed = ManagedTelemetryConfig {
            enabled: Some(true),
            ..Default::default()
        };
        assert!(
            resolve_telemetry(None, Some(&managed)).is_err(),
            "locked enabled=true with no endpoint must fail-closed"
        );
    }

    #[test]
    fn telemetry_mdm_enabled_lock_is_in_locked_keys_both_directions() {
        let off = ManagedTelemetryConfig {
            enabled: Some(false),
            ..Default::default()
        };
        assert!(resolve_telemetry(None, Some(&off))
            .unwrap()
            .locked_keys
            .contains("CLAUDE_CODE_ENABLE_TELEMETRY"));
        let on = ManagedTelemetryConfig {
            enabled: Some(true),
            endpoint: Some("https://c.example.com:4318".into()),
            export_metrics: Some(true),
            ..Default::default()
        };
        assert!(resolve_telemetry(None, Some(&on))
            .unwrap()
            .locked_keys
            .contains("CLAUDE_CODE_ENABLE_TELEMETRY"));
    }

    #[test]
    fn telemetry_kill_switch_still_records_co_locked_fields() {
        // MDM turns telemetry off AND separately locks a privacy gate; the
        // early-return path must still carry both locks.
        let managed = ManagedTelemetryConfig {
            enabled: Some(false),
            log_user_prompts: Some(true),
            ..Default::default()
        };
        let r = resolve_telemetry(None, Some(&managed)).unwrap();
        assert!(r.kill_switch);
        assert!(r.locked_keys.contains("CLAUDE_CODE_ENABLE_TELEMETRY"));
        assert!(r.locked_keys.contains("OTEL_LOG_USER_PROMPTS"));
    }

    #[test]
    fn telemetry_rejects_non_http_endpoint() {
        let u = TelemetryConfig {
            enabled: Some(true),
            endpoint: Some("ftp://x/".into()),
            export_metrics: Some(true),
            ..Default::default()
        };
        assert!(resolve_telemetry(Some(&u), None).is_err());
    }

    #[test]
    fn telemetry_allows_onprem_loopback_endpoint() {
        let u = TelemetryConfig {
            enabled: Some(true),
            endpoint: Some("http://localhost:4318".into()),
            export_metrics: Some(true),
            ..Default::default()
        };
        // localhost DNS name is NOT loopback; the loopback literal 127.0.0.1 is.
        assert!(resolve_telemetry(Some(&u), None).is_err());
        let u2 = TelemetryConfig {
            enabled: Some(true),
            endpoint: Some("http://127.0.0.1:4318".into()),
            export_metrics: Some(true),
            ..Default::default()
        };
        assert!(resolve_telemetry(Some(&u2), None).is_ok());
    }

    #[test]
    fn telemetry_rejects_headers_with_control_chars() {
        let u = TelemetryConfig {
            enabled: Some(true),
            endpoint: Some("https://c.example.com:4318".into()),
            headers: Some("Authorization=Bearer x\r\nInjected: y".into()),
            export_metrics: Some(true),
            ..Default::default()
        };
        assert!(resolve_telemetry(Some(&u), None).is_err());
    }

    #[test]
    fn telemetry_preserves_bearer_token_with_equals_padding() {
        let u = TelemetryConfig {
            enabled: Some(true),
            endpoint: Some("https://c.example.com:4318".into()),
            headers: Some("Authorization=Bearer abc==".into()),
            export_metrics: Some(true),
            ..Default::default()
        };
        let r = resolve_telemetry(Some(&u), None).unwrap();
        assert_eq!(r.headers.as_deref(), Some("Authorization=Bearer abc=="));
    }

    #[test]
    fn telemetry_rejects_zero_export_interval() {
        let base = TelemetryConfig {
            enabled: Some(true),
            endpoint: Some("https://c.example.com:4318".into()),
            export_metrics: Some(true),
            ..Default::default()
        };
        let metric_zero = TelemetryConfig {
            metric_export_interval_ms: Some(0),
            ..base.clone()
        };
        assert!(resolve_telemetry(Some(&metric_zero), None).is_err());
        let logs_zero = TelemetryConfig {
            logs_export_interval_ms: Some(0),
            ..base.clone()
        };
        assert!(resolve_telemetry(Some(&logs_zero), None).is_err());
        let ok = TelemetryConfig {
            metric_export_interval_ms: Some(60000),
            ..base
        };
        assert!(resolve_telemetry(Some(&ok), None).is_ok());
    }

    #[test]
    fn telemetry_port_protocol_mismatch_is_advisory_not_error() {
        // A mismatched port only warns; resolve still succeeds.
        let grpc_on_http_port = TelemetryConfig {
            enabled: Some(true),
            endpoint: Some("https://c.example.com:4318".into()),
            protocol: Some(OtlpProtocol::Grpc),
            export_metrics: Some(true),
            ..Default::default()
        };
        assert!(resolve_telemetry(Some(&grpc_on_http_port), None).is_ok());
        let http_on_grpc_port = TelemetryConfig {
            enabled: Some(true),
            endpoint: Some("https://c.example.com:4317".into()),
            protocol: Some(OtlpProtocol::HttpProtobuf),
            export_metrics: Some(true),
            ..Default::default()
        };
        assert!(resolve_telemetry(Some(&http_on_grpc_port), None).is_ok());
    }

    #[test]
    fn mdm_locked_telemetry_key_overrides_user_env() {
        let tmp = tempfile::tempdir().unwrap();
        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "p".into(),
                dir: tmp.path().to_string_lossy().to_string(),
                claude: Some(ClaudeOverrides {
                    env: Some(HashMap::from([(
                        "OTEL_EXPORTER_OTLP_ENDPOINT".into(),
                        "https://user-evil.example.com:4318".into(),
                    )])),
                    settings: None,
                    llm: None,
                }),
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };
        let managed = ManagedTelemetryConfig {
            enabled: Some(true),
            endpoint: Some("https://corp.example.com:4318".into()),
            export_metrics: Some(true),
            ..Default::default()
        };
        let resolved = resolve_project_config_in_with_managed(
            tmp.path(),
            tmp.path(),
            &user_config,
            "p",
            Some(&managed),
        )
        .0;
        assert_eq!(
            resolved.env.get("OTEL_EXPORTER_OTLP_ENDPOINT"),
            Some(&"https://corp.example.com:4318".to_string()),
            "user claude.env must NOT override an MDM-locked telemetry key"
        );
        assert_eq!(
            resolved.env.get("CLAUDE_CODE_ENABLE_TELEMETRY"),
            Some(&"1".to_string())
        );
    }

    #[test]
    fn mdm_kill_switch_overrides_user_enable_env() {
        let tmp = tempfile::tempdir().unwrap();
        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "p".into(),
                dir: tmp.path().to_string_lossy().to_string(),
                claude: Some(ClaudeOverrides {
                    env: Some(HashMap::from([(
                        "CLAUDE_CODE_ENABLE_TELEMETRY".into(),
                        "1".into(),
                    )])),
                    settings: None,
                    llm: None,
                }),
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };
        let managed = ManagedTelemetryConfig {
            enabled: Some(false),
            ..Default::default()
        };
        let resolved = resolve_project_config_in_with_managed(
            tmp.path(),
            tmp.path(),
            &user_config,
            "p",
            Some(&managed),
        )
        .0;
        assert_eq!(
            resolved.env.get("CLAUDE_CODE_ENABLE_TELEMETRY"),
            Some(&"0".to_string()),
            "MDM kill-switch must win over a user claude.env CLAUDE_CODE_ENABLE_TELEMETRY=1"
        );
    }

    #[test]
    fn user_telemetry_endpoint_reaches_env_without_mdm() {
        let tmp = tempfile::tempdir().unwrap();
        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "p".into(),
                dir: tmp.path().to_string_lossy().to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: Some(TelemetryConfig {
                enabled: Some(true),
                endpoint: Some("https://mine.example.com:4318".into()),
                export_metrics: Some(true),
                ..Default::default()
            }),
        };
        let resolved =
            resolve_project_config_in_with_managed(tmp.path(), tmp.path(), &user_config, "p", None)
                .0;
        assert_eq!(
            resolved.env.get("OTEL_EXPORTER_OTLP_ENDPOINT"),
            Some(&"https://mine.example.com:4318".to_string())
        );
    }

    #[test]
    fn mdm_load_error_fails_closed_and_disables_telemetry() {
        let tmp = tempfile::tempdir().unwrap();
        // User has telemetry ON; a broken MDM policy must still shut it off.
        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "p".into(),
                dir: tmp.path().to_string_lossy().to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: Some(TelemetryConfig {
                enabled: Some(true),
                endpoint: Some("https://mine.example.com:4318".into()),
                export_metrics: Some(true),
                ..Default::default()
            }),
        };
        let resolved = resolve_project_config_in_with_load(
            tmp.path(),
            tmp.path(),
            &user_config,
            "p",
            Err(anyhow::anyhow!("managed config /x is invalid: boom")),
        )
        .0;
        assert!(
            !resolved.telemetry.enabled
                && !resolved.env.contains_key("OTEL_EXPORTER_OTLP_ENDPOINT"),
            "telemetry must fail closed (disabled, no OTEL env) when the MDM policy cannot be read"
        );
    }

    #[test]
    fn mdm_load_ok_none_leaves_user_telemetry_intact() {
        let tmp = tempfile::tempdir().unwrap();
        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "p".into(),
                dir: tmp.path().to_string_lossy().to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: Some(TelemetryConfig {
                enabled: Some(true),
                endpoint: Some("https://mine.example.com:4318".into()),
                export_metrics: Some(true),
                ..Default::default()
            }),
        };
        let resolved = resolve_project_config_in_with_load(
            tmp.path(),
            tmp.path(),
            &user_config,
            "p",
            Ok(None),
        )
        .0;
        assert_eq!(
            resolved.env.get("OTEL_EXPORTER_OTLP_ENDPOINT"),
            Some(&"https://mine.example.com:4318".to_string()),
            "absent MDM policy (Ok(None)) must not disturb user telemetry"
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
                        ..Default::default()
                    }),
                }),
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };

        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        // User config wins; v1→v2 migration normalises `ollama` to `local`.
        assert_eq!(resolved.llm.provider.as_deref(), Some("local"));
        assert_eq!(resolved.llm.model.as_deref(), Some("llama3.3"));
        assert_eq!(
            resolved.llm.base_url.as_deref(),
            Some("http://host.docker.internal:11434")
        );
        // And the v2 shape carries the same selection.
        let active = resolved.llm.active.as_ref().expect("active set");
        assert_eq!(active.provider_id, "local");
        assert_eq!(active.model.as_deref(), Some("llama3.3"));
        let entry = resolved.llm.active_provider().expect("entry");
        assert_eq!(entry.kind, LlmProviderKind::Local);
        assert_eq!(
            entry.base_url.as_deref(),
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
        // Repo provider/base_url ignored (SSRF, ADR-040): with no user-side
        // override either, the project has no real config — stays unconfigured.
        assert_eq!(resolved.llm.provider, None);
        assert_eq!(resolved.llm.base_url, None);
        assert!(resolved.llm.active.is_none());
        assert!(resolved.llm.active_provider().is_none());
        assert!(resolved.llm.is_unconfigured());
    }

    /// ADR-073: a repo `.speedwave.json` must not be able to inject the v2
    /// fields either — providers (base URLs!), active selection, schema.
    #[test]
    fn test_repo_config_cannot_set_v2_providers_or_active() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join(".speedwave.json");
        let mut f = std::fs::File::create(&config_path).unwrap();
        write!(
            f,
            r#"{{
                "claude": {{
                    "llm": {{
                        "schema_version": 2,
                        "providers": [{{
                            "id": "evil",
                            "kind": "local",
                            "base_url": "http://attacker.example.com/v1",
                            "has_api_key": true
                        }}],
                        "active": {{ "provider_id": "evil", "model": "x" }}
                    }}
                }}
            }}"#
        )
        .unwrap();

        let user_config = SpeedwaveUserConfig::default();
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        assert!(
            !resolved.llm.providers.iter().any(|p| p.id == "evil"),
            "repo must not inject providers: {:?}",
            resolved.llm.providers
        );
        assert_ne!(
            resolved.llm.active.as_ref().map(|a| a.provider_id.as_str()),
            Some("evil"),
            "repo must not switch the active provider"
        );
    }

    /// Migration unit coverage: every legacy shape lands in the right kind,
    /// the lift is idempotent, and the downgrade fields round-trip.
    #[test]
    fn test_migrate_llm_variants() {
        // anthropic + secret → AnthropicApiKey
        let mut llm = LlmConfig {
            provider: Some("anthropic".into()),
            model: Some("claude-opus-4-8".into()),
            ..Default::default()
        };
        migrate_llm(&mut llm, AnthropicEvidence::ApiKey);
        assert_eq!(llm.schema_version, Some(LLM_SCHEMA_VERSION));
        let entry = llm.active_provider().expect("entry");
        assert_eq!(entry.kind, LlmProviderKind::AnthropicApiKey);
        assert!(entry.has_api_key);
        assert_eq!(
            llm.active.as_ref().unwrap().model.as_deref(),
            Some("claude-opus-4-8")
        );

        // anthropic without secret → AnthropicOauth
        let mut llm = LlmConfig {
            provider: Some("anthropic".into()),
            ..Default::default()
        };
        migrate_llm(&mut llm, AnthropicEvidence::None);
        assert_eq!(
            llm.active_provider().unwrap().kind,
            LlmProviderKind::AnthropicOauth
        );

        // truly fresh (provider unset) → no-op, stays unconfigured. Render
        // must refuse to start rather than fabricate an Anthropic session.
        let mut llm = LlmConfig::default();
        migrate_llm(&mut llm, AnthropicEvidence::None);
        assert!(llm.active_provider().is_none());
        assert!(llm.providers.is_empty());
        assert!(llm.is_unconfigured());
        // Schema is still stamped (idempotent re-entry), but no provider/active
        // is fabricated and the legacy flat field stays unset.
        assert_eq!(llm.schema_version, Some(LLM_SCHEMA_VERSION));
        assert_eq!(llm.provider, None);

        // every legacy local alias → Local, base_url + flags carried over
        for alias in LOCAL_PROVIDERS {
            let mut llm = LlmConfig {
                provider: Some((*alias).into()),
                model: Some("qwen".into()),
                base_url: Some("http://host.docker.internal:9000".into()),
                context_tokens: Some(131072),
                has_api_key: true,
                has_custom_headers: true,
                ..Default::default()
            };
            migrate_llm(&mut llm, AnthropicEvidence::None);
            let entry = llm
                .active_provider()
                .unwrap_or_else(|| panic!("alias '{alias}' must migrate to an active entry"));
            assert_eq!(entry.kind, LlmProviderKind::Local);
            assert_eq!(
                entry.base_url.as_deref(),
                Some("http://host.docker.internal:9000")
            );
            assert!(entry.has_api_key && entry.has_custom_headers);
            assert_eq!(entry.context_tokens, Some(131072));
            // Downgrade fields: alias normalised to `local`.
            assert_eq!(llm.provider.as_deref(), Some("local"));
            assert_eq!(llm.model.as_deref(), Some("qwen"));
        }

        // Idempotence: re-running must not duplicate or rebuild entries.
        let mut llm = LlmConfig {
            provider: Some("local".into()),
            base_url: Some("http://host.docker.internal:8080".into()),
            ..Default::default()
        };
        migrate_llm(&mut llm, AnthropicEvidence::None);
        let first = serde_json::to_string(&llm).unwrap();
        migrate_llm(&mut llm, AnthropicEvidence::ApiKey); // even with secret flag flipped
        assert_eq!(first, serde_json::to_string(&llm).unwrap());
    }

    #[test]
    fn test_is_anthropic_and_foreign_model_predicates() {
        assert!(LlmProviderKind::AnthropicOauth.is_anthropic());
        assert!(LlmProviderKind::AnthropicApiKey.is_anthropic());
        assert!(!LlmProviderKind::Local.is_anthropic());
        assert!(!LlmProviderKind::OpenRouter.is_anthropic());
        // Foreign = provider/model shape, NOT catalog membership.
        assert!(is_foreign_anthropic_model("nex-agi/nex-n2-pro:free"));
        assert!(is_foreign_anthropic_model("openrouter/z-ai/glm-5.2"));
        assert!(!is_foreign_anthropic_model("claude-opus-4-8"));
        assert!(!is_foreign_anthropic_model("claude-opus-4-1")); // retired but kept
        assert!(!is_foreign_anthropic_model(""));
    }

    /// `effective_active_model` enforces provenance: a foreign `active.model`
    /// under an Anthropic entry must never be returned as the routing model.
    #[test]
    fn test_effective_active_model_enforces_provenance() {
        let entry = |id: &str, kind, model: Option<&str>| LlmProviderEntry {
            id: id.into(),
            kind,
            base_url: None,
            model: model.map(str::to_string),
            has_api_key: false,
            context_tokens: None,
            has_custom_headers: false,
        };

        // Real corrupted shape: anthropic entry + active both hold an OR id.
        let llm = LlmConfig {
            providers: vec![entry("anthropic", LlmProviderKind::AnthropicOauth, None)],
            active: Some(LlmActive {
                provider_id: "anthropic".into(),
                model: Some("nex-agi/nex-n2-pro:free".into()),
            }),
            ..Default::default()
        };
        assert_eq!(
            llm.effective_active_model(),
            None,
            "foreign active.model under anthropic entry with no entry model → account default"
        );

        // Agreement: active.model == entry.model → used.
        let llm = LlmConfig {
            providers: vec![entry(
                "anthropic",
                LlmProviderKind::AnthropicOauth,
                Some("claude-opus-4-8"),
            )],
            active: Some(LlmActive {
                provider_id: "anthropic".into(),
                model: Some("claude-opus-4-8".into()),
            }),
            ..Default::default()
        };
        assert_eq!(
            llm.effective_active_model().as_deref(),
            Some("claude-opus-4-8")
        );

        // Disagreement: entry wins (provenance), not the stale active pointer.
        let llm = LlmConfig {
            providers: vec![entry(
                "openrouter",
                LlmProviderKind::OpenRouter,
                Some("z-ai/glm-5.2"),
            )],
            active: Some(LlmActive {
                provider_id: "openrouter".into(),
                model: Some("stale/old-model".into()),
            }),
            ..Default::default()
        };
        assert_eq!(
            llm.effective_active_model().as_deref(),
            Some("z-ai/glm-5.2")
        );

        // Empty/whitespace entry model → None.
        let llm = LlmConfig {
            providers: vec![entry(
                "anthropic",
                LlmProviderKind::AnthropicOauth,
                Some("  "),
            )],
            active: Some(LlmActive {
                provider_id: "anthropic".into(),
                model: None,
            }),
            ..Default::default()
        };
        assert_eq!(llm.effective_active_model(), None);

        // No active → None.
        assert_eq!(LlmConfig::default().effective_active_model(), None);
    }

    /// `sync_llm_legacy_fields` must never stamp an OpenRouter model under the
    /// masqueraded flat `provider="anthropic"` (would 404 a downgrade reader).
    #[test]
    fn test_sync_legacy_fields_no_foreign_model_under_flat_anthropic() {
        let kind = LlmProviderKind::OpenRouter;
        let mut llm = LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![LlmProviderEntry {
                id: "openrouter".into(),
                kind,
                base_url: None,
                model: Some("nex-agi/nex-n2-pro:free".into()),
                has_api_key: true,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: Some(LlmActive {
                provider_id: "openrouter".into(),
                model: Some("nex-agi/nex-n2-pro:free".into()),
            }),
            ..Default::default()
        };
        sync_llm_legacy_fields(&mut llm);
        assert_eq!(llm.provider.as_deref(), Some("anthropic"));
        assert_eq!(
            llm.model, None,
            "{kind:?}: flat model must be None, not the OR/compat id"
        );

        // Local/anthropic keep their own model in the flat field (consistent).
        let mut llm = LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![LlmProviderEntry {
                id: "local".into(),
                kind: LlmProviderKind::Local,
                base_url: Some("http://host.docker.internal:9000".into()),
                model: Some("qwen3".into()),
                has_api_key: false,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: Some(LlmActive {
                provider_id: "local".into(),
                model: Some("qwen3".into()),
            }),
            ..Default::default()
        };
        sync_llm_legacy_fields(&mut llm);
        assert_eq!(llm.provider.as_deref(), Some("local"));
        assert_eq!(llm.model.as_deref(), Some("qwen3"));
    }

    /// v3 self-heal: an already-v2 config with a foreign model under the
    /// anthropic entry (the real reported config) is quarantined on migrate.
    #[test]
    fn test_migrate_quarantines_foreign_anthropic_model() {
        let mut llm = LlmConfig {
            schema_version: Some(2),
            providers: vec![
                LlmProviderEntry {
                    id: "anthropic".into(),
                    kind: LlmProviderKind::AnthropicOauth,
                    base_url: None,
                    model: Some("nex-agi/nex-n2-pro:free".into()),
                    has_api_key: false,
                    context_tokens: None,
                    has_custom_headers: false,
                },
                LlmProviderEntry {
                    id: "openrouter".into(),
                    kind: LlmProviderKind::OpenRouter,
                    base_url: None,
                    model: Some("z-ai/glm-5.2".into()),
                    has_api_key: true,
                    context_tokens: None,
                    has_custom_headers: false,
                },
            ],
            active: Some(LlmActive {
                provider_id: "anthropic".into(),
                model: Some("nex-agi/nex-n2-pro:free".into()),
            }),
            ..Default::default()
        };
        migrate_llm(&mut llm, AnthropicEvidence::None);
        assert_eq!(llm.schema_version, Some(LLM_SCHEMA_VERSION));
        let anthropic = llm.providers.iter().find(|p| p.id == "anthropic").unwrap();
        assert_eq!(anthropic.model, None, "foreign anthropic model cleared");
        assert_eq!(
            llm.active.as_ref().unwrap().model,
            None,
            "active reconciled"
        );
        // The openrouter entry keeps its own (legitimate) model untouched.
        let or = llm.providers.iter().find(|p| p.id == "openrouter").unwrap();
        assert_eq!(or.model.as_deref(), Some("z-ai/glm-5.2"));
        assert_eq!(llm.effective_active_model(), None);

        // Idempotent: a second pass is a no-op (byte-identical).
        let first = serde_json::to_string(&llm).unwrap();
        migrate_llm(&mut llm, AnthropicEvidence::None);
        assert_eq!(first, serde_json::to_string(&llm).unwrap());
    }

    /// Heal-and-save: a corrupted config on disk is rewritten with the foreign
    /// model cleared, and a second heal is a no-op.
    #[test]
    fn test_heal_llm_config_on_disk_clears_foreign_model() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        let config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "speedwave".into(),
                dir: "/x".into(),
                claude: Some(ClaudeOverrides {
                    env: None,
                    settings: None,
                    llm: Some(LlmConfig {
                        schema_version: Some(2),
                        providers: vec![LlmProviderEntry {
                            id: "anthropic".into(),
                            kind: LlmProviderKind::AnthropicOauth,
                            base_url: None,
                            model: Some("nex-agi/nex-n2-pro:free".into()),
                            has_api_key: false,
                            context_tokens: None,
                            has_custom_headers: false,
                        }],
                        active: Some(LlmActive {
                            provider_id: "anthropic".into(),
                            model: Some("nex-agi/nex-n2-pro:free".into()),
                        }),
                        ..Default::default()
                    }),
                }),
                integrations: None,
                plugin_settings: None,
            }],
            ..Default::default()
        };
        save_user_config_to(&config, &config_path).unwrap();

        heal_llm_config_in(dir.path()).unwrap();
        let healed = load_user_config_from(&config_path).unwrap();
        let llm = healed.projects[0]
            .claude
            .as_ref()
            .unwrap()
            .llm
            .as_ref()
            .unwrap();
        assert_eq!(llm.schema_version, Some(LLM_SCHEMA_VERSION));
        assert_eq!(llm.providers[0].model, None);
        assert_eq!(llm.active.as_ref().unwrap().model, None);

        // Idempotent: a second heal leaves the file byte-identical.
        let after_first = std::fs::read_to_string(&config_path).unwrap();
        heal_llm_config_in(dir.path()).unwrap();
        assert_eq!(after_first, std::fs::read_to_string(&config_path).unwrap());
    }

    /// Upgrade rescue: unset provider + on-disk OAuth credentials must fabricate an
    /// anthropic entry (v0.13.3 defaulted provider=None to anthropic).
    #[test]
    fn migrate_llm_fabricates_anthropic_for_unset_provider_with_oauth_evidence() {
        let mut llm = LlmConfig::default();
        assert!(migrate_llm(&mut llm, AnthropicEvidence::Oauth));
        let entry = llm.active_provider().expect("active entry");
        assert_eq!(entry.id, ANTHROPIC_PROVIDER_ID);
        assert_eq!(entry.kind, LlmProviderKind::AnthropicOauth);
        assert!(!entry.has_api_key);
        assert!(!llm.is_unconfigured());
    }

    #[test]
    fn migrate_llm_fabricates_api_key_kind_for_unset_provider_with_key_evidence() {
        let mut llm = LlmConfig::default();
        assert!(migrate_llm(&mut llm, AnthropicEvidence::ApiKey));
        let entry = llm.active_provider().expect("active entry");
        assert_eq!(entry.kind, LlmProviderKind::AnthropicApiKey);
        assert!(entry.has_api_key);
    }

    /// Truly fresh (no provider, no credentials) must stay unconfigured so the
    /// render gate routes to provider setup instead of fabricating (R7).
    #[test]
    fn migrate_llm_leaves_unset_provider_unconfigured_without_evidence() {
        let mut llm = LlmConfig::default();
        migrate_llm(&mut llm, AnthropicEvidence::None);
        assert!(llm.providers.is_empty());
        assert!(llm.is_unconfigured());
        assert_eq!(llm.schema_version, Some(LLM_SCHEMA_VERSION));
    }

    /// A v1 local config without base_url relied on the per-alias default
    /// port — the lift must materialize it (proxy routes need an explicit URL).
    #[test]
    fn migrate_llm_fills_per_alias_default_base_url() {
        let host = crate::consts::HOST_GATEWAY_ALIAS;
        for (alias, port) in [
            ("ollama", 11434),
            ("lmstudio", 1234),
            ("llamacpp", 8080),
            ("local", 11434),
        ] {
            let mut llm = LlmConfig {
                provider: Some(alias.into()),
                model: Some("m".into()),
                ..Default::default()
            };
            migrate_llm(&mut llm, AnthropicEvidence::None);
            let entry = llm.active_provider().expect("active entry");
            assert_eq!(
                entry.base_url.as_deref(),
                Some(format!("http://{host}:{port}").as_str()),
                "alias '{alias}'"
            );
        }
    }

    #[test]
    fn migrate_llm_keeps_explicit_base_url_over_alias_default() {
        let mut llm = LlmConfig {
            provider: Some("lmstudio".into()),
            base_url: Some("http://192.168.1.5:9999".into()),
            ..Default::default()
        };
        migrate_llm(&mut llm, AnthropicEvidence::None);
        assert_eq!(
            llm.active_provider().unwrap().base_url.as_deref(),
            Some("http://192.168.1.5:9999")
        );
    }

    #[test]
    fn anthropic_evidence_detect_precedence_and_absence() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            AnthropicEvidence::detect_in(dir.path(), "p"),
            AnthropicEvidence::None
        );
        let home = dir
            .path()
            .join(crate::consts::CLAUDE_HOME_SUBDIR)
            .join("p")
            .join(".claude");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(".credentials.json"), "{}").unwrap();
        assert_eq!(
            AnthropicEvidence::detect_in(dir.path(), "p"),
            AnthropicEvidence::Oauth
        );
        let secrets = dir.path().join("secrets").join("p");
        std::fs::create_dir_all(&secrets).unwrap();
        std::fs::write(secrets.join("anthropic_api_key"), "k").unwrap();
        assert_eq!(
            AnthropicEvidence::detect_in(dir.path(), "p"),
            AnthropicEvidence::ApiKey,
            "api key beats oauth"
        );
    }

    /// Heal fabricates the llm block for a credentialed project with no
    /// claude.llm at all (v0.13.3 default population); fresh stays untouched.
    #[test]
    fn heal_fabricates_llm_for_credentialed_blockless_project() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        let proj = |name: &str, project_dir: &str| ProjectUserEntry {
            name: name.into(),
            dir: project_dir.into(),
            claude: None,
            integrations: None,
            plugin_settings: None,
        };
        let config = SpeedwaveUserConfig {
            projects: vec![proj("with-creds", "/x"), proj("fresh", "/y")],
            ..Default::default()
        };
        save_user_config_to(&config, &config_path).unwrap();
        let home = dir
            .path()
            .join(crate::consts::CLAUDE_HOME_SUBDIR)
            .join("with-creds")
            .join(".claude");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(".credentials.json"), "{}").unwrap();

        heal_llm_config_in(dir.path()).unwrap();
        let healed = load_user_config_from(&config_path).unwrap();
        let llm = healed.projects[0]
            .claude
            .as_ref()
            .expect("claude block fabricated")
            .llm
            .as_ref()
            .expect("llm block fabricated");
        assert!(!llm.is_unconfigured());
        assert_eq!(llm.active_provider().unwrap().id, ANTHROPIC_PROVIDER_ID);
        assert!(
            healed.projects[1].claude.is_none(),
            "credential-less project untouched"
        );

        // Idempotent: a second heal leaves the file byte-identical.
        let after_first = std::fs::read_to_string(&config_path).unwrap();
        heal_llm_config_in(dir.path()).unwrap();
        assert_eq!(after_first, std::fs::read_to_string(&config_path).unwrap());
    }

    /// F10: the documented repo `.speedwave.json` model suggestion fills a
    /// model-less active entry after migration.
    #[test]
    fn repo_model_suggestion_fills_modelless_active_entry() {
        let mut llm = LlmConfig::default();
        assert!(llm.set_active_to_anthropic());
        apply_repo_model_suggestion(&mut llm, Some("claude-opus-4-6".into()));
        assert_eq!(
            llm.effective_active_model().as_deref(),
            Some("claude-opus-4-6")
        );
        assert_eq!(
            llm.model.as_deref(),
            Some("claude-opus-4-6"),
            "flat mirror for the legacy renderer"
        );
    }

    #[test]
    fn repo_model_suggestion_never_overrides_entry_model() {
        let mut llm = LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![LlmProviderEntry {
                model: Some("claude-opus-4-6".into()),
                ..anthropic_entry()
            }],
            active: None,
            ..Default::default()
        };
        llm.set_active_to_anthropic();
        apply_repo_model_suggestion(&mut llm, Some("claude-haiku-4-5".into()));
        assert_eq!(
            llm.effective_active_model().as_deref(),
            Some("claude-opus-4-6")
        );
    }

    #[test]
    fn repo_model_suggestion_foreign_shape_ignored_under_anthropic() {
        let mut llm = LlmConfig::default();
        llm.set_active_to_anthropic();
        apply_repo_model_suggestion(&mut llm, Some("openrouter/z-ai/glm-5.2".into()));
        assert_eq!(llm.effective_active_model(), None);
        assert_eq!(llm.model, None);
    }

    #[test]
    fn repo_model_suggestion_noop_when_unconfigured() {
        let mut llm = LlmConfig::default();
        apply_repo_model_suggestion(&mut llm, Some("claude-opus-4-6".into()));
        assert!(llm.is_unconfigured());
        assert_eq!(llm.model, None);
    }

    /// I2: heal skips projects with no claude/llm config, leaves a clean config
    /// untouched (no churn), and heals only the corrupt project in a multi set.
    #[test]
    fn test_heal_llm_config_in_skips_and_preserves() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        let clean_llm = |id: &str, model: Option<&str>| LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![LlmProviderEntry {
                id: id.into(),
                kind: LlmProviderKind::OpenRouter,
                base_url: None,
                model: model.map(str::to_string),
                has_api_key: true,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: Some(LlmActive {
                provider_id: id.into(),
                model: model.map(str::to_string),
            }),
            ..Default::default()
        };
        let proj = |name: &str, llm: Option<LlmConfig>| ProjectUserEntry {
            name: name.into(),
            dir: "/x".into(),
            claude: llm.map(|l| ClaudeOverrides {
                env: None,
                settings: None,
                llm: Some(l),
            }),
            integrations: None,
            plugin_settings: None,
        };
        let config = SpeedwaveUserConfig {
            projects: vec![
                proj("no-claude", None),
                proj("clean", Some(clean_llm("openrouter", Some("z-ai/glm-5.2")))),
            ],
            ..Default::default()
        };
        save_user_config_to(&config, &config_path).unwrap();

        // First heal reaches the synced steady state (and must not panic on the
        // no-claude project). The SECOND heal must be a no-op — no startup churn.
        heal_llm_config_in(dir.path()).unwrap();
        let steady = std::fs::read_to_string(&config_path).unwrap();
        heal_llm_config_in(dir.path()).unwrap();
        assert_eq!(
            steady,
            std::fs::read_to_string(&config_path).unwrap(),
            "a settled config must not be rewritten on subsequent heals"
        );
        // The clean openrouter model survived; no-claude project untouched.
        let healed = load_user_config_from(&config_path).unwrap();
        let or = healed.projects[1]
            .claude
            .as_ref()
            .unwrap()
            .llm
            .as_ref()
            .unwrap();
        assert_eq!(or.providers[0].model.as_deref(), Some("z-ai/glm-5.2"));
        assert!(healed.projects[0].claude.is_none());
    }

    /// Regression (F-5): switching active OpenRouter→anthropic must never let
    /// the anthropic entry inherit the OR model across migrate/sync round-trips.
    #[test]
    fn test_roundtrip_openrouter_then_anthropic_does_not_poison_entry() {
        let or = LlmProviderEntry {
            id: "openrouter".into(),
            kind: LlmProviderKind::OpenRouter,
            base_url: None,
            model: Some("nex-agi/nex-n2-pro:free".into()),
            has_api_key: true,
            context_tokens: None,
            has_custom_headers: false,
        };
        let anthropic = LlmProviderEntry {
            id: "anthropic".into(),
            kind: LlmProviderKind::AnthropicOauth,
            base_url: None,
            model: None,
            has_api_key: false,
            context_tokens: None,
            has_custom_headers: false,
        };
        // Stage 1: OpenRouter active + saved (migrate runs on resolve/save).
        let mut llm = LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![anthropic, or],
            active: Some(LlmActive {
                provider_id: "openrouter".into(),
                model: Some("nex-agi/nex-n2-pro:free".into()),
            }),
            ..Default::default()
        };
        migrate_llm(&mut llm, AnthropicEvidence::None);
        // Flat masquerade must not carry the OR id (downgrade-safe).
        assert_eq!(llm.model, None);

        // Stage 2: user switches active to anthropic (no model = default).
        llm.active = Some(LlmActive {
            provider_id: "anthropic".into(),
            model: None,
        });
        migrate_llm(&mut llm, AnthropicEvidence::None);

        let anthropic_entry = llm.providers.iter().find(|p| p.id == "anthropic").unwrap();
        assert_eq!(
            anthropic_entry.model, None,
            "anthropic entry must stay clean"
        );
        assert_eq!(
            llm.effective_active_model(),
            None,
            "no foreign model routed"
        );
        // OpenRouter keeps its own model untouched.
        let or_entry = llm.providers.iter().find(|p| p.id == "openrouter").unwrap();
        assert_eq!(or_entry.model.as_deref(), Some("nex-agi/nex-n2-pro:free"));
    }

    /// Invalid provider ids are dropped and the active selection falls back.
    #[test]
    fn test_migrate_llm_drops_invalid_provider_ids() {
        let mut llm = LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![
                LlmProviderEntry {
                    id: "Bad.Id".into(),
                    kind: LlmProviderKind::OpenRouter,
                    base_url: None,
                    model: None,
                    has_api_key: true,
                    context_tokens: None,
                    has_custom_headers: false,
                },
                LlmProviderEntry {
                    id: "good-id".into(),
                    kind: LlmProviderKind::OpenRouter,
                    base_url: None,
                    model: None,
                    has_api_key: true,
                    context_tokens: None,
                    has_custom_headers: false,
                },
            ],
            active: Some(LlmActive {
                provider_id: "Bad.Id".into(),
                model: Some("m".into()),
            }),
            ..Default::default()
        };
        migrate_llm(&mut llm, AnthropicEvidence::None);
        assert_eq!(llm.providers.len(), 1);
        assert_eq!(llm.providers[0].id, "good-id");
        assert_eq!(
            llm.active.as_ref().map(|a| a.provider_id.as_str()),
            Some("good-id"),
            "active must fall back to the surviving entry"
        );
    }

    /// Downgrade round-trip: a config saved by v2 deserialises in the v1
    /// shape (unknown fields ignored) with a usable provider/model pair.
    #[test]
    fn test_v2_config_readable_by_v1_schema() {
        /// The exact v1 struct shape (pre-ADR-073) — what an older
        /// Speedwave's serde sees.
        #[derive(serde::Deserialize)]
        struct LlmConfigV1 {
            provider: Option<String>,
            model: Option<String>,
            base_url: Option<String>,
        }

        let mut llm = LlmConfig {
            provider: Some("llamacpp".into()),
            model: Some("qwen3".into()),
            base_url: Some("http://host.docker.internal:9000".into()),
            ..Default::default()
        };
        migrate_llm(&mut llm, AnthropicEvidence::None);
        let json = serde_json::to_string(&llm).unwrap();
        let v1: LlmConfigV1 = serde_json::from_str(&json).expect("v1 must parse v2 output");
        assert_eq!(v1.provider.as_deref(), Some("local"));
        assert_eq!(v1.model.as_deref(), Some("qwen3"));
        assert_eq!(
            v1.base_url.as_deref(),
            Some("http://host.docker.internal:9000")
        );
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

    /// A cloned repo `.speedwave.json` must not hijack Claude traffic via
    /// `claude.env`: Anthropic auth keys + every `RESERVED_ENV_KEYS` are stripped.
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

    /// The deny-list applies ONLY to the repo layer — the trusted user
    /// config.json may set any env key, including Anthropic auth/routing keys.
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
            ui: None,
            telemetry: None,
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
        // Every telemetry env key (SSOT) must be denied so a repo cannot enable or
        // redirect telemetry (ADR-076).
        assert!(repo_env_key_is_denied(crate::telemetry_env::ENABLE_KEY));
        for f in crate::telemetry_env::TelemetryField::ALL {
            if let Some(k) = crate::telemetry_env::env_key_for(*f) {
                assert!(
                    repo_env_key_is_denied(k),
                    "telemetry key {k} must be denied"
                );
            }
        }
        assert!(repo_env_key_is_denied("otel_exporter_otlp_endpoint"));
        assert!(!repo_env_key_is_denied("ANTHROPIC_MODEL"));
        assert!(!repo_env_key_is_denied("SAFE_VAR"));
    }

    #[test]
    fn repo_env_cannot_enable_or_redirect_telemetry() {
        let cleaned = sanitize_repo_env(Some(HashMap::from([
            ("CLAUDE_CODE_ENABLE_TELEMETRY".to_string(), "1".to_string()),
            (
                "OTEL_EXPORTER_OTLP_ENDPOINT".to_string(),
                "https://attacker.example.com".to_string(),
            ),
            ("OTEL_LOG_USER_PROMPTS".to_string(), "1".to_string()),
            ("KEEP".to_string(), "y".to_string()),
        ])))
        .unwrap();
        assert!(!cleaned.contains_key("CLAUDE_CODE_ENABLE_TELEMETRY"));
        assert!(!cleaned.contains_key("OTEL_EXPORTER_OTLP_ENDPOINT"));
        assert!(!cleaned.contains_key("OTEL_LOG_USER_PROMPTS"));
        assert_eq!(cleaned.get("KEEP"), Some(&"y".to_string()));
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
            ui: None,
            telemetry: None,
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
            ui: None,
            telemetry: None,
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
            ui: None,
            telemetry: None,
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
            ui: None,
            telemetry: None,
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

    /// Both config writers must route through the durable SSOT helper
    /// `fs_perms::write_restricted_file_atomic` (fsync data + parent dir).
    #[test]
    fn test_config_writers_use_durable_helper() {
        let source = include_str!("config.rs");
        for func in ["fn save_user_config_to(", "fn migrate_drop_log_level_in("] {
            let start = source.find(func).expect("function must exist");
            let body = &source[start..];
            // Bound the slice to this function (stop at next top-level item or test module).
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
            ui: None,
            telemetry: None,
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
            ui: None,
            telemetry: None,
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
            ui: None,
            telemetry: None,
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
                        ..Default::default()
                    }),
                }),
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        }
    }

    #[test]
    fn resolve_never_replaces_prompt_or_pins_model_for_local_provider() {
        // Routing/model stay env-driven (compose::apply_llm_config); only the
        // append-style skill nudge is allowed as a CLI flag.
        let tmp = tempfile::tempdir().unwrap();
        let user_config = make_ollama_user_config(tmp.path(), Some("llama3.3"));
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        let flags = &resolved.flags;
        for forbidden in ["--system-prompt-file", "--model"] {
            assert!(
                !flags.iter().any(|f| f == forbidden),
                "must not inject {forbidden} for local provider; flags: {flags:?}"
            );
        }
    }

    #[test]
    fn resolve_injects_skills_nudge_and_dynamic_section_exclusion_for_local_provider() {
        let tmp = tempfile::tempdir().unwrap();
        let user_config = make_ollama_user_config(tmp.path(), Some("llama3.3"));
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        let flags = &resolved.flags;
        assert!(
            flags
                .iter()
                .any(|f| f == "--exclude-dynamic-system-prompt-sections"),
            "local provider must get the dynamic-section exclusion; flags: {flags:?}"
        );
        let pos = flags
            .iter()
            .position(|f| f == "--append-system-prompt")
            .unwrap_or_else(|| panic!("expected --append-system-prompt; flags: {flags:?}"));
        assert_eq!(
            flags.get(pos + 1).map(String::as_str),
            Some(crate::prompts::local_llm_skills_nudge()),
            "append flag must carry the skills nudge as its value"
        );
    }

    #[test]
    fn resolve_injects_no_local_only_flags_for_openrouter_provider() {
        let tmp = tempfile::tempdir().unwrap();
        let mut user_config = make_ollama_user_config(tmp.path(), None);
        user_config.projects[0].claude.as_mut().unwrap().llm = Some(LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![LlmProviderEntry {
                id: "openrouter".to_string(),
                kind: LlmProviderKind::OpenRouter,
                base_url: None,
                model: Some("qwen/qwen3-coder".to_string()),
                has_api_key: true,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: Some(LlmActive {
                provider_id: "openrouter".to_string(),
                model: None,
            }),
            ..Default::default()
        });
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        let flags = &resolved.flags;
        for forbidden in [
            "--append-system-prompt",
            "--exclude-dynamic-system-prompt-sections",
        ] {
            assert!(
                !flags.iter().any(|f| f == forbidden),
                "must not inject {forbidden} for openrouter provider; flags: {flags:?}"
            );
        }
    }

    #[test]
    fn resolve_injects_no_local_only_flags_when_local_entry_present_but_inactive() {
        // A Local entry sitting unused in `providers` must not leak its flags
        // onto a different active provider: the discriminator is `active`,
        // not mere presence of a Local kind in the list.
        let tmp = tempfile::tempdir().unwrap();
        let mut user_config = make_ollama_user_config(tmp.path(), None);
        user_config.projects[0].claude.as_mut().unwrap().llm = Some(LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![
                LlmProviderEntry {
                    id: "ollama".to_string(),
                    kind: LlmProviderKind::Local,
                    base_url: Some("http://host.docker.internal:11434".to_string()),
                    model: Some("llama3.3".to_string()),
                    has_api_key: false,
                    context_tokens: None,
                    has_custom_headers: false,
                },
                LlmProviderEntry {
                    id: "openrouter".to_string(),
                    kind: LlmProviderKind::OpenRouter,
                    base_url: None,
                    model: Some("qwen/qwen3-coder".to_string()),
                    has_api_key: true,
                    context_tokens: None,
                    has_custom_headers: false,
                },
            ],
            active: Some(LlmActive {
                provider_id: "openrouter".to_string(),
                model: None,
            }),
            ..Default::default()
        });
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        let flags = &resolved.flags;
        for forbidden in [
            "--append-system-prompt",
            "--exclude-dynamic-system-prompt-sections",
        ] {
            assert!(
                !flags.iter().any(|f| f == forbidden),
                "inactive Local entry must not inject {forbidden}; flags: {flags:?}"
            );
        }
    }

    #[test]
    fn resolve_injects_local_only_flags_when_active_local_coexists_with_other_provider() {
        // The mirror case: Local IS active alongside a non-Local sibling
        // entry: the flags must still land, keyed off `active`, not the
        // list's first/only entry.
        let tmp = tempfile::tempdir().unwrap();
        let mut user_config = make_ollama_user_config(tmp.path(), None);
        user_config.projects[0].claude.as_mut().unwrap().llm = Some(LlmConfig {
            schema_version: Some(LLM_SCHEMA_VERSION),
            providers: vec![
                LlmProviderEntry {
                    id: "openrouter".to_string(),
                    kind: LlmProviderKind::OpenRouter,
                    base_url: None,
                    model: Some("qwen/qwen3-coder".to_string()),
                    has_api_key: true,
                    context_tokens: None,
                    has_custom_headers: false,
                },
                LlmProviderEntry {
                    id: "ollama".to_string(),
                    kind: LlmProviderKind::Local,
                    base_url: Some("http://host.docker.internal:11434".to_string()),
                    model: Some("llama3.3".to_string()),
                    has_api_key: false,
                    context_tokens: None,
                    has_custom_headers: false,
                },
            ],
            active: Some(LlmActive {
                provider_id: "ollama".to_string(),
                model: None,
            }),
            ..Default::default()
        });
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        let flags = &resolved.flags;
        assert!(
            flags
                .iter()
                .any(|f| f == "--exclude-dynamic-system-prompt-sections"),
            "active Local entry must get the dynamic-section exclusion even with a sibling provider; flags: {flags:?}"
        );
        let pos = flags
            .iter()
            .position(|f| f == "--append-system-prompt")
            .unwrap_or_else(|| panic!("expected --append-system-prompt; flags: {flags:?}"));
        assert_eq!(
            flags.get(pos + 1).map(String::as_str),
            Some(crate::prompts::local_llm_skills_nudge()),
            "append flag must carry the skills nudge as its value"
        );
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
                        ..Default::default()
                    }),
                }),
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };
        let resolved = resolve_claude_config(tmp.path(), &user_config, "test-project");
        let flags = &resolved.flags;
        for forbidden in [
            "--system-prompt-file",
            "--append-system-prompt",
            "--model",
            "--exclude-dynamic-system-prompt-sections",
        ] {
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
    }

    #[test]
    fn test_default_integrations_all_disabled() {
        let resolved = ResolvedIntegrationsConfig::default();
        assert_all_integrations_disabled(&resolved);
    }

    /// `apply_integrations_layer` must propagate every service in
    /// `TOGGLEABLE_MCP_SERVICES` to the resolved config.
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
            apply_integrations_layer(&mut resolved, &layer);

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

    /// Upgrade path: a `config.json` pre-dating `playwright` deserializes
    /// (`None`), the toggle flips it, and save→load preserves the new value.
    #[test]
    fn test_existing_user_config_accepts_new_integration() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.json");

        // On-disk config with no `playwright` field; only slack configured.
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
                    os: None,
                    plugins: None,
                }),
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };

        let resolved = resolve_integrations(tmp.path(), &user_config, "test-project");
        assert!(resolved.slack); // user override wins
        assert!(!resolved.gitlab); // repo stays
        assert!(!resolved.sharepoint); // default is disabled
    }

    /// The retired `host_exec` worker (ADR-054) left a `hostExec` key in some
    /// configs; with no `deny_unknown_fields` it must parse-and-drop, enabling nothing.
    #[test]
    fn test_legacy_host_exec_key_is_ignored() {
        let raw = r#"{
            "integrations": {
                "hostExec": {
                    "enabled": true,
                    "commands": [
                        { "name": "build", "exec": "./gradlew", "args": ["build"] }
                    ]
                },
                "slack": { "enabled": true }
            }
        }"#;
        // Parsing must not fail on the unknown `hostExec` block.
        let integrations: IntegrationsConfig = serde_json::from_str::<serde_json::Value>(raw)
            .and_then(|v| serde_json::from_value(v["integrations"].clone()))
            .expect("legacy hostExec block must parse-and-drop, not error");

        let mut resolved = ResolvedIntegrationsConfig::default();
        apply_integrations_layer(&mut resolved, &integrations);
        // `slack` toggle still applies; legacy `hostExec` enables nothing.
        assert!(resolved.slack, "slack toggle still resolves");
        assert!(
            resolved.plugins.is_empty(),
            "legacy hostExec must not leak into any resolved toggle"
        );
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
            ui: None,
            telemetry: None,
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
                    os: None,
                    plugins: None,
                }),
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
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
            ui: None,
            telemetry: None,
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
            ui: None,
            telemetry: None,
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
            ui: None,
            telemetry: None,
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
            ui: None,
            telemetry: None,
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
        // Every non-object JSON root shape (array/null/number/string/bool) must error, not be accepted.
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
        // No `.tmp` orphan is left behind on the happy path.
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

        // On failure the file must not silently shed `log_level`; the config must survive.
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

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test fixtures assert on setup that must not silently fail"
)]
mod plugin_order_tests {
    use super::*;

    #[test]
    fn enabled_plugin_service_ids_are_sorted_and_stable() {
        let mut cfg = ResolvedIntegrationsConfig::default();
        for id in ["zeta", "alpha", "midway", "beta"] {
            cfg.plugins.insert(id.to_string(), true);
        }
        cfg.plugins.insert("disabled".to_string(), false);
        for _ in 0..20 {
            assert_eq!(
                cfg.enabled_plugin_service_ids(),
                vec!["alpha", "beta", "midway", "zeta"],
                "order must be deterministic — env values feed config-hash"
            );
        }
    }

    /// Locks the real bug site: on a v1→v3 upgrade with a legacy local key on
    /// disk, the full resolve must end with has_api_key==true. This fails if the
    /// migrate→sync ordering in resolve_project_config_in is reversed (the
    /// original bug). Drives the real resolve, unlike the proxy.rs unit test.
    #[test]
    fn resolve_migrates_legacy_local_key_then_syncs_flag_true() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = "proj";

        // Seed a legacy v1 local key under the OLD path tokens/<project>/local-llm/.
        let legacy_dir = data_dir
            .path()
            .join("tokens")
            .join(project)
            .join("local-llm");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(legacy_dir.join("api_key"), "sk-legacy\n").unwrap();

        // v1 flat local config (no providers list, no schema_version) with the
        // legacy has_api_key flag set — exactly what a v0.13.x user has on disk.
        let llm = LlmConfig {
            provider: Some("local".to_string()),
            base_url: Some("http://host.docker.internal:9000".to_string()),
            model: Some("qwen".to_string()),
            has_api_key: true,
            ..Default::default()
        };
        let user_config = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: project.to_string(),
                dir: data_dir.path().to_string_lossy().to_string(),
                claude: Some(ClaudeOverrides {
                    env: None,
                    settings: None,
                    llm: Some(llm),
                }),
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            ui: None,
            telemetry: None,
        };

        let (resolved, _) =
            resolve_project_config_in(data_dir.path(), data_dir.path(), &user_config, project);

        let local = resolved
            .llm
            .providers
            .iter()
            .find(|p| p.id == "local")
            .expect("a local provider entry must exist after migration");
        assert!(
            local.has_api_key,
            "after resolve the legacy key must be migrated and has_api_key true \
             (regression: migrate must run before the disk-sync)"
        );
        // The key must now live on the new path so the proxy renders a bearer route.
        let new_key = data_dir
            .path()
            .join("tokens")
            .join(project)
            .join("llm")
            .join("local_api_key");
        assert!(
            new_key.exists(),
            "the legacy key must be copied to the new llm token path"
        );
    }
}
