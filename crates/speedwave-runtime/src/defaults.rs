//! Built-in default config values and the Anthropic model catalogue (SSOT).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Pinned Claude Code version installed inside the container.
pub const CLAUDE_VERSION: &str = "2.1.206";
/// Path inside the container where entrypoint.sh generates the MCP config.
pub const MCP_CONFIG_PATH: &str = "/home/speedwave/.claude/mcp-config.json";

/// Official Anthropic marketplace the bundled plugins install from.
pub const BUNDLED_PLUGIN_MARKETPLACE: &str = "claude-plugins-official";

/// Official Anthropic plugins installed and enabled by default at container start (entrypoint
/// runs `claude plugin install <name>@<marketplace>`, idempotent, unpinned); disable via `/plugin`.
pub const BUNDLED_PLUGINS: &[&str] = &[
    "frontend-design",
    "feature-dev",
    "claude-md-management",
    "superpowers",
    "typescript-lsp",
];

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

/// Single source of truth for the Anthropic models surfaced in the
/// Settings → LLM Provider dropdown and the Desktop cost meter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnthropicModelInfo {
    /// Stable API alias (no snapshot date). Sent to Claude Code via
    /// `ANTHROPIC_MODEL`.
    pub id: &'static str,
    /// Display label shown in the dropdown ("Opus 4.8", "Sonnet 5", …).
    pub family: &'static str,
    /// Context window in tokens (1_000_000 for 1M-context models).
    pub context_tokens: u32,
    /// Whether this entry belongs to the "Latest" group.
    pub latest: bool,
    /// Premium tier (Opus/Fable) — skipped by the everyday-model placeholder hint.
    pub premium: bool,
    /// Price of the base model id (e.g. `claude-sonnet-5`).
    pub pricing: ModelPricing,
    /// Price of the `[1m]` 1M-context variant id (e.g. `claude-sonnet-5[1m]`),
    /// present when context_tokens >= 1_000_000, OR (documented exception)
    /// claude-fable-5, whose bare id reports a 200k session window despite
    /// shipping a priced [1m] alias.
    pub pricing_1m: Option<ModelPricing>,
    /// Offered by the composer selector; legacy entries stay for pricing history.
    pub selectable: bool,
}

// Published per-MTok rates: platform.claude.com/docs/en/pricing.
const FABLE_PRICING: ModelPricing = ModelPricing {
    input: 10.0,
    cached_input: 1.0,
    cache_write: 12.5,
    output: 50.0,
};
const OPUS_PRICING: ModelPricing = ModelPricing {
    input: 5.0,
    cached_input: 0.5,
    cache_write: 6.25,
    output: 25.0,
};
// Introductory rate, valid through 2026-08-31 per platform.claude.com/docs/en/about-claude/pricing.
const SONNET_5_PRICING: ModelPricing = ModelPricing {
    input: 2.0,
    cached_input: 0.2,
    cache_write: 2.5,
    output: 10.0,
};
const SONNET_4_6_PRICING: ModelPricing = ModelPricing {
    input: 3.0,
    cached_input: 0.3,
    cache_write: 3.75,
    output: 15.0,
};
// Legacy long-context premium (deployed usage rows depend on this exact rate).
const SONNET_4_6_PRICING_1M: ModelPricing = ModelPricing {
    input: 6.0,
    cached_input: 0.6,
    cache_write: 7.5,
    output: 22.5,
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
        id: "claude-fable-5",
        family: "Fable 5",
        context_tokens: 200_000,
        latest: true,
        premium: true,
        pricing: FABLE_PRICING,
        pricing_1m: Some(FABLE_PRICING),
        selectable: true,
    },
    AnthropicModelInfo {
        id: "claude-opus-4-8",
        family: "Opus 4.8",
        context_tokens: 1_000_000,
        latest: true,
        premium: true,
        pricing: OPUS_PRICING,
        pricing_1m: Some(OPUS_PRICING),
        selectable: true,
    },
    AnthropicModelInfo {
        id: "claude-sonnet-5",
        family: "Sonnet 5",
        context_tokens: 1_000_000,
        latest: true,
        premium: false,
        pricing: SONNET_5_PRICING,
        pricing_1m: Some(SONNET_5_PRICING),
        selectable: true,
    },
    AnthropicModelInfo {
        id: "claude-haiku-4-5",
        family: "Haiku 4.5",
        context_tokens: 200_000,
        latest: true,
        premium: false,
        pricing: HAIKU_PRICING,
        pricing_1m: None,
        selectable: true,
    },
    AnthropicModelInfo {
        id: "claude-opus-4-7",
        family: "Opus 4.7",
        context_tokens: 1_000_000,
        latest: false,
        premium: true,
        pricing: OPUS_PRICING,
        pricing_1m: Some(OPUS_PRICING),
        selectable: false,
    },
    AnthropicModelInfo {
        id: "claude-opus-4-6",
        family: "Opus 4.6",
        context_tokens: 1_000_000,
        latest: false,
        premium: true,
        pricing: OPUS_PRICING,
        pricing_1m: Some(OPUS_PRICING),
        selectable: false,
    },
    AnthropicModelInfo {
        id: "claude-sonnet-4-6",
        family: "Sonnet 4.6",
        context_tokens: 1_000_000,
        latest: false,
        premium: false,
        pricing: SONNET_4_6_PRICING,
        pricing_1m: Some(SONNET_4_6_PRICING_1M),
        selectable: false,
    },
];

