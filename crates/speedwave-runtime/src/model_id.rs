//! Model id triad: `catalog_id` (provider-native) vs `wire_id`/`observed_id` (`ANTHROPIC_MODEL`
//! shape). The wire prefix is always `entry_id`, matching `compose/proxy.rs`'s route `prefix`.

use crate::config::LlmProviderKind;

/// Builds the wire id from a catalog id: unchanged for Anthropic kinds, else
/// `<entry_id>/<catalog_id>` (no double-prefix if already wire-shaped).
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
/// comparison against `catalog_id`; a non-matching prefix passes through unchanged.
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

    /// Regression: the already-prefixed guard checks a `/`-terminated prefix,
    /// not a bare `starts_with(entry_id)` — a catalog id that merely shares a
    /// character run with `entry_id` (no `/` boundary) must still be prefixed.
    #[test]
    fn catalog_id_sharing_a_prefix_without_slash_boundary_is_still_prefixed() {
        let entry_id = "my-ollama";
        let catalog_id = "my-ollama-fast/qwen";
        let wire = wire_model_id(LlmProviderKind::Local, entry_id, catalog_id);
        assert_eq!(
            wire, "my-ollama/my-ollama-fast/qwen",
            "a catalog id sharing entry_id's characters without a '/' boundary must be genuinely prefixed"
        );
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

    #[test]
    fn wire_model_id_matches_ts() {
        // Cross-read guard: the TS mirror in
        // desktop/src/src/app/chat/composer/model-selector/wire-model-id.ts must
        // implement the identical anthropic-passthrough / entry-id-prefix /
        // already-prefixed guard rule.
        let ts = include_str!(
            "../../../desktop/src/src/app/chat/composer/model-selector/wire-model-id.ts"
        );
        assert!(
            ts.contains("export function wireModelId"),
            "TS must export wireModelId"
        );
        assert!(
            ts.contains("anthropic_oauth") && ts.contains("anthropic_api_key"),
            "TS wireModelId must special-case both anthropic provider kinds, matching Rust wire_model_id"
        );
        assert!(
            ts.contains("catalogId.startsWith(prefix)"),
            "TS wireModelId must guard against double-prefixing an already-prefixed catalog id, matching Rust wire_model_id"
        );

        // Behavioral parity, not just substring containment: run the same
        // already-prefixed input through both implementations' documented rule.
        let rust_already_prefixed = crate::model_id::wire_model_id(
            LlmProviderKind::Local,
            "my-ollama",
            "my-ollama/llama3.3",
        );
        assert_eq!(
            rust_already_prefixed, "my-ollama/llama3.3",
            "Rust wire_model_id must not double-prefix an already-prefixed catalog id"
        );

        let ts_spec = include_str!(
            "../../../desktop/src/src/app/chat/composer/model-selector/wire-model-id.spec.ts"
        );
        assert!(
            ts_spec.contains(
                "does not double-prefix a catalog id that already carries the entry id prefix"
            ),
            "TS spec must exercise the same already-prefixed regression the Rust side guards"
        );
    }

    #[test]
    fn normalize_observed_matches_ts() {
        // Cross-read guard: the TS mirror `normalizeObserved` must strip only an
        // exact leading `<entryId>/` prefix, matching Rust normalize_observed.
        let ts = include_str!(
            "../../../desktop/src/src/app/chat/composer/model-selector/wire-model-id.ts"
        );
        assert!(
            ts.contains("export function normalizeObserved"),
            "TS must export normalizeObserved"
        );
        assert!(
            ts.contains("observed.startsWith(prefix)"),
            "TS normalizeObserved must strip only an exact leading prefix, matching Rust normalize_observed"
        );

        // Behavioral parity on the mis-strip regression: a first segment that is
        // NOT the entry id must survive.
        let rust_non_matching =
            crate::model_id::normalize_observed("unsloth/Qwen2.5-Coder-32B", "my-ollama");
        assert_eq!(
            rust_non_matching, "unsloth/Qwen2.5-Coder-32B",
            "Rust normalize_observed must not strip a first segment that is not the entry id"
        );

        let ts_spec = include_str!(
            "../../../desktop/src/src/app/chat/composer/model-selector/wire-model-id.spec.ts"
        );
        assert!(
            ts_spec.contains("does not mis-strip a first segment that is not the entry id"),
            "TS spec must exercise the same mis-strip regression the Rust side guards"
        );
    }
}
