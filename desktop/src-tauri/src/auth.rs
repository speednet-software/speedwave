use speedwave_runtime::{compose, validation};
use std::path::{Path, PathBuf};

/// Path to the API key file for a project.
fn api_key_path_in(data_dir: &Path, project: &str) -> anyhow::Result<PathBuf> {
    validation::validate_project_name(project)?;
    let secrets_dir = compose::init_secrets_dir_in(data_dir, project)?;
    Ok(secrets_dir.join("anthropic_api_key"))
}

/// Saves an Anthropic API key for a project at `~/.speedwave/secrets/<project>/anthropic_api_key`.
/// Unix: created with mode 0o600 atomically (no TOCTOU window). Windows: default user-private ACLs.
pub fn save_api_key_in(data_dir: &Path, project: &str, api_key: &str) -> anyhow::Result<()> {
    let path = api_key_path_in(data_dir, project)?;

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(api_key.as_bytes())?;
    }

    #[cfg(not(unix))]
    {
        std::fs::write(&path, api_key)?;
    }

    Ok(())
}

/// Deletes the stored API key for a project.
pub fn delete_api_key_in(data_dir: &Path, project: &str) -> anyhow::Result<()> {
    let path = api_key_path_in(data_dir, project)?;
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

/// Checks whether an API key file exists for a project.
pub fn has_api_key_in(data_dir: &Path, project: &str) -> bool {
    api_key_path_in(data_dir, project)
        .map(|p| p.exists())
        .unwrap_or(false)
}

#[cfg(all(test, unix))]
#[expect(
    clippy::unwrap_used,
    reason = "test module uses unwrap() only, never expect()"
)]
mod tests {
    use super::*;

    #[test]
    fn save_api_key_creates_file_with_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let data_dir = tempfile::tempdir().unwrap();
        save_api_key_in(data_dir.path(), "auth-perms", "sk-test-key").unwrap();
        let path = api_key_path_in(data_dir.path(), "auth-perms").unwrap();

        assert!(path.exists(), "API key file should be created");

        let perms = std::fs::metadata(&path).unwrap().permissions();
        assert_eq!(
            perms.mode() & 0o777,
            0o600,
            "File should be created with mode 0600"
        );

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "sk-test-key");
    }

    #[test]
    fn save_api_key_overwrites_existing_file() {
        let data_dir = tempfile::tempdir().unwrap();
        save_api_key_in(data_dir.path(), "auth-overwrite", "old-key").unwrap();
        save_api_key_in(data_dir.path(), "auth-overwrite", "new-key").unwrap();

        assert!(has_api_key_in(data_dir.path(), "auth-overwrite"));
        let path = api_key_path_in(data_dir.path(), "auth-overwrite").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "new-key");
    }

    #[test]
    fn delete_api_key_removes_file() {
        let data_dir = tempfile::tempdir().unwrap();
        save_api_key_in(data_dir.path(), "auth-delete", "sk-key").unwrap();
        assert!(has_api_key_in(data_dir.path(), "auth-delete"));

        delete_api_key_in(data_dir.path(), "auth-delete").unwrap();
        assert!(!has_api_key_in(data_dir.path(), "auth-delete"));
    }

    #[test]
    fn has_api_key_returns_false_when_missing() {
        let data_dir = tempfile::tempdir().unwrap();
        assert!(!has_api_key_in(data_dir.path(), "nonexistent-auth-test"));
    }
}