/// Default Claude Code CLI flags applied to every session.
pub const DEFAULT_FLAGS: &[&str] = &[
    "--dangerously-skip-permissions",
    // Tells Claude Code where the MCP hub is (generated by entrypoint.sh)
    "--mcp-config",
    MCP_CONFIG_PATH,
    // Only use servers from --mcp-config, ignore any .mcp.json in workspace
    "--strict-mcp-config",
    "--thinking-display",
    "summarized",
    // Lock-file auto-connect to the IDE bridge (~/.claude/ide/); silent when no lock.
    // Complements CLAUDE_CODE_AUTO_CONNECT_IDE (which only forces the terminal path).
    "--ide",
];

/// Base environment variables injected into every Claude container.
pub fn base_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("CLAUDE_CODE_ENABLE_TELEMETRY".into(), "0".into());
    env.insert("DISABLE_AUTOUPDATER".into(), "1".into());
    // Signal sandboxed env so --dangerously-skip-permissions is accepted regardless of UID.
    env.insert("IS_SANDBOX".into(), "1".into());
    // Claude Code focus-view mode: emits smaller ANSI updates instead of full-frame redraws (issue #451).
    env.insert("CLAUDE_CODE_NO_FLICKER".into(), "1".into());
    // Non-empty WAYLAND_DISPLAY routes Claude Code copies through the osc52-copy.sh shim (ADR-052).
    env.insert("WAYLAND_DISPLAY".into(), "speedwave-clipboard".into());
    // Raise Claude Code's 300s remote-MCP idle abort (CC ≥2.1.187) above the longest
    // hub→worker op; the CC↔hub HTTP connection is silent until the op finishes.
    env.insert(
        "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT".into(),
        MCP_TOOL_IDLE_TIMEOUT_MS.to_string(),
    );
    env
}

/// Idle ceiling (ms) for Claude Code's remote-MCP tool abort. Must stay ≥ the longest
/// worker timeout `STALE_CHUNK_TIMEOUT_MS` in `mcp-servers/shared/src/timeouts.ts`.
pub const MCP_TOOL_IDLE_TIMEOUT_MS: u64 = 1_800_000;

