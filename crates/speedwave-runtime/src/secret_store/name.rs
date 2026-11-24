use std::fmt;

pub(super) const ENCRYPTED_SUFFIX: &str = ".enc";
const MAX_SERVICE_LEN: usize = 63;
const MAX_FIELD_LEN: usize = 96;
const SERVICE_EXTRA: &[u8] = b"-";
const FIELD_EXTRA: &[u8] = b"_-";

/// Validated address of one secret: project, service and field, safe as file name parts.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SecretName {
    project: String,
    service: String,
    field: String,
}

impl SecretName {
    /// Builds a name for any integration secret after validating all three parts.
    pub fn integration(project: &str, service: &str, field: &str) -> anyhow::Result<Self> {
        crate::validation::validate_project_name(project)?;
        if !is_valid_part(service, MAX_SERVICE_LEN, SERVICE_EXTRA) {
            anyhow::bail!("invalid secret service name");
        }
        if !is_valid_part(field, MAX_FIELD_LEN, FIELD_EXTRA) {
            anyhow::bail!("invalid secret field name");
        }
        Ok(Self {
            project: project.to_owned(),
            service: service.to_owned(),
            field: field.to_owned(),
        })
    }

    /// The Anthropic API key of a project.
    pub fn anthropic_api_key(project: &str) -> anyhow::Result<Self> {
        Self::integration(project, "anthropic", "api_key")
    }

    /// The API key of one LLM provider; the provider id must be a valid plugin slug.
    pub fn llm_provider_key(project: &str, provider_id: &str) -> anyhow::Result<Self> {
        if !crate::plugin::is_valid_slug(provider_id) {
            anyhow::bail!("invalid LLM provider id");
        }
        Self::integration(project, "llm", &format!("{provider_id}_api_key"))
    }

    /// The API key of the local LLM endpoint.
    pub fn local_llm_api_key(project: &str) -> anyhow::Result<Self> {
        Self::integration(project, "local-llm", "api_key")
    }

    /// The custom headers of the local LLM endpoint.
    pub fn local_llm_custom_headers(project: &str) -> anyhow::Result<Self> {
        Self::integration(project, "local-llm", "custom_headers")
    }

    /// The OAuth refresh token of a service.
    pub fn oauth_refresh_token(project: &str, service: &str) -> anyhow::Result<Self> {
        Self::integration(project, service, "refresh_token")
    }

    /// The OAuth client secret of a service.
    pub fn oauth_client_secret(project: &str, service: &str) -> anyhow::Result<Self> {
        Self::integration(project, service, "client_secret")
    }

    /// The PII tokenization key of a project.
    pub fn pii_key(project: &str) -> anyhow::Result<Self> {
        Self::integration(project, "pii", "key")
    }

    /// Parses `<service>.<field>.enc` of a project directory back into a name; strict.
    pub fn from_file_name(project: &str, file_name: &str) -> Option<Self> {
        let stem = file_name.strip_suffix(ENCRYPTED_SUFFIX)?;
        let (service, field) = stem.split_once('.')?;
        Self::integration(project, service, field).ok()
    }

    /// The project part.
    pub fn project(&self) -> &str {
        &self.project
    }

    /// The service part.
    pub fn service(&self) -> &str {
        &self.service
    }

    /// The field part.
    pub fn field(&self) -> &str {
        &self.field
    }

    /// The file name `<service>.<field>.enc`.
    pub fn file_name(&self) -> String {
        format!("{}.{}{ENCRYPTED_SUFFIX}", self.service, self.field)
    }
}

impl fmt::Display for SecretName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}.{}", self.project, self.service, self.field)
    }
}

impl fmt::Debug for SecretName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

