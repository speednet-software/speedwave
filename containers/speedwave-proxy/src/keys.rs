//! `SPW_KEY_<ID>` env-name validation — the in-container half of the
//! provider-key contract (ADR-073). Host renders names via `spw_key_env_name`;
//! here we reverse + re-validate the slug shape before trusting a name.

/// Env-name prefix carrying a per-provider key into the proxy container.
const SPW_KEY_PREFIX: &str = "SPW_KEY_";

/// Validate a provider slug against the canonical shape `^[a-z][a-z0-9-]{0,63}$`
/// (SSOT: `plugin::is_valid_slug`): leading lowercase letter, then 0–63 of
/// lowercase / digit / hyphen (max 64).
pub fn validate_slug(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Reverse `spw_key_env_name`: strip `SPW_KEY_`, lowercase, map `_` back to `-`,
/// and return the provider slug iff it is shape-valid. A tampered or malformed
/// name yields `None`, so the caller never reads that env var.
pub fn provider_id_from_env_name(name: &str) -> Option<String> {
    let rest = name.strip_prefix(SPW_KEY_PREFIX)?;
    let slug = rest.to_ascii_lowercase().replace('_', "-");
    validate_slug(&slug).then_some(slug)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn rejects_leading_digit() {
        assert!(provider_id_from_env_name("SPW_KEY_9X").is_none());
        assert!(!validate_slug("9bad"));
    }

    #[test]
    fn rejects_leading_hyphen() {
        assert!(!validate_slug("-x"));
        assert!(provider_id_from_env_name("SPW_KEY__BAD").is_none());
    }

    #[test]
    fn rejects_over_64_chars() {
        assert!(!validate_slug(&"a".repeat(65)));
    }

    #[test]
    fn accepts_64_chars() {
        assert!(validate_slug(&"a".repeat(64)));
    }

    #[test]
    fn rejects_uppercase_and_dots() {
        assert!(!validate_slug("Foo.bar"));
        assert!(provider_id_from_env_name("SPW_KEY_FOO.BAR").is_none());
    }

    #[test]
    fn rejects_empty() {
        assert!(!validate_slug(""));
        assert!(provider_id_from_env_name("SPW_KEY_").is_none());
    }

    #[test]
    fn accepts_valid_slugs_and_maps_underscores_to_hyphens() {
        assert_eq!(
            provider_id_from_env_name("SPW_KEY_OPENROUTER").as_deref(),
            Some("openrouter")
        );
        assert_eq!(
            provider_id_from_env_name("SPW_KEY_MY_ANTHROPIC").as_deref(),
            Some("my-anthropic")
        );
    }

    #[test]
    fn rejects_name_without_prefix() {
        assert!(provider_id_from_env_name("OPENROUTER").is_none());
        assert!(provider_id_from_env_name("ANTHROPIC_API_KEY").is_none());
    }

    /// Mirror of the host-side `spw_key_env_name` (compose/proxy.rs). Kept here
    /// because this crate cannot depend on speedwave-runtime; the round-trip
    /// test below pins that the two halves stay inverse.
    fn spw_key_env_name(provider_id: &str) -> String {
        format!(
            "SPW_KEY_{}",
            provider_id.to_ascii_uppercase().replace('-', "_")
        )
    }

    #[test]
    fn round_trips_with_host_forward_normalisation() {
        // For every valid slug, reverse(forward(id)) == id. If the host changes
        // its normalisation, this test (and the SSOT-alignment note on
        // spw_key_env_name) flags the divergence.
        for id in [
            "openrouter",
            "local",
            "my-anthropic",
            "a-b-c-1-2",
            "x",
            &"a".repeat(64),
        ] {
            let env = spw_key_env_name(id);
            assert_eq!(
                provider_id_from_env_name(&env).as_deref(),
                Some(id),
                "round-trip failed for slug {id:?} via env {env:?}"
            );
        }
    }
}
