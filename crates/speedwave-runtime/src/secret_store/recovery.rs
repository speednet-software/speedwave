use std::collections::BTreeSet;
use std::fs::DirEntry;
use std::path::{Path, PathBuf};

use super::error::{io_failure, SecretStoreError};
use super::key_source::{FileKeySource, KeySource};
use super::layout::{is_encrypted_file, is_lock_file, is_project_dir};
use super::name::SecretName;
use super::store::{KEY_FILE, SECRETS_DIR};

/// One integration of a project that still has encrypted secrets on disk; names only.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct EncryptedIntegration {
    /// Project the integration belongs to.
    pub project: String,
    /// Service name of the integration.
    pub service: String,
}

/// Integrations that own encrypted secrets, from the file names only; sorted and deduplicated.
pub fn encrypted_integrations(data_dir: &Path) -> Vec<EncryptedIntegration> {
    let mut found = BTreeSet::new();
    for (project, dir) in project_dirs(&data_dir.join(SECRETS_DIR)) {
        for entry in dir_entries(&dir) {
            let file_name = entry.file_name();
            let Some(name) = file_name
                .to_str()
                .and_then(|file_name| SecretName::from_file_name(&project, file_name))
            else {
                continue;
            };
            found.insert(EncryptedIntegration {
                project: name.project().to_owned(),
                service: name.service().to_owned(),
            });
        }
    }
    found.into_iter().collect()
}

/// Deletes every encrypted secret and lock file when the install key is gone; returns the count.
pub fn discard_secrets_without_key(data_dir: &Path) -> Result<usize, SecretStoreError> {
    let source = FileKeySource::new(data_dir.join(KEY_FILE));
    if source.load()?.is_some() {
        return Err(SecretStoreError::Io(
            "discard secrets: the install key is present".to_owned(),
        ));
    }
    let mut removed = 0;
    for (_, dir) in project_dirs(&data_dir.join(SECRETS_DIR)) {
        for entry in dir_entries(&dir) {
            if !is_discardable(&entry) {
                continue;
            }
            match std::fs::remove_file(entry.path()) {
                Ok(()) => removed += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(io_failure("discard secret", &e)),
            }
        }
    }
    Ok(removed)
}

fn project_dirs(secrets_dir: &Path) -> Vec<(String, PathBuf)> {
    dir_entries(secrets_dir)
        .into_iter()
        .filter(is_project_dir)
        .filter_map(|entry| {
            let project = entry.file_name().to_str()?.to_owned();
            Some((project, entry.path()))
        })
        .collect()
}

