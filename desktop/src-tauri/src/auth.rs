use speedwave_runtime::secret_store::{secret_exists_in, SecretName, SecretStore};
use std::path::Path;

pub(crate) fn save_api_key_in(data_dir: &Path, project: &str, api_key: &str) -> anyhow::Result<()> {
    let name = SecretName::anthropic_api_key(project)?;
    SecretStore::open(data_dir)?.write(&name, api_key)?;
    Ok(())
}

pub(crate) fn delete_api_key_in(data_dir: &Path, project: &str) -> anyhow::Result<()> {
    let name = SecretName::anthropic_api_key(project)?;
    SecretStore::open(data_dir)?.delete(&name)?;
    Ok(())
}

pub(crate) fn has_api_key_in(data_dir: &Path, project: &str) -> bool {
    SecretName::anthropic_api_key(project)
        .map(|name| secret_exists_in(data_dir, &name))
        .unwrap_or(false)
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::{Path, PathBuf};

    pub(crate) fn files_containing(root: &Path, needle: &str) -> Vec<PathBuf> {
        let mut hits = Vec::new();
        collect_hits(root, needle.as_bytes(), &mut hits);
        hits
    }

    fn collect_hits(dir: &Path, needle: &[u8], hits: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_hits(&path, needle, hits);
            } else if let Ok(bytes) = std::fs::read(&path) {
                if bytes.windows(needle.len()).any(|w| w == needle) {
                    hits.push(path);
                }
            }
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test module uses unwrap() only, never expect()"
)]
mod tests {
    use super::*;

    fn read_back(data_dir: &Path, project: &str) -> Option<String> {
        let name = SecretName::anthropic_api_key(project).unwrap();
        SecretStore::open(data_dir)
            .unwrap()
            .read(&name)
            .unwrap()
            .map(|v| v.to_string())
    }

    #[test]
    fn save_api_key_is_readable_through_the_store_and_in_no_plaintext_file() {
        let data_dir = tempfile::tempdir().unwrap();
        save_api_key_in(data_dir.path(), "auth-store", "sk-ant-SENTINEL-1016").unwrap();

        assert!(has_api_key_in(data_dir.path(), "auth-store"));
        assert_eq!(
            read_back(data_dir.path(), "auth-store").as_deref(),
            Some("sk-ant-SENTINEL-1016")
        );
        assert!(
            test_support::files_containing(data_dir.path(), "SENTINEL-1016").is_empty(),
            "the key must not appear in any file of the data dir"
        );
    }

    #[test]
    fn save_api_key_overwrites_existing_value() {
        let data_dir = tempfile::tempdir().unwrap();
        save_api_key_in(data_dir.path(), "auth-overwrite", "old-key").unwrap();
        save_api_key_in(data_dir.path(), "auth-overwrite", "new-key").unwrap();

        assert!(has_api_key_in(data_dir.path(), "auth-overwrite"));
        assert_eq!(
            read_back(data_dir.path(), "auth-overwrite").as_deref(),
            Some("new-key")
        );
    }

    #[test]
    fn delete_api_key_removes_the_secret() {
        let data_dir = tempfile::tempdir().unwrap();
        save_api_key_in(data_dir.path(), "auth-delete", "sk-key").unwrap();
        assert!(has_api_key_in(data_dir.path(), "auth-delete"));

        delete_api_key_in(data_dir.path(), "auth-delete").unwrap();
        assert!(!has_api_key_in(data_dir.path(), "auth-delete"));
        assert_eq!(read_back(data_dir.path(), "auth-delete"), None);
    }

    #[test]
    fn delete_api_key_without_a_key_succeeds() {
        let data_dir = tempfile::tempdir().unwrap();
        delete_api_key_in(data_dir.path(), "auth-delete-none").unwrap();
    }

    #[test]
    fn has_api_key_returns_false_when_missing() {
        let data_dir = tempfile::tempdir().unwrap();
        assert!(!has_api_key_in(data_dir.path(), "nonexistent-auth-test"));
    }

    #[test]
    fn save_api_key_rejects_an_invalid_project_name_without_leaking_the_key() {
        let data_dir = tempfile::tempdir().unwrap();
        let err = save_api_key_in(data_dir.path(), "../escape", "sk-ant-LEAK-CHECK").unwrap_err();
        assert!(!err.to_string().contains("LEAK-CHECK"));
        assert!(!has_api_key_in(data_dir.path(), "../escape"));
    }
}
