//! Per-project token directory path and the secret store namespace of Proxy provider keys.

use std::path::{Path, PathBuf};

/// Returns the tokens directory for a project under an explicit data dir.
pub(crate) fn resolve_tokens_dir_in(data_dir: &Path, project_name: &str) -> PathBuf {
    data_dir.join("tokens").join(project_name)
}

/// Proxy per-provider key namespace (ADR-073), reserved against plugin
/// slugs in `consts::BUILT_IN_SERVICE_IDS`.
pub const LLM_TOKEN_SERVICE: &str = "llm";

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code asserts via unwrap")]
mod tests {
    use super::*;

    #[test]
    fn tokens_dir_is_tokens_slash_project_under_the_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let path = resolve_tokens_dir_in(dir.path(), "proj");
        assert_eq!(path, dir.path().join("tokens").join("proj"));
    }

    #[test]
    fn llm_namespace_is_the_service_of_provider_key_secrets() {
        let name = crate::secret_store::SecretName::llm_provider_key("proj", "openrouter").unwrap();
        assert_eq!(name.service(), LLM_TOKEN_SERVICE);
    }
}
