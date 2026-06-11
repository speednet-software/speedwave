// Mirror of `mcp-servers/oauth/src/providers/registry.ts`. ADR-060.

pub const MICROSOFT_PROVIDER_ID: &str = "microsoft";

pub const SLACK_PROVIDER_ID: &str = "slack";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn microsoft_provider_id_is_lowercase_stable_slug() {
        assert_eq!(MICROSOFT_PROVIDER_ID, "microsoft");
    }

    #[test]
    fn slack_provider_id_is_lowercase_stable_slug() {
        assert_eq!(SLACK_PROVIDER_ID, "slack");
    }
}