fn is_valid_part(value: &str, max_len: usize, extra: &[u8]) -> bool {
    let starts_alphanumeric = value
        .bytes()
        .next()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    starts_alphanumeric
        && value.len() <= max_len
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || extra.contains(&b))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    #[test]
    fn integration_accepts_valid_parts_and_exposes_them() {
        let name = SecretName::integration("my-proj_1", "local-llm", "api_key-2").unwrap();
        assert_eq!(name.project(), "my-proj_1");
        assert_eq!(name.service(), "local-llm");
        assert_eq!(name.field(), "api_key-2");
        assert_eq!(name.file_name(), "local-llm.api_key-2.enc");
    }

    #[test]
    fn display_and_debug_are_project_slash_service_dot_field() {
        let name = SecretName::integration("demo", "slack", "token").unwrap();
        assert_eq!(name.to_string(), "demo/slack.token");
        assert_eq!(format!("{name:?}"), "demo/slack.token");
    }

    #[test]
    fn integration_rejects_bad_projects() {
        for project in ["", "../x", "Upper", "a/b", "-x"] {
            assert!(
                SecretName::integration(project, "slack", "token").is_err(),
                "project {project:?}"
            );
        }
    }

    #[test]
    fn integration_rejects_bad_services() {
        let too_long = "a".repeat(64);
        for service in [
            "",
            "../x",
            "a.b",
            "a/b",
            "a\\b",
            "..",
            "Slack",
            "-slack",
            "sla_ck",
            too_long.as_str(),
        ] {
            assert!(
                SecretName::integration("demo", service, "token").is_err(),
                "service {service:?}"
            );
        }
        assert!(SecretName::integration("demo", &"a".repeat(63), "token").is_ok());
    }

    #[test]
    fn integration_rejects_bad_fields() {
        let too_long = "a".repeat(97);
        for field in [
            "",
            "../x",
            "a.b",
            "a/b",
            "a\\b",
            "..",
            "Token",
            "_token",
            "-token",
            "to ken",
            too_long.as_str(),
        ] {
            assert!(
                SecretName::integration("demo", "slack", field).is_err(),
                "field {field:?}"
            );
        }
        assert!(SecretName::integration("demo", "slack", &"a".repeat(96)).is_ok());
    }

    #[test]
    fn named_kinds_use_the_documented_service_and_field() {
        let cases = [
            (SecretName::anthropic_api_key("p"), "anthropic", "api_key"),
            (
                SecretName::llm_provider_key("p", "openrouter"),
                "llm",
                "openrouter_api_key",
            ),
            (SecretName::local_llm_api_key("p"), "local-llm", "api_key"),
            (
                SecretName::local_llm_custom_headers("p"),
                "local-llm",
                "custom_headers",
            ),
            (
                SecretName::oauth_refresh_token("p", "slack"),
                "slack",
                "refresh_token",
            ),
            (
                SecretName::oauth_client_secret("p", "slack"),
                "slack",
                "client_secret",
            ),
            (SecretName::pii_key("p"), "pii", "key"),
        ];
        for (name, service, field) in cases {
            let name = name.unwrap();
            assert_eq!(name.project(), "p");
            assert_eq!(name.service(), service);
            assert_eq!(name.field(), field);
        }
    }

    #[test]
    fn llm_provider_key_rejects_an_invalid_provider_slug() {
        for provider in ["", "Open", "1abc", "a.b", "a_b", "../x"] {
            assert!(
                SecretName::llm_provider_key("p", provider).is_err(),
                "provider {provider:?}"
            );
        }
    }

    #[test]
    fn named_kinds_validate_the_project_and_service() {
        assert!(SecretName::anthropic_api_key("../x").is_err());
        assert!(SecretName::pii_key("").is_err());
        assert!(SecretName::oauth_refresh_token("p", "a.b").is_err());
        assert!(SecretName::oauth_client_secret("p", "").is_err());
    }

    #[test]
    fn from_file_name_roundtrips_file_name() {
        let name = SecretName::llm_provider_key("proj", "my-llm").unwrap();
        assert_eq!(
            SecretName::from_file_name("proj", &name.file_name()),
            Some(name)
        );
    }

    #[test]
    fn from_file_name_rejects_malformed_names() {
        for file_name in [
            "",
            ".enc",
            "slack.enc",
            "slack.token",
            "slack.token.enc.bak",
            "slack.to.ken.enc",
            "slack..enc",
            ".token.enc",
            "Slack.token.enc",
            "slack.token.lock",
            "../x.token.enc",
            "slack.token.enc.tmp",
        ] {
            assert_eq!(
                SecretName::from_file_name("proj", file_name),
                None,
                "file name {file_name:?}"
            );
        }
        assert_eq!(SecretName::from_file_name("../x", "slack.token.enc"), None);
    }
}
