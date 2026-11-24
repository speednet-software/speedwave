use crate::consts;

/// Field keys of a built-in service that hold a secret and therefore live in the secret store.
pub fn builtin_secret_fields(service: &str) -> Vec<&'static str> {
    consts::find_mcp_service(service)
        .map(|svc| {
            svc.auth_fields
                .iter()
                .filter(|field| field.is_secret)
                .map(|field| field.key)
                .collect()
        })
        .unwrap_or_default()
}

/// Whether `field` of the built-in `service` holds a secret.
pub fn is_builtin_secret_field(service: &str, field: &str) -> bool {
    builtin_secret_fields(service).contains(&field)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slack_keeps_both_tokens_in_the_store() {
        assert_eq!(
            builtin_secret_fields("slack"),
            vec!["access_token", "refresh_token"]
        );
    }

    #[test]
    fn urls_and_ids_are_not_secrets() {
        assert!(!is_builtin_secret_field("gitlab", "host_url"));
        assert!(is_builtin_secret_field("gitlab", "token"));
        assert!(!is_builtin_secret_field("sharepoint", "site_id"));
        assert!(is_builtin_secret_field("atlassian", "api_token"));
        assert!(!is_builtin_secret_field("atlassian", "email"));
    }

    #[test]
    fn an_unknown_service_has_no_secret_fields() {
        assert!(builtin_secret_fields("nope").is_empty());
        assert!(!is_builtin_secret_field("nope", "token"));
    }
}
