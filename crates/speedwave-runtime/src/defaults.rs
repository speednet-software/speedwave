//! Built-in default config values and the Anthropic model catalogue (SSOT).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Pinned Claude Code version installed inside the container.
pub const CLAUDE_VERSION: &str = "2.1.282";
/// Path inside the container where entrypoint.sh generates the MCP config.
pub const MCP_CONFIG_PATH: &str = "/home/speedwave/.claude/mcp-config.json";

/// Official Anthropic marketplace the bundled plugins install from.
pub const BUNDLED_PLUGIN_MARKETPLACE: &str = "claude-plugins-official";

/// Official Anthropic plugins installed and enabled by default at container start (`claude plugin
/// install <name>@<marketplace>`, idempotent, unpinned); disable via `/plugin`. ADR-087 retired `superpowers`.
pub const BUNDLED_PLUGINS: &[&str] = &[
    "frontend-design",
    "feature-dev",
    "claude-md-management",
    "typescript-lsp",
];

/// Effort levels Claude Code's `--effort` launch flag accepts, in slider order
/// (`low` → `max`); `ultracode`/`auto` are not model effort levels.
pub const EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

const EFFORT_LEVELS_NO_XHIGH: &[&str] = &["low", "medium", "high", "max"];

const NO_EFFORT_LEVELS: &[&str] = &[];

/// Per-model price list, USD per 1 million tokens. SSOT for the Desktop
/// cost meter (`chat/pricing.ts` derives from this via `list_anthropic_models`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct ModelPricing {
    /// Standard (non-cached) input tokens.
    pub input: f64,
    /// Prompt-cache read tokens.
    pub cached_input: f64,
    /// Prompt-cache write (creation) tokens.
    pub cache_write: f64,
    /// Generated output tokens.
    pub output: f64,
}

/// Plans on which a model's 1M context window is included without usage credits
/// (Claude Code model-config plan table); decides `<id>[1m]` vs. the bare id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OneMillionContext {
    /// Included on every plan.
    EveryPlan,
    /// Included on Max, Team, Enterprise and API billing; needs usage credits on Pro.
    PaidPlansAndApi,
    /// Included on API billing only; needs usage credits on every subscription.
    ApiOnly,
    /// The model has no 1M window.
    Never,
}

/// Billing plan of the signed-in Anthropic account, as Claude Code reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnthropicPlan {
    /// Claude Pro subscription.
    Pro,
    /// Claude Max subscription.
    Max,
    /// Claude Team subscription.
    Team,
    /// Claude Enterprise subscription.
    Enterprise,
    /// API key or pay-as-you-go billing.
    Api,
    /// Claude Code reported nothing, or a plan this build does not know.
    Unknown,
}

impl AnthropicPlan {
    /// Parses `initialize`'s `account.subscriptionType` label (`Claude Max`) or
    /// `get_usage`'s `subscription_type` id (`max`); anything else is `Unknown`.
    pub fn from_claude_code(reported: Option<&str>) -> Self {
        let Some(reported) = reported else {
            return Self::Unknown;
        };
        match reported.trim().to_ascii_lowercase().as_str() {
            "claude pro" | "pro" => Self::Pro,
            "claude max" | "max" => Self::Max,
            "claude team" | "team" => Self::Team,
            "claude enterprise" | "enterprise" => Self::Enterprise,
            "claude api" => Self::Api,
            _ => Self::Unknown,
        }
    }
}

/// Single source of truth for the Anthropic models surfaced in the
/// Settings → LLM Provider dropdown and the Desktop cost meter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnthropicModelInfo {
    /// Stable API alias (no snapshot date). Never compose-injected for Anthropic (SPEED-541);
    /// the pin persists via the in-container `settings.json` `model` key (SPEED-539/ADR-088).
    pub id: &'static str,
    /// Display label shown in the dropdown ("Opus 5", "Sonnet 5", …).
    pub family: &'static str,
    /// Context window in tokens (1_000_000 for 1M-context models).
    pub context_tokens: u32,
    /// Whether this entry belongs to the "Latest" group.
    pub latest: bool,
    /// Premium tier (Opus/Fable) — skipped by the everyday-model placeholder hint.
    pub premium: bool,
    /// Price of the base model id (e.g. `claude-sonnet-5`).
    pub pricing: ModelPricing,
    /// present only when `context_tokens >= 1_000_000`. `None` for sub-1M models.
    pub pricing_1m: Option<ModelPricing>,
    /// Plans that include this model's 1M window; input of `anthropic_wire_model_id`.
    pub one_million_context: OneMillionContext,
    /// Effort levels this model accepts, a subset of `EFFORT_LEVELS` in `low`→`max`
    /// order; empty when unsupported (Haiku 4.5). Never deserialized from JSON.
    #[serde(skip_deserializing)]
    pub effort_levels: &'static [&'static str],
    /// Default effort with no pin set; `None` exactly when `effort_levels` is empty.
    /// `high` on every model that supports effort, except Opus 4.7 (`xhigh`) and Opus 5.5 (`medium`).
    pub default_effort: Option<&'static str>,
}

impl AnthropicModelInfo {
    /// True when a priced `[1m]` alias exists (`pricing_1m.is_some()`).
    pub fn has_1m(&self) -> bool {
        self.pricing_1m.is_some()
    }
}

const ONE_MILLION_SUFFIX: &str = "[1m]";

/// A catalog id, or its `[1m]` form where the model has a 1M window: every id
/// `anthropic_wire_model_id` can produce. Validation SSOT for the model pin.
pub fn is_selectable_anthropic_model_id(id: &str) -> bool {
    let base = id.strip_suffix(ONE_MILLION_SUFFIX);
    ANTHROPIC_MODELS.iter().any(|m| match base {
        Some(b) => m.id == b && m.one_million_context != OneMillionContext::Never,
        None => m.id == id,
    })
}

/// A wire model id without its `[1m]` suffixes and without a `-YYYYMMDD` snapshot
/// date: the identity one picker row and one display label stand for.
pub fn canonical_anthropic_model_id(id: &str) -> &str {
    let mut base = id.trim();
    while let Some(stripped) = base.strip_suffix(ONE_MILLION_SUFFIX) {
        base = stripped;
    }
    match base.rsplit_once('-') {
        Some((head, date)) if date.len() == 8 && date.bytes().all(|b| b.is_ascii_digit()) => head,
        _ => base,
    }
}

