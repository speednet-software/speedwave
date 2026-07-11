//! Per-project token / secrets directory paths. Whitelisted service+file
//! names prevent path traversal; owner-only perms on every level.

use crate::consts;
use std::path::{Path, PathBuf};

/// Returns the tokens directory for a project under an explicit data dir.
pub(crate) fn resolve_tokens_dir_in(data_dir: &Path, project_name: &str) -> PathBuf {
    data_dir.join("tokens").join(project_name)
}

/// Creates `~/.speedwave/secrets/<project>/` with `0o700` on it and the
/// parent `secrets/` directory.
pub fn init_secrets_dir(project: &str) -> anyhow::Result<PathBuf> {
    init_secrets_dir_in(consts::data_dir(), project)
}

/// Testable variant: accepts explicit data_dir.
pub(crate) fn init_secrets_dir_in(data_dir: &Path, project: &str) -> anyhow::Result<PathBuf> {
    crate::validation::validate_project_name(project)?;
    let secrets_dir = data_dir.join("secrets").join(project);
    std::fs::create_dir_all(&secrets_dir)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode_700 = std::fs::Permissions::from_mode(0o700);
        // secrets_dir = data_dir/secrets/<project>
        std::fs::set_permissions(&secrets_dir, mode_700.clone())?;
        if let Some(secrets_parent) = secrets_dir.parent() {
            // secrets_parent = data_dir/secrets/ — one level above, stop here
            std::fs::set_permissions(secrets_parent, mode_700)?;
        }
    }

    Ok(secrets_dir)
}

// ── Local-LLM token paths ────────────────────────────────────────────────

/// Services with token files under `~/.speedwave/tokens/<project>/<service>/`.
/// Whitelist enforced by `tokens_path`. Plugins use a separate path discipline
/// (validated by `plugin::validate_manifest`).
const ALLOWED_TOKEN_SERVICES: &[&str] = &["local-llm", LLM_TOKEN_SERVICE];

/// Proxy per-provider key namespace (ADR-073), reserved against plugin
/// slugs in `consts::BUILT_IN_SERVICE_IDS`.
pub const LLM_TOKEN_SERVICE: &str = "llm";

/// Suffix every Proxy provider key file carries: `<provider_id>_api_key`.
pub const LLM_TOKEN_FILE_SUFFIX: &str = "_api_key";

/// Per-service whitelist of file names allowed under
/// `tokens/<project>/<service>/`. Adding a new file = edit this map.
const ALLOWED_TOKEN_FILES_LOCAL_LLM: &[&str] = &["api_key", "custom_headers"];

/// Validates a file name for the given token service. `local-llm` uses a
/// static whitelist; `llm` file names embed a slug-validated provider id.
fn validate_token_file(service: &str, file: &str) -> anyhow::Result<()> {
    match service {
        "local-llm" => {
            if !ALLOWED_TOKEN_FILES_LOCAL_LLM.contains(&file) {
                anyhow::bail!(
                    "tokens_path: file '{}' not allowed for service '{}'",
                    file,
                    service
                );
            }
            Ok(())
        }
        LLM_TOKEN_SERVICE => {
            let provider_id = file.strip_suffix(LLM_TOKEN_FILE_SUFFIX).ok_or_else(|| {
                anyhow::anyhow!(
                    "tokens_path: file '{}' must end with '{}'",
                    file,
                    LLM_TOKEN_FILE_SUFFIX
                )
            })?;
            if !crate::plugin::is_valid_slug(provider_id) {
                anyhow::bail!(
                    "tokens_path: provider id '{}' is not a valid slug",
                    provider_id
                );
            }
            Ok(())
        }
        _ => anyhow::bail!("tokens_path: no file allow-list for service '{}'", service),
    }
}

/// Resolves the key-file path for one Proxy provider:
/// `tokens/<project>/llm/<provider_id>_api_key`. Slug-validates the id.
pub fn llm_provider_key_path_in(
    data_dir: &Path,
    project: &str,
    provider_id: &str,
) -> anyhow::Result<PathBuf> {
    tokens_path_in(
        data_dir,
        project,
        LLM_TOKEN_SERVICE,
        &format!("{provider_id}{LLM_TOKEN_FILE_SUFFIX}"),
    )
}

/// Resolves the on-disk path for a per-project local-LLM token file.
/// Validates every segment against allow-lists to prevent path traversal.
pub fn tokens_path(project: &str, service: &str, file: &str) -> anyhow::Result<PathBuf> {
    tokens_path_in(consts::data_dir().as_path(), project, service, file)
}

