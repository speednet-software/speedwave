//! Per-project token / secrets directory paths. Whitelisted service+file
//! names prevent path traversal; owner-only perms on every level.

use crate::consts;
use std::path::{Path, PathBuf};

/// Returns the tokens directory for a project under an explicit data dir.
pub(crate) fn resolve_tokens_dir_in(data_dir: &Path, project_name: &str) -> PathBuf {
    data_dir.join("tokens").join(project_name)
}

/// Creates the secrets directory for a project with restrictive permissions (chmod 700).
/// Path: `~/.speedwave/secrets/<project>/`
///
/// Also sets `0o700` on the parent `secrets/` directory.
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
//
// Per-project secrets for the "local" LLM provider (Bearer token + custom
// headers) live at `~/.speedwave/tokens/<project>/local-llm/<file>` with
// owner-only perms (Unix 0o600 files, 0o700 dirs; Windows ACL deny-others).
//
// `tokens_path` and `ensure_token_dir` are the SSOT for resolving these paths.
// Service and file names are whitelisted to prevent path traversal — adding a
// new local-LLM artifact = edit one constant, not the helper signature.

/// Services with token files under `~/.speedwave/tokens/<project>/<service>/`.
/// Whitelist enforced by `tokens_path`. Plugins use a separate path discipline
/// (validated by `plugin::validate_manifest`).
const ALLOWED_TOKEN_SERVICES: &[&str] = &["local-llm", LLM_TOKEN_SERVICE];

/// LiteLLM per-provider key namespace (ADR-072). Mounted `:ro` at `/tokens`
/// in the litellm container; its entrypoint exports each file as
/// `SPW_KEY_<PROVIDER_ID>`. The namespace is reserved against plugin slugs
/// in `consts::BUILT_IN_SERVICE_IDS`.
pub const LLM_TOKEN_SERVICE: &str = "llm";

/// Suffix every LiteLLM provider key file carries: `<provider_id>_api_key`.
pub const LLM_TOKEN_FILE_SUFFIX: &str = "_api_key";

/// Per-service whitelist of file names allowed under
/// `tokens/<project>/<service>/`. Adding a new file = edit this map.
const ALLOWED_TOKEN_FILES_LOCAL_LLM: &[&str] = &["api_key", "custom_headers"];

/// Validates a file name for the given token service. `local-llm` uses a
/// static whitelist; `llm` file names embed a user-defined provider id, so
/// the id segment is validated against the plugin-grade slug shape instead
/// (`^[a-z][a-z0-9-]{0,63}$` — no dots, no slashes, no traversal).
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

/// Resolves the key-file path for one LiteLLM provider:
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