/// The id Speedwave pins and sends for a catalog model: `<id>[1m]` where the plan
/// includes the 1M window, the bare id otherwise. A non-catalog id passes through.
pub fn anthropic_wire_model_id(catalog_id: &str, plan: AnthropicPlan) -> String {
    let Some(model) = ANTHROPIC_MODELS.iter().find(|m| m.id == catalog_id) else {
        return catalog_id.to_string();
    };
    let included = match model.one_million_context {
        OneMillionContext::EveryPlan => true,
        OneMillionContext::PaidPlansAndApi => matches!(
            plan,
            AnthropicPlan::Max
                | AnthropicPlan::Team
                | AnthropicPlan::Enterprise
                | AnthropicPlan::Api
        ),
        OneMillionContext::ApiOnly => plan == AnthropicPlan::Api,
        OneMillionContext::Never => false,
    };
    if included {
        format!("{}{ONE_MILLION_SUFFIX}", model.id)
    } else {
        model.id.to_string()
    }
}

/// Claude Code's built-in `--model` aliases, in the order Claude Code's docs list them;
/// `containers/entrypoint.sh`'s settings.json foreign-model guard mirrors this list.
pub const CLAUDE_CODE_MODEL_ALIASES: &[&str] = &[
    "default", "best", "fable", "sonnet", "opus", "haiku", "opusplan",
];

/// A settings.json `model` value `containers/entrypoint.sh`'s foreign-model guard keeps: a
/// `claude-*` id, or a Claude Code alias with an optional `[1m]`.
pub fn is_claude_code_model_setting(value: &str) -> bool {
    let claude_id = value.strip_prefix("claude-").is_some_and(|rest| {
        !rest.is_empty() && !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
    });
    let alias = value.strip_suffix(ONE_MILLION_SUFFIX).unwrap_or(value);
    claude_id || CLAUDE_CODE_MODEL_ALIASES.contains(&alias)
}

const CLAUDE_CODE_FAMILY_ALIASES: &[(&str, &str)] = &[
    ("opus", "Opus"),
    ("sonnet", "Sonnet"),
    ("haiku", "Haiku"),
    ("fable", "Fable"),
];

/// Maps a Claude Code family alias (`opus|sonnet|haiku|fable`, optional `[1m]`) to the
/// family's `latest` catalog id; anything else passes through verbatim (validity is separate).
pub fn resolve_model_alias(value: &str) -> String {
    let (word, suffix) = match value.strip_suffix("[1m]") {
        Some(base) => (base, "[1m]"),
        None => (value, ""),
    };
    let Some((_, family_prefix)) = CLAUDE_CODE_FAMILY_ALIASES
        .iter()
        .find(|(alias, _)| *alias == word)
        .copied()
    else {
        return value.to_string();
    };
    ANTHROPIC_MODELS
        .iter()
        .find(|m| m.family.starts_with(family_prefix) && m.latest)
        .map(|m| format!("{}{suffix}", m.id))
        .unwrap_or_else(|| value.to_string())
}

const FABLE_PRICING: ModelPricing = ModelPricing {
    input: 10.0,
    cached_input: 1.0,
    cache_write: 12.5,
    output: 50.0,
};
const FABLE_5_1_PRICING: ModelPricing = ModelPricing {
    input: 10.0,
    cached_input: 0.25,
    cache_write: 12.5,
    output: 50.0,
};
const OPUS_5_5_PRICING: ModelPricing = ModelPricing {
    input: 4.0,
    cached_input: 0.2,
    cache_write: 5.0,
    output: 20.0,
};
const OPUS_PRICING: ModelPricing = ModelPricing {
    input: 5.0,
    cached_input: 0.5,
    cache_write: 6.25,
    output: 25.0,
};
const SONNET_5_PRICING: ModelPricing = ModelPricing {
    input: 2.0,
    cached_input: 0.2,
    cache_write: 2.5,
    output: 10.0,
};
const SONNET_46_PRICING: ModelPricing = ModelPricing {
    input: 3.0,
    cached_input: 0.3,
    cache_write: 3.75,
    output: 15.0,
};
const HAIKU_PRICING: ModelPricing = ModelPricing {
    input: 1.0,
    cached_input: 0.1,
    cache_write: 1.25,
    output: 5.0,
};

/// Curated list of Anthropic models available via Claude Code.
/// **Order matters** — frontend renders this list as-is.
pub const ANTHROPIC_MODELS: &[AnthropicModelInfo] = &[
    AnthropicModelInfo {
        id: "claude-fable-5-1",
        family: "Fable 5.1",
        context_tokens: 1_000_000,
        latest: true,
        premium: true,
        pricing: FABLE_5_1_PRICING,
        pricing_1m: Some(FABLE_5_1_PRICING),
        one_million_context: OneMillionContext::EveryPlan,
        effort_levels: EFFORT_LEVELS,
        default_effort: Some("high"),
    },
    AnthropicModelInfo {
        id: "claude-opus-5-5",
        family: "Opus 5.5",
        context_tokens: 1_000_000,
        latest: true,
        premium: true,
        pricing: OPUS_5_5_PRICING,
        pricing_1m: Some(OPUS_5_5_PRICING),
        one_million_context: OneMillionContext::EveryPlan,
        effort_levels: EFFORT_LEVELS,
        default_effort: Some("medium"),
    },
    AnthropicModelInfo {
        id: "claude-sonnet-5",
        family: "Sonnet 5",
        context_tokens: 1_000_000,
        latest: true,
        premium: false,
        pricing: SONNET_5_PRICING,
        pricing_1m: Some(SONNET_5_PRICING),
        one_million_context: OneMillionContext::EveryPlan,
        effort_levels: EFFORT_LEVELS,
        default_effort: Some("high"),
    },
    AnthropicModelInfo {
        id: "claude-haiku-4-5",
        family: "Haiku 4.5",
        context_tokens: 200_000,
        latest: true,
        premium: false,
        pricing: HAIKU_PRICING,
        pricing_1m: None,
        one_million_context: OneMillionContext::Never,
        effort_levels: NO_EFFORT_LEVELS,
        default_effort: None,
    },
    AnthropicModelInfo {
        id: "claude-opus-5",
        family: "Opus 5",
        context_tokens: 1_000_000,
        latest: false,
        premium: true,
        pricing: OPUS_PRICING,
        pricing_1m: Some(OPUS_PRICING),
        one_million_context: OneMillionContext::EveryPlan,
        effort_levels: EFFORT_LEVELS,
        default_effort: Some("high"),
    },
    AnthropicModelInfo {
        id: "claude-fable-5",
        family: "Fable 5",
        context_tokens: 1_000_000,
        latest: false,
        premium: true,
        pricing: FABLE_PRICING,
        pricing_1m: Some(FABLE_PRICING),
        one_million_context: OneMillionContext::EveryPlan,
        effort_levels: EFFORT_LEVELS,
        default_effort: Some("high"),
    },
    AnthropicModelInfo {
        id: "claude-opus-4-8",
        family: "Opus 4.8",
        context_tokens: 1_000_000,
        latest: false,
        premium: true,
        pricing: OPUS_PRICING,
        pricing_1m: Some(OPUS_PRICING),
        one_million_context: OneMillionContext::EveryPlan,
        effort_levels: EFFORT_LEVELS,
        default_effort: Some("high"),
    },
    AnthropicModelInfo {
        id: "claude-opus-4-7",
        family: "Opus 4.7",
        context_tokens: 1_000_000,
        latest: false,
        premium: true,
        pricing: OPUS_PRICING,
        pricing_1m: Some(OPUS_PRICING),
        one_million_context: OneMillionContext::EveryPlan,
        effort_levels: EFFORT_LEVELS,
        default_effort: Some("xhigh"),
    },
    AnthropicModelInfo {
        id: "claude-opus-4-6",
        family: "Opus 4.6",
        context_tokens: 1_000_000,
        latest: false,
        premium: true,
        pricing: OPUS_PRICING,
        pricing_1m: Some(OPUS_PRICING),
        one_million_context: OneMillionContext::PaidPlansAndApi,
        effort_levels: EFFORT_LEVELS_NO_XHIGH,
        default_effort: Some("high"),
    },
    AnthropicModelInfo {
        id: "claude-sonnet-4-6",
        family: "Sonnet 4.6",
        context_tokens: 1_000_000,
        latest: false,
        premium: false,
        pricing: SONNET_46_PRICING,
        pricing_1m: Some(SONNET_46_PRICING),
        one_million_context: OneMillionContext::ApiOnly,
        effort_levels: EFFORT_LEVELS_NO_XHIGH,
        default_effort: Some("high"),
    },
];

