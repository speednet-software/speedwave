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
    /// The store directory holds entries that are not encrypted secrets.
    PlaintextInStore {
        /// Number of unexpected entries.
        count: usize,
    },
    /// The install key file exists but is malformed.
    KeyUnreadable,
    /// The store directory or the key file cannot be read.
    StoreUnavailable,
}

/// Opens the store of `data_dir` and checks its layout.
pub fn secret_store_state(data_dir: &Path) -> SecretStoreState {
    match SecretStore::open(data_dir).and_then(|store| store.verify_layout()) {
        Ok(()) => SecretStoreState::Ready,
        Err(SecretStoreError::KeyMissing) => SecretStoreState::KeyMissing,
        Err(SecretStoreError::PlaintextInStore { count }) => {
            SecretStoreState::PlaintextInStore { count }
        }
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
            Self::PlaintextInStore { count: 1 } => Some(
                "The secrets directory holds 1 unexpected file. Remove it or reinstall Speedwave to continue."
                    .to_owned(),
            ),
            Self::PlaintextInStore { count } => Some(format!(
                "The secrets directory holds {count} unexpected files. Remove them or reinstall Speedwave to continue."
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
    fn one_unexpected_entry_is_named_in_the_singular() {
        assert_eq!(
            SecretStoreState::PlaintextInStore { count: 1 }
                .refusal("")
                .unwrap(),
            "The secrets directory holds 1 unexpected file. Remove it or reinstall Speedwave to continue."
        );
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
