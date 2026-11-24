use std::io;

use super::name::SecretName;

/// Failure of the secret store; it carries names and operation labels, never values or paths.
#[derive(Debug, thiserror::Error)]
pub enum SecretStoreError {
    /// Encrypted secrets exist but the install key does not.
    #[error("the secret store key is missing")]
    KeyMissing,
    /// The install key file exists but is malformed.
    #[error("the secret store key file is malformed")]
    KeyUnreadable,
    /// The secret file is corrupt, sealed under another key or tampered with.
    #[error("the secret {0} cannot be read")]
    Unreadable(SecretName),
    /// The store directory holds entries that are not encrypted secrets.
    #[error("the secret store holds unexpected entries: {count}")]
    PlaintextInStore {
        /// Number of unexpected entries.
        count: usize,
    },
    /// A filesystem or entropy operation failed.
    #[error("secret store operation failed: {0}")]
    Io(String),
}

pub(crate) fn unreadable_secret_message(name: &SecretName) -> String {
    let label = match name.service() {
        "llm" => "provider key",
        "anthropic" => "Anthropic API key",
        "local-llm" => "local LLM key",
        "pii" => "PII key",
        service => {
            return format!(
                "Integration {service}: cannot read the secret. Reconnect it in Speedwave Desktop (Settings, Integrations)."
            )
        }
    };
    format!("Cannot read the stored {label}. Enter it again in Speedwave Desktop (Settings).")
}

pub(super) fn io_failure(operation: &str, error: &io::Error) -> SecretStoreError {
    SecretStoreError::Io(format!("{operation}: {}", error.kind()))
}

pub(super) fn operation_failure(operation: &str) -> SecretStoreError {
    SecretStoreError::Io(format!("{operation}: failed"))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    const SENTINEL: &str = "SENTINEL-997-secret-store";

    fn name() -> SecretName {
        SecretName::integration("demo", "slack", "token").unwrap()
    }

    #[test]
    fn unreadable_message_names_the_service_and_not_the_project() {
        let message = unreadable_secret_message(&name());
        assert_eq!(
            message,
            "Integration slack: cannot read the secret. Reconnect it in Speedwave Desktop (Settings, Integrations)."
        );
        assert!(!message.contains("demo"));
    }

    #[test]
    fn internal_store_names_get_a_label_and_no_integrations_wording() {
        let cases = [
            (
                SecretName::llm_provider_key("demo", "openai").unwrap(),
                "provider key",
            ),
            (
                SecretName::anthropic_api_key("demo").unwrap(),
                "Anthropic API key",
            ),
            (
                SecretName::local_llm_api_key("demo").unwrap(),
                "local LLM key",
            ),
            (
                SecretName::local_llm_custom_headers("demo").unwrap(),
                "local LLM key",
            ),
            (SecretName::pii_key("demo").unwrap(), "PII key"),
        ];
        for (secret, label) in cases {
            let message = unreadable_secret_message(&secret);
            assert_eq!(
                message,
                format!(
                    "Cannot read the stored {label}. Enter it again in Speedwave Desktop (Settings)."
                )
            );
            assert!(!message.contains("Integration"));
            assert!(!message.contains("demo"));
        }
    }

    #[test]
    fn display_and_debug_of_every_variant_carry_no_secret_material() {
        let errors = [
            SecretStoreError::KeyMissing,
            SecretStoreError::KeyUnreadable,
            SecretStoreError::Unreadable(name()),
            SecretStoreError::PlaintextInStore { count: 3 },
            io_failure(
                "write secret",
                &io::Error::from(io::ErrorKind::PermissionDenied),
            ),
            operation_failure("encrypt secret"),
        ];
        for error in errors {
            let text = format!("{error} {error:?}");
            assert!(!text.contains(SENTINEL));
            assert!(!text.contains('/') || text.contains("demo/slack.token"));
        }
    }

    #[test]
    fn unreadable_display_is_names_only() {
        let text = SecretStoreError::Unreadable(name()).to_string();
        assert_eq!(text, "the secret demo/slack.token cannot be read");
    }

    #[test]
    fn io_failure_carries_the_label_and_the_kind_only() {
        let error = io_failure(
            "write secret",
            &io::Error::new(io::ErrorKind::NotFound, "/home/user/secret/path"),
        );
        let text = error.to_string();
        assert!(text.contains("write secret"));
        assert!(text.contains("not found"));
        assert!(!text.contains("/home/user"));
    }

    #[test]
    fn plaintext_error_reports_the_count() {
        assert_eq!(
            SecretStoreError::PlaintextInStore { count: 2 }.to_string(),
            "the secret store holds unexpected entries: 2"
        );
    }
}