/// Default Claude Code CLI flags applied to every session.
pub const DEFAULT_FLAGS: &[&str] = &[
    "--dangerously-skip-permissions",
    "--mcp-config",
    MCP_CONFIG_PATH,
    "--strict-mcp-config",
    "--thinking-display",
    "summarized",
    "--ide",
];

/// Base environment variables injected into every Claude container.
pub fn base_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("CLAUDE_CODE_ENABLE_TELEMETRY".into(), "0".into());
    env.insert("DISABLE_AUTOUPDATER".into(), "1".into());
    env.insert("IS_SANDBOX".into(), "1".into());
    env.insert("CLAUDE_CODE_NO_FLICKER".into(), "1".into());
    env.insert("WAYLAND_DISPLAY".into(), "speedwave-clipboard".into());
    env.insert(
        "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT".into(),
        MCP_TOOL_IDLE_TIMEOUT_MS.to_string(),
    );
    env
}

/// Idle ceiling (ms) for Claude Code's remote-MCP tool abort. Must stay ≥ the longest
/// worker timeout `STALE_CHUNK_TIMEOUT_MS` in `mcp-servers/shared/src/timeouts.ts`.
pub const MCP_TOOL_IDLE_TIMEOUT_MS: u64 = 1_800_000;

/// Alias pins `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` from `ANTHROPIC_MODELS` (Fable resolves
/// natively); `[1m]` only where every plan has that window, and a plan-dependent one is not pinned.
pub fn anthropic_default_models_env() -> HashMap<String, String> {
    default_models_env_from(ANTHROPIC_MODELS)
}

fn default_models_env_from(catalog: &[AnthropicModelInfo]) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for (alias, family_prefix) in [("OPUS", "Opus"), ("SONNET", "Sonnet"), ("HAIKU", "Haiku")] {
        let Some(latest) = catalog
            .iter()
            .find(|m| m.family.starts_with(family_prefix) && m.latest)
        else {
            continue;
        };
        let suffix = match latest.one_million_context {
            OneMillionContext::EveryPlan => "[1m]",
            OneMillionContext::Never => "",
            OneMillionContext::PaidPlansAndApi | OneMillionContext::ApiOnly => continue,
        };
        env.insert(
            format!("ANTHROPIC_DEFAULT_{alias}_MODEL"),
            format!("{}{suffix}", latest.id),
        );
    }
    env
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test-only module: unwraps/expects assert setup succeeded"
)]
mod tests {
    use super::*;

    #[test]
    fn claude_version_is_pinned_semver() {
        assert_ne!(CLAUDE_VERSION, "latest", "must not be 'latest'");
        assert_ne!(CLAUDE_VERSION, "stable", "must not be 'stable'");
        let re = regex::Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+$").unwrap();
        assert!(
            re.is_match(CLAUDE_VERSION),
            "CLAUDE_VERSION must be a semver (e.g. '2.1.76'), got: '{}'",
            CLAUDE_VERSION
        );
    }

