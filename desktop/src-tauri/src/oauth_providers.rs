// Mirror of `mcp-servers/oauth/src/providers/registry.ts`. ADR-060.

pub const MICROSOFT_PROVIDER_ID: &str = "microsoft";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn microsoft_provider_id_is_lowercase_stable_slug() {
        assert_eq!(MICROSOFT_PROVIDER_ID, "microsoft");
    }
}
