use std::path::Path;

use super::error::SecretStoreError;
use super::store::SecretStore;

/// Whether the secret store lets a project start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SecretStoreState {
    /// The store is usable.
    Ready,
    /// Encrypted secrets exist but the install key does not.
    KeyMissing,
    /// The install key file exists but is malformed.
    KeyUnreadable,
    /// The store directory or the key file cannot be read, or an unknown entry cannot be removed.
    StoreUnavailable,
}

/// Opens the store of `data_dir`, removes unknown entries from it and reports its state.
pub fn secret_store_state(data_dir: &Path) -> SecretStoreState {
    match SecretStore::open(data_dir).and_then(|store| store.clean_layout()) {
        Ok(()) => SecretStoreState::Ready,
        Err(SecretStoreError::KeyMissing) => SecretStoreState::KeyMissing,
        Err(SecretStoreError::KeyUnreadable) => SecretStoreState::KeyUnreadable,
        Err(e) => {
            log::warn!("secret store check failed: {e}");
            SecretStoreState::StoreUnavailable
        }
    }
}

impl SecretStoreState {
    /// Refusal shown to the user, `None` when ready.
    pub fn refusal(&self, key_missing_step: &str) -> Option<String> {
        match self {
            Self::Ready => None,
            Self::KeyMissing => Some(format!(
                "The secret store key is missing. {key_missing_step}"
            )),
            Self::KeyUnreadable => Some(
                "The secret store key file secret-store.key in the Speedwave data directory is damaged. Restore it from a backup, or remove it together with the encrypted secrets in the secrets directory."
                    .to_owned(),
            ),
            Self::StoreUnavailable => Some(
                "The secrets directory cannot be read. Check its permissions.".to_owned(),
            ),
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    #[test]
    fn unknown_entries_are_removed_and_the_store_is_ready() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = tmp.path().join("secrets");
        std::fs::create_dir_all(secrets.join("demo")).unwrap();
        std::fs::write(secrets.join(".DS_Store"), "x").unwrap();
        std::fs::write(secrets.join("demo").join("slack.token"), "x").unwrap();

        assert_eq!(secret_store_state(tmp.path()), SecretStoreState::Ready);

        assert!(!secrets.join(".DS_Store").exists());
        assert!(!secrets.join("demo").join("slack.token").exists());
    }

    #[test]
    fn a_missing_key_leaves_unknown_entries_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("secrets").join("demo");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("slack.token.enc"), "x").unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();

        assert_eq!(secret_store_state(tmp.path()), SecretStoreState::KeyMissing);

        assert!(dir.join("notes.txt").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn an_unknown_entry_that_cannot_be_removed_makes_the_store_unavailable() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("secrets").join("demo");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let state = secret_store_state(tmp.path());
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(state, SecretStoreState::StoreUnavailable);
    }

    #[test]
    fn a_missing_key_ends_with_the_step_of_the_caller() {
        assert_eq!(
            SecretStoreState::KeyMissing
                .refusal("Open Speedwave Desktop to continue.")
                .unwrap(),
            "The secret store key is missing. Open Speedwave Desktop to continue."
        );
    }

    #[test]
    fn a_ready_store_has_no_refusal() {
        assert_eq!(SecretStoreState::Ready.refusal("x"), None);
    }
}