    #[test]
    fn bundled_plugins_are_valid_slugs() {
        assert!(
            !BUNDLED_PLUGINS.is_empty(),
            "must bundle at least one plugin"
        );
        let slug = regex::Regex::new(r"^[a-z][a-z0-9-]*$").unwrap();
        for p in BUNDLED_PLUGINS {
            assert!(slug.is_match(p), "plugin slug must be kebab-case: '{p}'");
            assert!(
                !p.contains('@'),
                "plugin const holds bare names, not name@marketplace: '{p}'"
            );
        }
        let mut sorted = BUNDLED_PLUGINS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            BUNDLED_PLUGINS.len(),
            "BUNDLED_PLUGINS has duplicates"
        );
        assert!(
            !BUNDLED_PLUGIN_MARKETPLACE.is_empty(),
            "marketplace must be set"
        );
    }

    #[test]
    fn retired_superpowers_plugin_is_not_bundled() {
        assert!(
            !BUNDLED_PLUGINS.contains(&"superpowers"),
            "superpowers was retired by ADR-087 (its skills and hook compete with the vendored speedwave-* set)"
        );
    }

    #[test]
    fn base_env_does_not_set_model() {
        let env = base_env();
        for key in ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_MODEL"] {
            assert!(
                !env.contains_key(key),
                "base_env() must not set {key} — the model comes from the LLM provider config \
                 (Settings default) or the user's own claude.env override, never from defaults."
            );
        }
    }

    #[test]
    fn base_env_disables_autoupdater() {
        let env = base_env();
        assert_eq!(
            env.get("DISABLE_AUTOUPDATER").map(|s| s.as_str()),
            Some("1")
        );
    }

    #[test]
    fn base_env_disables_telemetry() {
        let env = base_env();
        assert_eq!(
            env.get("CLAUDE_CODE_ENABLE_TELEMETRY").map(|s| s.as_str()),
            Some("0")
        );
    }

    #[test]
    fn base_env_enables_no_flicker() {
        let env = base_env();
        assert_eq!(
            env.get("CLAUDE_CODE_NO_FLICKER").map(|s| s.as_str()),
            Some("1"),
            "CLAUDE_CODE_NO_FLICKER=1 mitigates PTY backpressure by emitting smaller \
             ANSI updates via Claude Code's alt-screen renderer. See issue #451."
        );
    }

    #[test]
    fn base_env_sets_wayland_display_for_clipboard_probe() {
        let env = base_env();
        let val = env.get("WAYLAND_DISPLAY").map(|s| s.as_str());
        assert!(
            val.is_some_and(|v| !v.is_empty()),
            "WAYLAND_DISPLAY must be set non-empty so the clipboard probe finds the wl-copy shim"
        );
    }

    #[test]
    fn base_env_sets_sandbox_flag() {
        let env = base_env();
        assert_eq!(
            env.get("IS_SANDBOX").map(|s| s.as_str()),
            Some("1"),
            "IS_SANDBOX=1 pre-empts Claude Code's root-user check on \
             --dangerously-skip-permissions. Defense-in-depth: the container runs as \
             UID 1000 on both supported platforms so the check would already pass, but \
             the flag keeps the behaviour future-proof against any change to the user \
             mapping. Other layers (cap_drop ALL, read-only FS, no tokens, per-project \
             network) make this safe."
        );
    }

    #[test]
    fn base_env_sets_mcp_tool_idle_timeout() {
        let env = base_env();
        assert_eq!(
            env.get("CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT")
                .map(|s| s.as_str()),
            Some(MCP_TOOL_IDLE_TIMEOUT_MS.to_string().as_str()),
            "Claude Code ≥2.1.187 aborts a remote-MCP tool call idle for 300s. The hub \
             holds the CC↔hub connection silent until a worker op finishes, so long ops \
             (SharePoint download, plugin long-class) would be killed without this override."
        );
    }

    #[test]
    fn mcp_tool_idle_timeout_covers_worker_max() {
        let src = include_str!("../../../mcp-servers/shared/src/timeouts.ts");
        let re = regex::Regex::new(r"STALE_CHUNK_TIMEOUT_MS:\s*([0-9*\s]+?),").unwrap();
        let expr = re
            .captures(src)
            .expect("timeouts.ts must declare STALE_CHUNK_TIMEOUT_MS as a `*`-product literal")
            .get(1)
            .unwrap()
            .as_str();
        let worker_max: u64 = expr
            .split('*')
            .map(|p| {
                p.trim()
                    .parse::<u64>()
                    .expect("STALE_CHUNK factors must be integers")
            })
            .product();
        assert!(
            MCP_TOOL_IDLE_TIMEOUT_MS >= worker_max,
            "MCP_TOOL_IDLE_TIMEOUT_MS ({MCP_TOOL_IDLE_TIMEOUT_MS}) must be >= the longest \
             worker timeout STALE_CHUNK_TIMEOUT_MS ({worker_max}) from timeouts.ts — bump it"
        );
    }

    #[test]
    fn mcp_config_path_points_to_claude_dir() {
        assert_eq!(MCP_CONFIG_PATH, "/home/speedwave/.claude/mcp-config.json");
    }

    #[test]
    fn default_flags_include_permission_bypass() {
        assert!(DEFAULT_FLAGS.contains(&"--dangerously-skip-permissions"));
    }

    #[test]
    fn default_flags_include_ide_auto_connect() {
        assert!(DEFAULT_FLAGS.contains(&"--ide"));
    }

    #[test]
    fn default_flags_force_thinking_summarized() {
        let pos = DEFAULT_FLAGS
            .iter()
            .position(|f| *f == "--thinking-display")
            .expect("DEFAULT_FLAGS must include --thinking-display");
        assert_eq!(
            DEFAULT_FLAGS.get(pos + 1),
            Some(&"summarized"),
            "--thinking-display must be followed by 'summarized'"
        );
    }

    fn latest_opus_with(one_million_context: OneMillionContext) -> Vec<AnthropicModelInfo> {
        let mut catalog = ANTHROPIC_MODELS.to_vec();
        let opus = catalog
            .iter_mut()
            .find(|m| m.family.starts_with("Opus") && m.latest)
            .expect("the catalog has a latest Opus");
        opus.one_million_context = one_million_context;
        catalog
    }

    #[test]
    fn a_plan_dependent_1m_window_is_never_pinned_to_an_alias() {
        for policy in [
            OneMillionContext::PaidPlansAndApi,
            OneMillionContext::ApiOnly,
        ] {
            let env = default_models_env_from(&latest_opus_with(policy));

            assert!(
                !env.contains_key("ANTHROPIC_DEFAULT_OPUS_MODEL"),
                "a pinned `[1m]` alias forces a plan without the window onto usage credits: {env:?}"
            );
            assert!(env.contains_key("ANTHROPIC_DEFAULT_SONNET_MODEL"));
        }
    }

    #[test]
    fn a_model_without_a_1m_window_is_pinned_bare() {
        let catalog = latest_opus_with(OneMillionContext::Never);
        let opus = catalog
            .iter()
            .find(|m| m.family.starts_with("Opus") && m.latest)
            .expect("the catalog has a latest Opus");

        let env = default_models_env_from(&catalog);

        assert_eq!(
            env.get("ANTHROPIC_DEFAULT_OPUS_MODEL").map(String::as_str),
            Some(opus.id)
        );
    }

    #[test]
    fn anthropic_default_models_env_appends_1m_suffix_for_million_token_models() {
        let env = anthropic_default_models_env();
        for (var, value) in &env {
            let alias = var
                .strip_prefix("ANTHROPIC_DEFAULT_")
                .and_then(|s| s.strip_suffix("_MODEL"))
                .expect("var must follow ANTHROPIC_DEFAULT_<ALIAS>_MODEL");
            let prefix = match alias {
                "OPUS" => "Opus",
                "SONNET" => "Sonnet",
                "HAIKU" => "Haiku",
                other => panic!("unexpected alias {other}"),
            };
            let model_id = value.trim_end_matches("[1m]");
            let entry = ANTHROPIC_MODELS
                .iter()
                .find(|m| m.id == model_id)
                .unwrap_or_else(|| panic!("model id {model_id} not in SSOT"));
            assert!(
                entry.family.starts_with(prefix),
                "{var}={value}: id {model_id} (family {}) does not match alias {alias}",
                entry.family
            );
            assert!(entry.latest, "{var} must point at a `latest: true` entry");
            let has_suffix = value.ends_with("[1m]");
            let expected_suffix = entry.one_million_context == OneMillionContext::EveryPlan;
            assert_eq!(
                has_suffix, expected_suffix,
                "{var}={value}: [1m] must mirror a 1M window on every plan (was {:?})",
                entry.one_million_context
            );
        }
    }

    #[test]
    fn anthropic_default_models_env_covers_every_latest_family() {
        let env = anthropic_default_models_env();
        for prefix in ["Opus", "Sonnet", "Haiku"] {
            let pinnable = ANTHROPIC_MODELS.iter().any(|m| {
                m.family.starts_with(prefix)
                    && m.latest
                    && matches!(
                        m.one_million_context,
                        OneMillionContext::EveryPlan | OneMillionContext::Never
                    )
            });
            let alias = prefix.to_uppercase();
            let var = format!("ANTHROPIC_DEFAULT_{alias}_MODEL");
            assert_eq!(
                env.contains_key(&var),
                pinnable,
                "{var} presence must mirror a `latest: true` {prefix} entry with a plan-independent window"
            );
        }
    }

    #[test]
    fn anthropic_default_models_env_pins_opus_and_sonnet_to_their_1m_windows() {
        let env = anthropic_default_models_env();
        assert_eq!(
            env.get("ANTHROPIC_DEFAULT_OPUS_MODEL").map(String::as_str),
            Some("claude-opus-5-5[1m]")
        );
        assert_eq!(
            env.get("ANTHROPIC_DEFAULT_SONNET_MODEL")
                .map(String::as_str),
            Some("claude-sonnet-5[1m]")
        );
        assert_eq!(
            env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL").map(String::as_str),
            Some("claude-haiku-4-5")
        );
    }

    #[test]
    fn anthropic_default_models_env_omits_fable_alias() {
        let env = anthropic_default_models_env();
        assert!(
            !env.keys().any(|k| k.contains("FABLE")),
            "anthropic_default_models_env must not emit a FABLE alias"
        );
    }

    #[test]
    fn fable_5_1_is_the_latest_fable_entry() {
        let fable = ANTHROPIC_MODELS
            .iter()
            .find(|m| m.id == "claude-fable-5-1")
            .expect("claude-fable-5-1 must be in the catalog");
        assert!(fable.latest, "Fable 5.1 must be in the Latest group");
        assert!(fable.premium);
        assert_eq!(fable.context_tokens, 1_000_000);
        assert_eq!(fable.pricing.input, 10.0);
        assert_eq!(fable.pricing.cache_write, 12.5);
        assert_eq!(fable.pricing.output, 50.0);
    }

    #[test]
    fn sonnet_5_1m_variant_shares_base_pricing() {
        let sonnet = ANTHROPIC_MODELS
            .iter()
            .find(|m| m.id == "claude-sonnet-5")
            .unwrap();
        assert_eq!(sonnet.pricing_1m, Some(sonnet.pricing));
    }

    #[test]
    fn sonnet_5_and_4_6_carry_their_catalog_rates() {
        let s5 = ANTHROPIC_MODELS
            .iter()
            .find(|m| m.id == "claude-sonnet-5")
            .unwrap();
        assert_eq!(s5.pricing.input, 2.0);
        assert_eq!(s5.pricing.output, 10.0);
        let s46 = ANTHROPIC_MODELS
            .iter()
            .find(|m| m.id == "claude-sonnet-4-6")
            .unwrap();
        assert_eq!(s46.pricing.input, 3.0);
        assert_eq!(s46.pricing.output, 15.0);
    }

    #[test]
    fn one_million_context_table_matches_the_plan_decisions() {
        let expected = [
            ("claude-fable-5-1", OneMillionContext::EveryPlan),
            ("claude-opus-5-5", OneMillionContext::EveryPlan),
            ("claude-sonnet-5", OneMillionContext::EveryPlan),
            ("claude-haiku-4-5", OneMillionContext::Never),
            ("claude-opus-5", OneMillionContext::EveryPlan),
            ("claude-fable-5", OneMillionContext::EveryPlan),
            ("claude-opus-4-8", OneMillionContext::EveryPlan),
            ("claude-opus-4-7", OneMillionContext::EveryPlan),
            ("claude-opus-4-6", OneMillionContext::PaidPlansAndApi),
            ("claude-sonnet-4-6", OneMillionContext::ApiOnly),
        ];
        let actual: Vec<(&str, OneMillionContext)> = ANTHROPIC_MODELS
            .iter()
            .map(|m| (m.id, m.one_million_context))
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn one_million_context_is_never_exactly_when_no_1m_alias_is_priced() {
        for m in ANTHROPIC_MODELS {
            assert_eq!(
                m.one_million_context == OneMillionContext::Never,
                !m.has_1m(),
                "{}",
                m.id
            );
        }
    }

    #[test]
    fn wire_model_id_gives_opus_4_7_and_later_1m_on_every_plan() {
        for opus in [
            "claude-opus-5-5",
            "claude-opus-5",
            "claude-opus-4-8",
            "claude-opus-4-7",
        ] {
            for plan in [
                AnthropicPlan::Pro,
                AnthropicPlan::Max,
                AnthropicPlan::Team,
                AnthropicPlan::Enterprise,
                AnthropicPlan::Api,
                AnthropicPlan::Unknown,
            ] {
                assert_eq!(
                    anthropic_wire_model_id(opus, plan),
                    format!("{opus}[1m]"),
                    "{plan:?}"
                );
            }
        }
    }

    #[test]
    fn wire_model_id_gives_opus_4_6_1m_only_where_the_plan_includes_it() {
        let opus = "claude-opus-4-6";
        for plan in [
            AnthropicPlan::Max,
            AnthropicPlan::Team,
            AnthropicPlan::Enterprise,
            AnthropicPlan::Api,
        ] {
            assert_eq!(
                anthropic_wire_model_id(opus, plan),
                format!("{opus}[1m]"),
                "{plan:?}"
            );
        }
        assert_eq!(anthropic_wire_model_id(opus, AnthropicPlan::Pro), opus);
        assert_eq!(anthropic_wire_model_id(opus, AnthropicPlan::Unknown), opus);
    }

    #[test]
    fn wire_model_id_gives_sonnet_5_and_the_fable_models_1m_on_every_plan() {
        for id in ["claude-sonnet-5", "claude-fable-5-1", "claude-fable-5"] {
            for plan in [
                AnthropicPlan::Pro,
                AnthropicPlan::Max,
                AnthropicPlan::Team,
                AnthropicPlan::Enterprise,
                AnthropicPlan::Api,
                AnthropicPlan::Unknown,
            ] {
                assert_eq!(
                    anthropic_wire_model_id(id, plan),
                    format!("{id}[1m]"),
                    "{plan:?}"
                );
            }
        }
    }

    #[test]
    fn wire_model_id_gives_sonnet_4_6_1m_on_api_billing_only() {
        let id = "claude-sonnet-4-6";
        for plan in [
            AnthropicPlan::Pro,
            AnthropicPlan::Max,
            AnthropicPlan::Team,
            AnthropicPlan::Enterprise,
            AnthropicPlan::Unknown,
        ] {
            assert_eq!(anthropic_wire_model_id(id, plan), id, "{plan:?}");
        }
        assert_eq!(
            anthropic_wire_model_id(id, AnthropicPlan::Api),
            "claude-sonnet-4-6[1m]"
        );
    }

    #[test]
    fn wire_model_id_never_gives_haiku_1m_and_passes_foreign_ids_through() {
        for plan in [AnthropicPlan::Max, AnthropicPlan::Api] {
            assert_eq!(
                anthropic_wire_model_id("claude-haiku-4-5", plan),
                "claude-haiku-4-5"
            );
        }
        assert_eq!(
            anthropic_wire_model_id("claude-opus-9", AnthropicPlan::Max),
            "claude-opus-9"
        );
        assert_eq!(anthropic_wire_model_id("", AnthropicPlan::Max), "");
    }

    #[test]
    fn every_wire_model_id_the_policy_produces_is_selectable() {
        for m in ANTHROPIC_MODELS {
            for plan in [
                AnthropicPlan::Pro,
                AnthropicPlan::Max,
                AnthropicPlan::Team,
                AnthropicPlan::Enterprise,
                AnthropicPlan::Api,
                AnthropicPlan::Unknown,
            ] {
                let wire = anthropic_wire_model_id(m.id, plan);
                assert!(is_selectable_anthropic_model_id(&wire), "{wire} ({plan:?})");
            }
        }
    }

    #[test]
    fn plan_parses_claude_codes_labels_and_ids() {
        for (reported, plan) in [
            ("Claude Pro", AnthropicPlan::Pro),
            ("Claude Max", AnthropicPlan::Max),
            ("Claude Team", AnthropicPlan::Team),
            ("Claude Enterprise", AnthropicPlan::Enterprise),
            ("Claude API", AnthropicPlan::Api),
            ("pro", AnthropicPlan::Pro),
            ("max", AnthropicPlan::Max),
            ("team", AnthropicPlan::Team),
            ("enterprise", AnthropicPlan::Enterprise),
            (" claude max ", AnthropicPlan::Max),
        ] {
            assert_eq!(
                AnthropicPlan::from_claude_code(Some(reported)),
                plan,
                "{reported}"
            );
        }
    }

    #[test]
    fn plan_is_unknown_for_missing_empty_and_unrecognised_reports() {
        assert_eq!(
            AnthropicPlan::from_claude_code(None),
            AnthropicPlan::Unknown
        );
        for reported in ["", "Claude Ultra", "free", "Claude", "api"] {
            assert_eq!(
                AnthropicPlan::from_claude_code(Some(reported)),
                AnthropicPlan::Unknown,
                "{reported}"
            );
        }
    }

    #[test]
    fn canonical_model_id_drops_the_1m_suffix_and_the_snapshot_date() {
        for (wire, canonical) in [
            ("claude-opus-5", "claude-opus-5"),
            ("claude-opus-5[1m]", "claude-opus-5"),
            ("claude-opus-5[1m][1m]", "claude-opus-5"),
            ("claude-opus-5-5[1m]", "claude-opus-5-5"),
            ("claude-haiku-4-5-20251001", "claude-haiku-4-5"),
            ("claude-haiku-4-5-20251001[1m]", "claude-haiku-4-5"),
            (" claude-sonnet-5[1m] ", "claude-sonnet-5"),
            ("claude-fable-5-1", "claude-fable-5-1"),
            ("default", "default"),
            ("opus[1m]", "opus"),
            ("local/qwen3", "local/qwen3"),
            ("claude-opus-4-8-2025100", "claude-opus-4-8-2025100"),
            ("", ""),
            ("[1m]", ""),
        ] {
            assert_eq!(canonical_anthropic_model_id(wire), canonical, "{wire:?}");
        }
    }

    #[test]
    fn fable_5_is_demoted_to_legacy() {
        let fable_5 = ANTHROPIC_MODELS
            .iter()
            .find(|m| m.id == "claude-fable-5")
            .expect("claude-fable-5 must remain in the catalog");
        assert!(!fable_5.latest, "Fable 5 must be demoted to Legacy");
        assert_eq!(fable_5.pricing.cached_input, 1.0);
    }

    #[test]
    fn opus_5_5_is_the_latest_opus_entry_at_its_own_rates() {
        let opus_5_5 = ANTHROPIC_MODELS
            .iter()
            .find(|m| m.id == "claude-opus-5-5")
            .expect("claude-opus-5-5 must be in the catalog");
        assert!(opus_5_5.latest, "Opus 5.5 must be in the Latest group");
        assert!(opus_5_5.premium);
        assert_eq!(opus_5_5.family, "Opus 5.5");
        assert_eq!(opus_5_5.context_tokens, 1_000_000);
        assert_eq!(
            opus_5_5.pricing,
            ModelPricing {
                input: 4.0,
                cached_input: 0.2,
                cache_write: 5.0,
                output: 20.0,
            }
        );
        assert_eq!(opus_5_5.pricing_1m, Some(opus_5_5.pricing));
    }

    #[test]
    fn opus_5_is_demoted_to_legacy_at_its_own_rates() {
        let opus_5 = ANTHROPIC_MODELS
            .iter()
            .find(|m| m.id == "claude-opus-5")
            .expect("claude-opus-5 must remain in the catalog");
        assert!(!opus_5.latest, "Opus 5 must be demoted to Legacy");
        assert!(opus_5.premium);
        assert_eq!(opus_5.context_tokens, 1_000_000);
        assert_eq!(opus_5.pricing.input, 5.0);
        assert_eq!(opus_5.pricing.output, 25.0);
        assert_eq!(opus_5.one_million_context, OneMillionContext::EveryPlan);
    }

    #[test]
    fn at_most_one_latest_entry_per_family_tier() {
        for prefix in ["Fable", "Opus", "Sonnet", "Haiku"] {
            let latest: Vec<&str> = ANTHROPIC_MODELS
                .iter()
                .filter(|m| m.family.starts_with(prefix) && m.latest)
                .map(|m| m.id)
                .collect();
            assert!(
                latest.len() <= 1,
                "{prefix} tier must expose at most one Latest entry, got {latest:?}"
            );
        }
    }

    #[test]
    fn default_flags_include_mcp_config() {
        assert!(DEFAULT_FLAGS.contains(&"--mcp-config"));
        assert!(DEFAULT_FLAGS.contains(&MCP_CONFIG_PATH));
    }

    #[test]
    fn default_flags_mcp_config_before_strict() {
        let mcp_pos = DEFAULT_FLAGS.iter().position(|f| *f == "--mcp-config");
        let strict_pos = DEFAULT_FLAGS
            .iter()
            .position(|f| *f == "--strict-mcp-config");
        assert!(
            mcp_pos.unwrap() < strict_pos.unwrap(),
            "--mcp-config must precede --strict-mcp-config in DEFAULT_FLAGS"
        );
    }

    #[test]
    fn default_flags_mcp_config_followed_by_path() {
        let mcp_pos = DEFAULT_FLAGS
            .iter()
            .position(|f| *f == "--mcp-config")
            .expect("--mcp-config must be in DEFAULT_FLAGS");
        assert_eq!(
            DEFAULT_FLAGS[mcp_pos + 1],
            MCP_CONFIG_PATH,
            "--mcp-config must be followed by MCP_CONFIG_PATH"
        );
    }

    #[test]
    fn effort_levels_are_unique_and_run_from_low_to_max() {
        let mut seen = std::collections::HashSet::new();
        assert!(EFFORT_LEVELS.iter().all(|l| seen.insert(*l)));
        assert_eq!(EFFORT_LEVELS.first(), Some(&"low"));
        assert_eq!(EFFORT_LEVELS.last(), Some(&"max"));
    }

    #[test]
    fn anthropic_models_list_is_non_empty_and_starts_with_latest() {
        assert!(!ANTHROPIC_MODELS.is_empty(), "model list must not be empty");
        assert!(
            ANTHROPIC_MODELS[0].latest,
            "first model must be in the Latest group so the dropdown opens with a current option"
        );
    }

    #[test]
    fn anthropic_model_ids_are_unique_and_well_formed() {
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for m in ANTHROPIC_MODELS {
            assert!(seen.insert(m.id), "duplicate model id: {}", m.id);
            assert!(
                m.id.starts_with("claude-"),
                "model id must start with 'claude-', got: {}",
                m.id
            );
            assert!(
                !m.family.is_empty(),
                "family label must not be empty for {}",
                m.id
            );
            assert!(
                m.context_tokens >= 1_000,
                "context_tokens looks too small for {}: {}",
                m.id,
                m.context_tokens
            );
        }
    }

    #[test]
    fn anthropic_models_have_at_least_one_latest_entry() {
        assert!(
            ANTHROPIC_MODELS.iter().any(|m| m.latest),
            "at least one Latest entry required so the dropdown opens with a current option"
        );
    }

    #[test]
    fn anthropic_models_premium_flag_matches_family() {
        for m in ANTHROPIC_MODELS {
            let expected = m.family.starts_with("Opus") || m.family.starts_with("Fable");
            assert_eq!(
                m.premium, expected,
                "{} premium flag must match its family tier",
                m.id
            );
        }
        assert!(
            ANTHROPIC_MODELS.iter().any(|m| !m.premium),
            "at least one non-premium model so the everyday placeholder resolves"
        );
    }

    #[test]
    fn anthropic_models_latest_entries_precede_legacy() {
        let mut seen_legacy = false;
        for m in ANTHROPIC_MODELS {
            if !m.latest {
                seen_legacy = true;
            } else {
                assert!(
                    !seen_legacy,
                    "latest entry {} must not appear after a legacy entry",
                    m.id
                );
            }
        }
    }

    #[test]
    fn every_model_has_well_formed_pricing() {
        fn check(label: &str, p: &ModelPricing) {
            assert!(p.input > 0.0, "{label}: input rate must be positive");
            assert!(p.output > 0.0, "{label}: output rate must be positive");
            assert!(
                p.cached_input < p.input,
                "{label}: cache-read must be cheaper than input"
            );
            assert!(
                p.cache_write > p.input,
                "{label}: cache-write must be dearer than input"
            );
        }
        for m in ANTHROPIC_MODELS {
            check(m.id, &m.pricing);
            if let Some(p) = &m.pricing_1m {
                check(m.id, p);
            }
        }
    }

    #[test]
    fn one_m_pricing_present_iff_million_token_context() {
        for m in ANTHROPIC_MODELS {
            let is_million = m.context_tokens >= 1_000_000;
            assert_eq!(
                m.pricing_1m.is_some(),
                is_million,
                "{}: pricing_1m presence must mirror context_tokens >= 1M (was {})",
                m.id,
                m.context_tokens
            );
        }
    }

    #[test]
    fn has_1m_mirrors_pricing_1m_presence() {
        let fable = ANTHROPIC_MODELS
            .iter()
            .find(|m| m.id == "claude-fable-5-1")
            .expect("claude-fable-5-1 must be in the catalog");
        assert_eq!(fable.context_tokens, 1_000_000);
        assert!(
            fable.has_1m(),
            "claude-fable-5-1 must report has_1m() == true"
        );

        let haiku = ANTHROPIC_MODELS
            .iter()
            .find(|m| m.id == "claude-haiku-4-5")
            .expect("claude-haiku-4-5 must be in the catalog");
        assert_eq!(haiku.context_tokens, 200_000);
        assert!(
            !haiku.has_1m(),
            "an unpriced 200k model must report has_1m() == false"
        );

        for m in ANTHROPIC_MODELS {
            assert_eq!(
                m.has_1m(),
                m.pricing_1m.is_some(),
                "{}: has_1m() must mirror pricing_1m.is_some()",
                m.id
            );
        }
    }

    #[test]
    fn is_selectable_anthropic_model_id_accepts_every_selector_shape() {
        for m in ANTHROPIC_MODELS {
            assert!(is_selectable_anthropic_model_id(m.id), "{} must pass", m.id);
            assert_eq!(
                is_selectable_anthropic_model_id(&format!("{}[1m]", m.id)),
                m.has_1m(),
                "{}[1m] must pass exactly when has_1m()",
                m.id
            );
        }
    }

    #[test]
    fn is_selectable_anthropic_model_id_rejects_ids_outside_the_catalog() {
        for foreign in [
            "",
            "gpt-4o-mini",
            "unsloth/Qwen3.6-35B-A3B",
            "claude-fable-5[2m]",
            "[1m]",
            "claude-opus-9",
            "claude-opus-5[1m][1m]",
            "claude-haiku-4-5-20251001",
            "opus",
            "default",
        ] {
            assert!(!is_selectable_anthropic_model_id(foreign), "{foreign:?}");
        }
    }

    #[test]
    fn is_selectable_anthropic_model_id_accepts_the_legacy_rows() {
        for id in [
            "claude-opus-4-8",
            "claude-opus-4-7[1m]",
            "claude-opus-4-6",
            "claude-sonnet-4-6",
            "claude-sonnet-4-6[1m]",
        ] {
            assert!(is_selectable_anthropic_model_id(id), "{id}");
        }
    }

    #[test]
    fn resolve_model_alias_maps_each_documented_alias_to_its_latest_entry() {
        assert_eq!(resolve_model_alias("opus"), "claude-opus-5-5");
        assert_eq!(resolve_model_alias("sonnet"), "claude-sonnet-5");
        assert_eq!(resolve_model_alias("haiku"), "claude-haiku-4-5");
        assert_eq!(resolve_model_alias("fable"), "claude-fable-5-1");
    }

    #[test]
    fn resolve_model_alias_preserves_the_1m_suffix() {
        assert_eq!(resolve_model_alias("opus[1m]"), "claude-opus-5-5[1m]");
        assert_eq!(resolve_model_alias("sonnet[1m]"), "claude-sonnet-5[1m]");
        assert_eq!(resolve_model_alias("fable[1m]"), "claude-fable-5-1[1m]");
        assert_eq!(resolve_model_alias("haiku[1m]"), "claude-haiku-4-5[1m]");
    }

    #[test]
    fn resolve_model_alias_matches_the_documented_fable_rewrite_demo() {
        assert_eq!(resolve_model_alias("fable[1m]"), "claude-fable-5-1[1m]");
    }

    #[test]
    fn resolve_model_alias_passes_a_full_catalog_id_through_unchanged() {
        assert_eq!(resolve_model_alias("claude-sonnet-5"), "claude-sonnet-5");
        assert_eq!(
            resolve_model_alias("claude-fable-5[1m]"),
            "claude-fable-5[1m]"
        );
        assert_eq!(resolve_model_alias("claude-opus-4-8"), "claude-opus-4-8");
    }

    #[test]
    fn resolve_model_alias_passes_an_unknown_value_through_verbatim() {
        assert_eq!(resolve_model_alias(""), "");
        assert_eq!(resolve_model_alias("gpt-4o-mini"), "gpt-4o-mini");
        assert_eq!(resolve_model_alias("best"), "best");
        assert_eq!(resolve_model_alias("opusplan"), "opusplan");
        assert_eq!(resolve_model_alias("öéü"), "öéü");
    }

    #[test]
    fn resolve_model_alias_haiku_1m_resolves_even_though_haiku_has_no_1m_price() {
        let resolved = resolve_model_alias("haiku[1m]");
        assert_eq!(resolved, "claude-haiku-4-5[1m]");
        assert!(!is_selectable_anthropic_model_id(&resolved));
    }

    #[test]
    fn resolve_model_alias_fable_1m_is_selectable_because_latest_fable_has_a_1m_price() {
        let resolved = resolve_model_alias("fable[1m]");
        assert!(is_selectable_anthropic_model_id(&resolved));
    }

    #[test]
    fn entrypoint_foreign_model_regex_matches_claude_code_model_aliases() {
        let sh = include_str!("../../../containers/entrypoint.sh");
        let expected = format!(
            "(claude-.+|({})(\\[1m\\])?)",
            CLAUDE_CODE_MODEL_ALIASES.join("|")
        );
        assert!(
            sh.contains(&expected),
            "entrypoint.sh's foreign-model guard must read {expected} — \
             rebuild it from CLAUDE_CODE_MODEL_ALIASES"
        );
    }

    #[test]
    fn claude_code_model_setting_keeps_what_the_entrypoint_guard_keeps() {
        for alias in CLAUDE_CODE_MODEL_ALIASES {
            assert!(is_claude_code_model_setting(alias), "{alias}");
            assert!(
                is_claude_code_model_setting(&format!("{alias}[1m]")),
                "{alias}[1m]"
            );
        }
        for kept in [
            "claude-fable-5",
            "claude-opus-4-8[1m]",
            "claude-opus-4-1-20250805",
        ] {
            assert!(is_claude_code_model_setting(kept), "{kept}");
        }
        for foreign in [
            "",
            "claude-",
            "claude-a\nb",
            "Opus",
            "opus[1m][1m]",
            "gpt-5",
            "llama3.3",
        ] {
            assert!(!is_claude_code_model_setting(foreign), "{foreign:?}");
        }
    }

    #[test]
    fn claude_code_family_aliases_are_a_subset_of_model_aliases() {
        for (alias, _) in CLAUDE_CODE_FAMILY_ALIASES.iter() {
            assert!(
                CLAUDE_CODE_MODEL_ALIASES.contains(alias),
                "family alias '{alias}' must also be listed in CLAUDE_CODE_MODEL_ALIASES"
            );
        }
    }

    #[test]
    fn anthropic_models_effort_levels_are_subsets_of_effort_levels_in_order() {
        for m in ANTHROPIC_MODELS {
            let mut last_idx: Option<usize> = None;
            for level in m.effort_levels {
                let idx = EFFORT_LEVELS
                    .iter()
                    .position(|l| l == level)
                    .unwrap_or_else(|| {
                        panic!("{}: effort level '{level}' is not in EFFORT_LEVELS", m.id)
                    });
                if let Some(last) = last_idx {
                    assert!(
                        idx > last,
                        "{}: effort_levels must preserve EFFORT_LEVELS order, got {:?}",
                        m.id,
                        m.effort_levels
                    );
                }
                last_idx = Some(idx);
            }
        }
    }

    #[test]
    fn anthropic_models_effort_table_matches_docs() {
        let full_five: &[&str] = &["low", "medium", "high", "xhigh", "max"];
        let four_no_xhigh: &[&str] = &["low", "medium", "high", "max"];
        let find = |id: &str| {
            ANTHROPIC_MODELS
                .iter()
                .find(|m| m.id == id)
                .unwrap_or_else(|| panic!("{id} missing from catalog"))
        };
        for id in [
            "claude-fable-5-1",
            "claude-fable-5",
            "claude-opus-5-5",
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-opus-4-8",
            "claude-opus-4-7",
        ] {
            assert_eq!(
                find(id).effort_levels,
                full_five,
                "{id} must support the full low..max effort range"
            );
        }
        for id in ["claude-opus-4-6", "claude-sonnet-4-6"] {
            assert_eq!(
                find(id).effort_levels,
                four_no_xhigh,
                "{id} must support every level except xhigh"
            );
        }
        assert_eq!(
            find("claude-haiku-4-5").effort_levels,
            &[] as &[&str],
            "claude-haiku-4-5 must not support effort"
        );
    }

    #[test]
    fn anthropic_models_default_effort_is_high_except_opus_4_7_and_opus_5_5() {
        for m in ANTHROPIC_MODELS {
            if m.effort_levels.is_empty() {
                continue;
            }
            let expected = match m.id {
                "claude-opus-4-7" => "xhigh",
                "claude-opus-5-5" => "medium",
                _ => "high",
            };
            assert_eq!(
                m.default_effort,
                Some(expected),
                "{}: unexpected default effort",
                m.id
            );
        }
    }

    #[test]
    fn anthropic_models_default_effort_none_iff_effort_levels_empty() {
        for m in ANTHROPIC_MODELS {
            assert_eq!(
                m.default_effort.is_none(),
                m.effort_levels.is_empty(),
                "{}: default_effort must be None exactly when effort_levels is empty",
                m.id
            );
        }
    }

    #[test]
    fn anthropic_models_default_effort_is_a_supported_level() {
        for m in ANTHROPIC_MODELS {
            if let Some(default) = m.default_effort {
                assert!(
                    m.effort_levels.contains(&default),
                    "{}: default_effort {default} must be one of its own effort_levels {:?}",
                    m.id,
                    m.effort_levels
                );
            }
        }
    }
}