fn dir_entries(dir: &Path) -> Vec<DirEntry> {
    std::fs::read_dir(dir)
        .map(|read| read.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

fn is_discardable(entry: &DirEntry) -> bool {
    is_encrypted_file(entry) || is_lock_file(entry)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use crate::secret_store::SecretStore;

    fn seed(root: &Path, project: &str, file: &str, content: &str) -> PathBuf {
        let dir = root.join("secrets").join(project);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(file);
        std::fs::write(&path, content).unwrap();
        path
    }

    fn integration(project: &str, service: &str) -> EncryptedIntegration {
        EncryptedIntegration {
            project: project.to_owned(),
            service: service.to_owned(),
        }
    }

    #[test]
    fn a_missing_secrets_dir_lists_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(encrypted_integrations(tmp.path()).is_empty());
    }

    #[test]
    fn integrations_are_sorted_deduplicated_and_names_only() {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "zeta", "slack.token.enc", "x");
        seed(tmp.path(), "alpha", "slack.token.enc", "x");
        seed(tmp.path(), "alpha", "slack.refresh_token.enc", "x");
        seed(tmp.path(), "alpha", "redmine.api_key.enc", "x");
        seed(tmp.path(), "alpha", "notes.txt", "x");
        seed(tmp.path(), "alpha", "slack.token.enc.lock", "");
        seed(tmp.path(), "alpha", "noservice.enc", "x");

        assert_eq!(
            encrypted_integrations(tmp.path()),
            vec![
                integration("alpha", "redmine"),
                integration("alpha", "slack"),
                integration("zeta", "slack"),
            ]
        );
    }

    #[test]
    fn discard_removes_enc_and_lock_files_of_every_project() {
        let tmp = tempfile::tempdir().unwrap();
        let first = seed(tmp.path(), "alpha", "slack.token.enc", "x");
        let second = seed(tmp.path(), "alpha", "slack.token.enc.lock", "");
        let third = seed(tmp.path(), "beta", "redmine.api_key.enc", "x");

        assert_eq!(discard_secrets_without_key(tmp.path()).unwrap(), 3);
        assert!(!first.exists() && !second.exists() && !third.exists());
        assert!(encrypted_integrations(tmp.path()).is_empty());
    }

    #[test]
    fn discard_leaves_other_files_alone() {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "alpha", "slack.token.enc", "x");
        let plain = seed(tmp.path(), "alpha", "slack.token", "plain");
        let note = seed(tmp.path(), "alpha", "notes.txt", "note");
        let loose = tmp.path().join("secrets").join("loose.enc");
        std::fs::write(&loose, "x").unwrap();
        let config = tmp.path().join("config.json");
        std::fs::write(&config, "{}").unwrap();
        let nested = tmp.path().join("secrets/alpha/sub");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("deep.enc"), "x").unwrap();

        assert_eq!(discard_secrets_without_key(tmp.path()).unwrap(), 1);
        assert!(plain.exists() && note.exists() && loose.exists() && config.exists());
        assert!(nested.join("deep.enc").exists());
    }

    #[test]
    fn after_a_discard_the_store_opens_although_stray_entries_remain() {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path(), "alpha", "slack.token.enc", "x");
        seed(tmp.path(), "alpha", "slack.token.enc.lock", "");
        std::fs::write(tmp.path().join("secrets").join("loose.enc"), "x").unwrap();
        let nested = tmp.path().join("secrets/alpha/sub");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("deep.enc"), "x").unwrap();
        assert!(matches!(
            SecretStore::open(tmp.path()),
            Err(SecretStoreError::KeyMissing)
        ));

        discard_secrets_without_key(tmp.path()).unwrap();

        assert!(SecretStore::open(tmp.path()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn after_a_discard_a_symlinked_enc_file_does_not_keep_the_key_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("victim.enc");
        std::fs::write(&target, "keep").unwrap();
        let dir = tmp.path().join("secrets").join("alpha");
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(&target, dir.join("slack.token.enc")).unwrap();

        assert!(SecretStore::open(tmp.path()).is_ok());
        assert_eq!(discard_secrets_without_key(tmp.path()).unwrap(), 0);
        assert!(target.exists());
    }

    #[test]
    fn discard_without_a_secrets_dir_removes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(discard_secrets_without_key(tmp.path()).unwrap(), 0);
    }

    #[test]
    fn discard_refuses_while_a_valid_key_exists() {
        let tmp = tempfile::tempdir().unwrap();
        FileKeySource::new(tmp.path().join(KEY_FILE))
            .create()
            .unwrap();
        let secret = seed(tmp.path(), "alpha", "slack.token.enc", "x");

        assert!(discard_secrets_without_key(tmp.path()).is_err());
        assert!(secret.exists());
    }

    #[test]
    fn discard_refuses_a_malformed_key_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(KEY_FILE), "not a key").unwrap();
        let secret = seed(tmp.path(), "alpha", "slack.token.enc", "x");

        assert!(matches!(
            discard_secrets_without_key(tmp.path()),
            Err(SecretStoreError::KeyUnreadable)
        ));
        assert!(secret.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("victim.enc");
        std::fs::write(&target, "keep").unwrap();
        let dir = tmp.path().join("secrets").join("alpha");
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(&target, dir.join("slack.token.enc")).unwrap();
        std::os::unix::fs::symlink(outside.path(), tmp.path().join("secrets").join("linked"))
            .unwrap();
        std::fs::write(outside.path().join("other.enc"), "keep").unwrap();

        assert_eq!(discard_secrets_without_key(tmp.path()).unwrap(), 0);
        assert!(target.exists());
        assert!(outside.path().join("other.enc").exists());
        assert_eq!(
            encrypted_integrations(tmp.path()),
            vec![integration("alpha", "slack")]
        );
    }
}
