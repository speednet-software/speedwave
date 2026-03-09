use speedwave_runtime::{compose, validation};
use std::path::PathBuf;

/// Path to the API key file for a project.
fn api_key_path(project: &str) -> anyhow::Result<PathBuf> {
    validation::validate_project_name(project)?;
    let secrets_dir = compose::init_secrets_dir(project)?;
    Ok(secrets_dir.join("anthropic_api_key"))
}

/// Saves an Anthropic API key for a project. The key is stored in
/// `~/.speedwave/secrets/<project>/anthropic_api_key` with chmod 600.
///
/// On Unix, the file is created with mode 0o600 atomically (no TOCTOU window).
/// On Windows, default ACLs apply (user-private by default).
pub fn save_api_key(project: &str, api_key: &str) -> anyhow::Result<()> {
    let path = api_key_path(project)?;

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
pub fn delete_api_key(project: &str) -> anyhow::Result<()> {
    let path = api_key_path(project)?;
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

/// Checks whether an API key file exists for a project.
pub fn has_api_key(project: &str) -> bool {
    api_key_path(project).map(|p| p.exists()).unwrap_or(false)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// Run a closure with HOME temporarily overridden to a temp directory.
    /// Uses a global mutex to prevent concurrent tests from racing on HOME.
    fn with_temp_home<F: FnOnce(&std::path::Path)>(f: F) {
        use std::sync::Mutex;
        static HOME_LOCK: Mutex<()> = Mutex::new(());
        let _guard = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let tmp = tempfile::tempdir().unwrap();
        let prev = std::env::var("HOME").ok();
        std::env::set_var("HOME", tmp.path().as_os_str());
        f(tmp.path());
        match prev {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    #[cfg(unix)]
    fn save_api_key_creates_file_with_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;

        with_temp_home(|home| {
            save_api_key("testproj", "sk-test-key").unwrap();
            let path = home.join(".speedwave/secrets/testproj/anthropic_api_key");
            assert!(path.exists(), "API key file should be created");

            let perms = std::fs::metadata(&path).unwrap().permissions();
            assert_eq!(
                perms.mode() & 0o777,
                0o600,
                "File should be created with mode 0600"
            );

            let content = std::fs::read_to_string(&path).unwrap();
            assert_eq!(content, "sk-test-key");
        });
    }

    #[test]
    #[cfg(unix)]
    fn save_api_key_overwrites_existing_file() {
        with_temp_home(|_home| {
            save_api_key("testproj", "old-key").unwrap();
            save_api_key("testproj", "new-key").unwrap();

            assert!(has_api_key("testproj"));
            let path = api_key_path("testproj").unwrap();
            let content = std::fs::read_to_string(&path).unwrap();
            assert_eq!(content, "new-key");
        });
    }

    #[test]
    #[cfg(unix)]
    fn delete_api_key_removes_file() {
        with_temp_home(|_home| {
            save_api_key("testproj", "sk-key").unwrap();
            assert!(has_api_key("testproj"));

            delete_api_key("testproj").unwrap();
            assert!(!has_api_key("testproj"));
        });
    }

    #[test]
    #[cfg(unix)]
    fn has_api_key_returns_false_when_missing() {
        with_temp_home(|_home| {
            assert!(!has_api_key("nonexistent"));
        });
    }
}