/// Testable variant: resolves under an explicit data directory.
pub fn tokens_path_in(
    data_dir: &Path,
    project: &str,
    service: &str,
    file: &str,
) -> anyhow::Result<PathBuf> {
    crate::validation::validate_project_name(project)?;
    if !ALLOWED_TOKEN_SERVICES.contains(&service) {
        anyhow::bail!("tokens_path: service '{}' not in allow-list", service);
    }
    validate_token_file(service, file)?;
    Ok(data_dir
        .join("tokens")
        .join(project)
        .join(service)
        .join(file))
}

/// Ensures `~/.speedwave/tokens/<project>/<service>/` exists with owner-only
/// perms on every level (`tokens/`, `tokens/<project>/`,
/// `tokens/<project>/<service>/`). Validates segments via `tokens_path`.
pub fn ensure_token_dir(project: &str, service: &str) -> anyhow::Result<PathBuf> {
    ensure_token_dir_in(consts::data_dir().as_path(), project, service)
}

/// Testable variant.
pub fn ensure_token_dir_in(
    data_dir: &Path,
    project: &str,
    service: &str,
) -> anyhow::Result<PathBuf> {
    crate::validation::validate_project_name(project)?;
    if !ALLOWED_TOKEN_SERVICES.contains(&service) {
        anyhow::bail!("ensure_token_dir: service '{}' not in allow-list", service);
    }
    let tokens_root = data_dir.join("tokens");
    crate::fs_perms::ensure_owner_only_dir(&tokens_root)?;
    let project_dir = tokens_root.join(project);
    crate::fs_perms::ensure_owner_only_dir(&project_dir)?;
    let service_dir = project_dir.join(service);
    crate::fs_perms::ensure_owner_only_dir(&service_dir)?;
    Ok(service_dir)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test-only module: unwraps assert setup succeeded"
)]
mod tests {
    use super::*;

    fn data_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    // ── llm token namespace (ADR-073) ────────────────────────────────────

    #[test]
    fn llm_key_path_happy_path() {
        let d = data_dir();
        let p = llm_provider_key_path_in(d.path(), "proj", "openrouter").unwrap();
        assert!(
            p.ends_with("tokens/proj/llm/openrouter_api_key"),
            "got {p:?}"
        );
    }

    #[test]
    fn llm_file_must_end_with_api_key_suffix() {
        // `llm` service file names must carry the `_api_key` suffix.
        let err = tokens_path_in(data_dir().path(), "proj", LLM_TOKEN_SERVICE, "openrouter")
            .unwrap_err()
            .to_string();
        assert!(err.contains("must end with"), "got: {err}");
    }

    #[test]
    fn llm_provider_id_must_be_a_slug() {
        // Leading capital, dot, and traversal segments all fail the slug shape
        // before they can reach a file path.
        for bad in [
            "Bad_api_key",
            "a.b_api_key",
            "../escape_api_key",
            "9lead_api_key",
        ] {
            let err = tokens_path_in(data_dir().path(), "proj", LLM_TOKEN_SERVICE, bad)
                .unwrap_err()
                .to_string();
            assert!(
                err.contains("not a valid slug") || err.contains("must end with"),
                "id '{bad}' should be rejected, got: {err}"
            );
        }
    }

    #[test]
    fn llm_empty_provider_id_rejected() {
        // `_api_key` alone strips to an empty id, which is not a valid slug.
        let err = tokens_path_in(data_dir().path(), "proj", LLM_TOKEN_SERVICE, "_api_key")
            .unwrap_err()
            .to_string();
        assert!(err.contains("not a valid slug"), "got: {err}");
    }

    // ── service allow-list ────────────────────────────────────────────────

    #[test]
    fn unknown_service_rejected() {
        let err = tokens_path_in(data_dir().path(), "proj", "evil", "api_key")
            .unwrap_err()
            .to_string();
        assert!(err.contains("not in allow-list"), "got: {err}");
    }

    #[test]
    fn local_llm_file_allow_list_enforced() {
        let d = data_dir();
        assert!(tokens_path_in(d.path(), "proj", "local-llm", "api_key").is_ok());
        let err = tokens_path_in(d.path(), "proj", "local-llm", "secret")
            .unwrap_err()
            .to_string();
        assert!(err.contains("not allowed"), "got: {err}");
    }

    #[test]
    fn invalid_project_name_rejected_before_file_check() {
        let err = tokens_path_in(
            data_dir().path(),
            "../escape",
            LLM_TOKEN_SERVICE,
            "ok_api_key",
        )
        .unwrap_err()
        .to_string();
        assert!(!err.is_empty(), "project-name validation must fire first");
    }
}
