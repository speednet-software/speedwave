//! Model id triad (ADR pending, design section 4.3.1): `catalog_id` (provider-native),
//! `wire_id` (what `/model` and `ANTHROPIC_MODEL` carry), `observed_id` (init.model shape,
//! same as wire_id). This module owns the mapping both ways. The wire prefix is ALWAYS
//! `entry_id` (never a hardcoded per-kind literal) - `compose/proxy.rs`'s rendered route
//! `prefix` must equal the same `entry_id` for `containers/proxy/src/router.rs::resolve`
//! (which splits the model on its first `/`) to find the route this module builds ids for.

use crate::config::LlmProviderKind;

/// Builds the wire id from a catalog id for the given provider entry.
/// Anthropic kinds: unchanged. Other kinds: `<entry_id>/<catalog_id>`, unless
/// `catalog_id` is already prefixed with `<entry_id>/` (mirrors
/// `compose/llm.rs`'s `routed_model` rule exactly). `entry_id` is always the
/// route prefix on the proxy side too (`compose/proxy.rs` renders `prefix:
/// entry.id` for every non-anthropic route) - this holds for ANY valid slug,
/// not just the built-in `openrouter`/`local` ids.
pub fn wire_model_id(kind: LlmProviderKind, entry_id: &str, catalog_id: &str) -> String {
    if kind.is_anthropic() {
        return catalog_id.to_string();
    }
    let prefix = format!("{entry_id}/");
    if catalog_id.starts_with(&prefix) {
        catalog_id.to_string()
    } else {
        format!("{prefix}{catalog_id}")
    }
}

/// Strips one leading `<entry_id>/` from an observed wire id, for display and
/// comparison against `catalog_id`. Anthropic ids (no such prefix) and any
/// non-matching prefix pass through unchanged.
pub fn normalize_observed(observed: &str, entry_id: &str) -> String {
    let prefix = format!("{entry_id}/");
    observed
        .strip_prefix(&prefix)
        .map(str::to_string)
        .unwrap_or_else(|| observed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_round_trips_unchanged_including_1m_suffix() {
        let catalog_id = "claude-sonnet-5[1m]";
        let wire = wire_model_id(LlmProviderKind::AnthropicOauth, "anthropic", catalog_id);
        assert_eq!(wire, catalog_id);
        let observed = wire.clone();
        assert_eq!(normalize_observed(&observed, "anthropic"), catalog_id);
    }

    #[test]
    fn anthropic_api_key_kind_also_round_trips_unchanged() {
        let catalog_id = "claude-opus-4-8";
        let wire = wire_model_id(LlmProviderKind::AnthropicApiKey, "anthropic", catalog_id);
        assert_eq!(wire, catalog_id);
    }

    #[test]
    fn openrouter_prefixes_with_entry_id_and_normalizes_back() {
        let catalog_id = "anthropic/claude-sonnet-5";
        let entry_id = "openrouter";
        let wire = wire_model_id(LlmProviderKind::OpenRouter, entry_id, catalog_id);
        assert_eq!(wire, "openrouter/anthropic/claude-sonnet-5");
        assert_eq!(normalize_observed(&wire, entry_id), catalog_id);
    }

    #[test]
    fn local_prefixes_with_entry_id_over_nested_catalog_slashes() {
        let catalog_id = "unsloth/Qwen2.5-Coder-32B-Instruct";
        let entry_id = "local";
        let wire = wire_model_id(LlmProviderKind::Local, entry_id, catalog_id);
        assert_eq!(wire, "local/unsloth/Qwen2.5-Coder-32B-Instruct");
        assert_eq!(normalize_observed(&wire, entry_id), catalog_id);
    }

    /// Regression for the routing-bypass bug: a custom (non-`openrouter`,
    /// non-`local`) provider slug must get the SAME `<entry_id>/` treatment,
    /// or the wire id's first segment matches no route in the rendered
    /// proxy.json (`compose/proxy.rs`) and `router.rs::resolve` returns `None`.
    #[test]
    fn custom_provider_slug_prefixes_with_its_own_entry_id() {
        let catalog_id = "anthropic/claude-sonnet-5";
        let entry_id = "my-or";
        let wire = wire_model_id(LlmProviderKind::OpenRouter, entry_id, catalog_id);
        assert_eq!(wire, "my-or/anthropic/claude-sonnet-5");
        assert_eq!(normalize_observed(&wire, entry_id), catalog_id);
    }

    #[test]
    fn already_prefixed_catalog_id_is_not_double_prefixed() {
        let entry_id = "openrouter";
        let catalog_id = "openrouter/anthropic/claude-sonnet-5";
        let wire = wire_model_id(LlmProviderKind::OpenRouter, entry_id, catalog_id);
        assert_eq!(
            wire, catalog_id,
            "must not double-prefix an already-wire-shaped id"
        );
    }

    #[test]
    fn normalize_on_non_matching_prefix_is_identity() {
        let observed = "claude-opus-4-8";
        assert_eq!(normalize_observed(observed, "openrouter"), observed);
    }

    #[test]
    fn normalize_on_different_entry_prefix_is_identity() {
        // Wire id was built for entry "local"; normalizing with a different entry id
        // ("openrouter") must not strip a prefix that does not match.
        let wire = wire_model_id(LlmProviderKind::Local, "local", "qwen2.5-coder");
        assert_eq!(normalize_observed(&wire, "openrouter"), wire);
    }
}