/// Anthropic-branch alias pins `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` from the
/// `ANTHROPIC_MODELS` SSOT (`[1m]` where supported). Fable omitted — resolves natively.
pub fn anthropic_default_models_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    for (alias, family_prefix) in [("OPUS", "Opus"), ("SONNET", "Sonnet"), ("HAIKU", "Haiku")] {
        let Some(latest) = ANTHROPIC_MODELS
            .iter()
            .find(|m| m.family.starts_with(family_prefix) && m.latest)
        else {
            continue;
        };
        let suffix = if latest.context_tokens >= 1_000_000 {
            "[1m]"
        } else {
            ""
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
        // CLAUDE_VERSION must be a concrete semver — never "latest" or "stable".
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
    fn base_env_does_not_set_model() {
        let env = base_env();
        assert!(
            !env.contains_key("ANTHROPIC_MODEL"),
            "base_env() must not set ANTHROPIC_MODEL — the user's Claude Code model \
             selection must not be overridden. Users who want a specific model can set \
             claude.env.ANTHROPIC_MODEL in .speedwave.json or ~/.speedwave/config.json."
        );
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
        // Claude Code ≥2.1.161 gates the clipboard-tool probe on this var (ADR-052).
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
        // SSOT-alignment: idle ceiling must stay >= STALE_CHUNK_TIMEOUT_MS in timeouts.ts.
        // Env-raised BASE_MS/SHAREPOINT_SYNC_MS are invisible here — raise them manually.
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
        // entrypoint.sh generates mcp-config.json at this path; keep it in sync with DEFAULT_FLAGS.
        assert_eq!(MCP_CONFIG_PATH, "/home/speedwave/.claude/mcp-config.json");
    }

    #[test]
    fn default_flags_include_permission_bypass() {
        assert!(DEFAULT_FLAGS.contains(&"--dangerously-skip-permissions"));
    }

    #[test]
    fn default_flags_include_ide_auto_connect() {
        // Lock-file auto-connect path; safe default since Claude Code skips it
        // silently when no ~/.claude/ide/ lock is present (CLI-only).
        assert!(DEFAULT_FLAGS.contains(&"--ide"));
    }

    #[test]
    fn default_flags_force_thinking_summarized() {
        // Workaround for anthropics/claude-code#49268: pin --thinking-display to `summarized`.
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

    #[test]
    fn anthropic_default_models_env_appends_1m_suffix_for_million_token_models() {
        // Workaround for anthropics/claude-code#34083 (1M models capped at 200k without `[1m]`).
        let env = anthropic_default_models_env();
        // Cross-check every emitted var against SSOT.
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
            let expected_suffix = entry.context_tokens >= 1_000_000;
            assert_eq!(
                has_suffix, expected_suffix,
                "{var}={value}: [1m] suffix must mirror context_tokens >= 1M (was {})",
                entry.context_tokens
            );
        }
    }

    #[test]
    fn anthropic_default_models_env_covers_every_latest_family() {
        // Every family with a `latest: true` entry in SSOT must produce a matching env var.
        let env = anthropic_default_models_env();
        for prefix in ["Opus", "Sonnet", "Haiku"] {
            let has_latest = ANTHROPIC_MODELS
                .iter()
                .any(|m| m.family.starts_with(prefix) && m.latest);
            let alias = prefix.to_uppercase();
            let var = format!("ANTHROPIC_DEFAULT_{alias}_MODEL");
            assert_eq!(
                env.contains_key(&var),
                has_latest,
                "{var} presence must mirror SSOT having a `latest: true` {prefix} entry"
            );
        }
    }

    #[test]
    fn anthropic_default_models_env_omits_fable_alias() {
        // Anthropic-branch pins skip Fable (`fable` alias resolves natively).
        // Non-anthropic remapping injects FABLE separately — see compose/llm.rs.
        let env = anthropic_default_models_env();
        assert!(
            !env.keys().any(|k| k.contains("FABLE")),
            "anthropic_default_models_env must not emit a FABLE alias"
        );
    }

    #[test]
    fn fable_entry_present_with_million_context() {
        // Settings dropdown + cost meter need the Fable 5 entry ($10/$50).
        let fable = ANTHROPIC_MODELS
            .iter()
            .find(|m| m.id == "claude-fable-5")
            .expect("claude-fable-5 must be in the catalog");
        assert!(fable.latest, "Fable 5 must be in the Latest group");
        assert_eq!(fable.context_tokens, 200_000);
        assert_eq!(fable.pricing.input, 10.0);
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
    fn sonnet_5_carries_intro_pricing_and_4_6_keeps_standard() {
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
    fn sonnet_4_6_1m_variant_keeps_its_legacy_long_context_premium() {
        // Deployed usage rows for sonnet-4-6[1m] were priced at this rate;
        // unlike current-gen models, its pricing_1m must NOT collapse to base.
        let s46 = ANTHROPIC_MODELS
            .iter()
            .find(|m| m.id == "claude-sonnet-4-6")
            .unwrap();
        assert_ne!(s46.pricing_1m, Some(s46.pricing));
        let p = s46.pricing_1m.unwrap();
        assert_eq!(p.input, 6.0);
        assert_eq!(p.output, 22.5);
    }

    #[test]
    fn legacy_entries_are_not_selectable() {
        for id in ["claude-opus-4-6", "claude-opus-4-7", "claude-sonnet-4-6"] {
            let m = ANTHROPIC_MODELS.iter().find(|m| m.id == id).unwrap();
            assert!(!m.selectable, "{id} must not be selectable");
        }
    }

    #[test]
    fn current_entries_are_selectable() {
        for id in [
            "claude-fable-5",
            "claude-opus-4-8",
            "claude-sonnet-5",
            "claude-haiku-4-5",
        ] {
            let m = ANTHROPIC_MODELS.iter().find(|m| m.id == id).unwrap();
            assert!(m.selectable, "{id} must be selectable");
        }
    }

    #[test]
    fn fable_5_bare_id_reports_its_actual_session_window() {
        // Empirically verified (design spec 1.4/4.6): the bare `claude-fable-5` id
        // resolves to a 200k session window; only the `[1m]` alias gets 1M. The
        // family still carries a priced `[1m]` variant via `pricing_1m`, so
        // `pricing_1m` presence is no longer inferred from `context_tokens >= 1M`
        // for this one entry - it is an explicit exception, asserted here.
        let fable = ANTHROPIC_MODELS
            .iter()
            .find(|m| m.id == "claude-fable-5")
            .unwrap();
        assert_eq!(fable.context_tokens, 200_000);
        assert!(
            fable.pricing_1m.is_some(),
            "claude-fable-5 must still price its [1m] alias"
        );
    }

    #[test]
    fn default_flags_include_mcp_config() {
        // Claude Code must receive --mcp-config pointing to the generated config file.
        assert!(DEFAULT_FLAGS.contains(&"--mcp-config"));
        assert!(DEFAULT_FLAGS.contains(&MCP_CONFIG_PATH));
    }

    #[test]
    fn default_flags_mcp_config_before_strict() {
        // --mcp-config must come before --strict-mcp-config.
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
        // --mcp-config must be immediately followed by the path (it's a flag + value pair).
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
    fn anthropic_models_list_is_non_empty_and_starts_with_latest() {
        // The first entry is the topmost dropdown option, so it must be `latest = true`.
        assert!(!ANTHROPIC_MODELS.is_empty(), "model list must not be empty");
        assert!(
            ANTHROPIC_MODELS[0].latest,
            "first model must be in the Latest group so the dropdown opens with a current option"
        );
    }

    #[test]
    fn anthropic_model_ids_are_unique_and_well_formed() {
        // Model ids must be unique and start with `claude-`.
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
            // Smallest plausible context window is 200k (Haiku); catch accidental zeros/typos.
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
        // At least one `latest: true` entry must exist for the "Latest" optgroup.
        assert!(
            ANTHROPIC_MODELS.iter().any(|m| m.latest),
            "at least one Latest entry required so the dropdown opens with a current option"
        );
    }

    #[test]
    fn anthropic_models_premium_flag_matches_family() {
        // Premium tiers are Opus + Fable; Sonnet/Haiku are the everyday tier.
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
        // Frontend renders the slice as-is into two optgroups; legacy before latest breaks the boundary.
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
        // Cache-read must be cheaper than input, cache-write dearer, for every entry and its 1M variant.
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
        // `pricing_1m` must be present iff the model has a 1M-token context,
        // except `claude-fable-5`: its bare id's session window is 200k (the
        // empirically-verified default) while its family still exposes a
        // priced `[1m]` alias.
        for m in ANTHROPIC_MODELS {
            let is_million = m.context_tokens >= 1_000_000;
            let expected = is_million || m.id == "claude-fable-5";
            assert_eq!(
                m.pricing_1m.is_some(),
                expected,
                "{}: pricing_1m presence must mirror context_tokens >= 1M (was {}), except the documented claude-fable-5 exception",
                m.id,
                m.context_tokens
            );
        }
    }
}
