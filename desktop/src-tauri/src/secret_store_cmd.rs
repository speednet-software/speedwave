use std::path::Path;
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use speedwave_runtime::compose::unreadable_integration_messages;
use speedwave_runtime::config;
use speedwave_runtime::secret_store::{
    discard_secrets_without_key, encrypted_integrations, SecretStore, SecretStoreError,
};

const KEY_MISSING_REFUSAL: &str =
    "The secret store key is missing. Open Speedwave Desktop (Settings) to create a new key.";
const KEY_UNREADABLE_REFUSAL: &str =
    "The secret store key file is damaged. Reinstall Speedwave to continue.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SecretStoreState {
    Ready,
    KeyMissing,
    PlaintextInStore { count: usize },
    KeyUnreadable,
}

pub(crate) struct SecretStoreHealth(Mutex<SecretStoreState>);

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SecretStoreStateName {
    Ready,
    KeyMissing,
    PlaintextInStore,
    KeyUnreadable,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub(crate) struct SecretStoreIntegration {
    project: String,
    service: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SecretStoreStatus {
    state: SecretStoreStateName,
    integrations: Vec<SecretStoreIntegration>,
    plaintext_count: usize,
    unreadable: Vec<String>,
}

impl SecretStoreHealth {
    pub(crate) fn open(data_dir: &Path) -> Self {
        let state = evaluate(data_dir);
        if state != SecretStoreState::Ready {
            log::warn!("secret store is not ready: {}", state.log_label());
        }
        Self(Mutex::new(state))
    }

    fn replace(&self, state: SecretStoreState) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = state;
    }
}

impl SecretStoreState {
    fn name(&self) -> SecretStoreStateName {
        match self {
            Self::Ready => SecretStoreStateName::Ready,
            Self::KeyMissing => SecretStoreStateName::KeyMissing,
            Self::PlaintextInStore { .. } => SecretStoreStateName::PlaintextInStore,
            Self::KeyUnreadable => SecretStoreStateName::KeyUnreadable,
        }
    }

    fn log_label(&self) -> String {
        match self {
            Self::Ready => "ready".to_owned(),
            Self::KeyMissing => "key missing".to_owned(),
            Self::PlaintextInStore { count } => format!("{count} unexpected entries"),
            Self::KeyUnreadable => "key unreadable".to_owned(),
        }
    }
}

#[tauri::command]
pub(crate) fn get_secret_store_status(
    health: tauri::State<'_, SecretStoreHealth>,
) -> SecretStoreStatus {
    let data_dir = speedwave_runtime::consts::data_dir();
    let state = evaluate(data_dir);
    health.replace(state.clone());
    status_of(data_dir, &state, active_project().as_deref())
}

#[tauri::command]
pub(crate) fn reset_secret_store(
    health: tauri::State<'_, SecretStoreHealth>,
    confirmed: bool,
) -> Result<SecretStoreStatus, String> {
    let data_dir = speedwave_runtime::consts::data_dir();
    reset_in(data_dir, confirmed, active_project().as_deref(), &health)
}

pub(crate) fn ensure_ready_for_start() -> Result<(), String> {
    ensure_ready_in(speedwave_runtime::consts::data_dir())
}

fn ensure_ready_in(data_dir: &Path) -> Result<(), String> {
    match refusal_for(&evaluate(data_dir)) {
        Some(message) => Err(message),
        None => Ok(()),
    }
}

fn refusal_for(state: &SecretStoreState) -> Option<String> {
    match state {
        SecretStoreState::Ready => None,
        SecretStoreState::KeyMissing => Some(KEY_MISSING_REFUSAL.to_owned()),
        SecretStoreState::PlaintextInStore { count } => Some(format!(
            "The secrets directory holds {count} unexpected files. Remove them or reinstall Speedwave to continue."
        )),
        SecretStoreState::KeyUnreadable => Some(KEY_UNREADABLE_REFUSAL.to_owned()),
    }
}

fn reset_in(
    data_dir: &Path,
    confirmed: bool,
    active_project: Option<&str>,
    health: &SecretStoreHealth,
) -> Result<SecretStoreStatus, String> {
    if !confirmed {
        return Err("Creating a new secret store key needs an explicit confirmation.".to_owned());
    }
    if evaluate(data_dir) != SecretStoreState::KeyMissing {
        return Err("The secret store does not need a new key.".to_owned());
    }
    let removed = discard_secrets_without_key(data_dir).map_err(|e| e.to_string())?;
    log::warn!("secret store reset: discarded {removed} encrypted files without a key");
    let state = evaluate(data_dir);
    health.replace(state.clone());
    Ok(status_of(data_dir, &state, active_project))
}

fn evaluate(data_dir: &Path) -> SecretStoreState {
    match SecretStore::open(data_dir).and_then(|store| store.verify_layout()) {
        Ok(()) => SecretStoreState::Ready,
        Err(SecretStoreError::KeyMissing) => SecretStoreState::KeyMissing,
        Err(SecretStoreError::PlaintextInStore { count }) => {
            SecretStoreState::PlaintextInStore { count }
        }
        Err(SecretStoreError::KeyUnreadable) => SecretStoreState::KeyUnreadable,
        Err(e) => {
            log::warn!("secret store check failed: {e}");
            SecretStoreState::KeyUnreadable
        }
    }
}

fn status_of(
    data_dir: &Path,
    state: &SecretStoreState,
    active_project: Option<&str>,
) -> SecretStoreStatus {
    let integrations = match state {
        SecretStoreState::KeyMissing => encrypted_integrations(data_dir)
            .into_iter()
            .map(|integration| SecretStoreIntegration {
                project: integration.project,
                service: integration.service,
            })
            .collect(),
        _ => Vec::new(),
    };
    let plaintext_count = match state {
        SecretStoreState::PlaintextInStore { count } => *count,
        _ => 0,
    };
    let unreadable = match (state, active_project) {
        (SecretStoreState::Ready, Some(project)) => {
            unreadable_integration_messages(data_dir, project)
        }
        _ => Vec::new(),
    };
    SecretStoreStatus {
        state: state.name(),
        integrations,
        plaintext_count,
        unreadable,
    }
}

fn active_project() -> Option<String> {
    config::load_user_config()
        .ok()
        .and_then(|user_config| user_config.active_project)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use speedwave_runtime::secret_store::SecretName;

    fn seed_enc(root: &Path, project: &str, file: &str) -> std::path::PathBuf {
        let dir = root.join("secrets").join(project);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(file);
        std::fs::write(&path, "x").unwrap();
        path
    }

    fn health(root: &Path) -> SecretStoreHealth {
        SecretStoreHealth::open(root)
    }

    #[test]
    fn an_empty_data_dir_is_ready() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(evaluate(tmp.path()), SecretStoreState::Ready);
        assert!(ensure_ready_in(tmp.path()).is_ok());
    }

    #[test]
    fn a_working_store_is_ready() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        store
            .write(
                &SecretName::integration("demo", "slack", "token").unwrap(),
                "v",
            )
            .unwrap();
        assert_eq!(evaluate(tmp.path()), SecretStoreState::Ready);
    }

    #[test]
    fn ciphertext_without_a_key_is_key_missing() {
        let tmp = tempfile::tempdir().unwrap();
        seed_enc(tmp.path(), "demo", "slack.token.enc");
        assert_eq!(evaluate(tmp.path()), SecretStoreState::KeyMissing);
        assert_eq!(
            ensure_ready_in(tmp.path()).unwrap_err(),
            "The secret store key is missing. Open Speedwave Desktop (Settings) to create a new key."
        );
    }

    #[test]
    fn a_malformed_key_file_is_key_unreadable() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("secret-store.key"), "garbage").unwrap();
        assert_eq!(evaluate(tmp.path()), SecretStoreState::KeyUnreadable);
        assert!(ensure_ready_in(tmp.path()).unwrap_err().contains("damaged"));
    }

    #[test]
    fn plaintext_beside_the_secrets_is_reported_with_a_count() {
        let tmp = tempfile::tempdir().unwrap();
        SecretStore::open(tmp.path()).unwrap().ensure_key().unwrap();
        seed_enc(tmp.path(), "demo", "slack.token");
        seed_enc(tmp.path(), "demo", "notes.txt");
        assert_eq!(
            evaluate(tmp.path()),
            SecretStoreState::PlaintextInStore { count: 2 }
        );
        assert!(ensure_ready_in(tmp.path())
            .unwrap_err()
            .contains("2 unexpected files"));
    }

    #[test]
    fn status_of_key_missing_lists_the_integrations() {
        let tmp = tempfile::tempdir().unwrap();
        seed_enc(tmp.path(), "demo", "slack.token.enc");
        seed_enc(tmp.path(), "demo", "slack.refresh_token.enc");
        seed_enc(tmp.path(), "demo", "redmine.api_key.enc");

        let status = status_of(tmp.path(), &SecretStoreState::KeyMissing, Some("demo"));

        assert_eq!(status.state, SecretStoreStateName::KeyMissing);
        assert_eq!(
            status.integrations,
            vec![
                SecretStoreIntegration {
                    project: "demo".to_owned(),
                    service: "redmine".to_owned()
                },
                SecretStoreIntegration {
                    project: "demo".to_owned(),
                    service: "slack".to_owned()
                },
            ]
        );
        assert_eq!(status.plaintext_count, 0);
        assert!(status.unreadable.is_empty());
    }

    #[test]
    fn status_of_plaintext_carries_the_count_only() {
        let tmp = tempfile::tempdir().unwrap();
        let status = status_of(
            tmp.path(),
            &SecretStoreState::PlaintextInStore { count: 4 },
            Some("demo"),
        );
        assert_eq!(status.state, SecretStoreStateName::PlaintextInStore);
        assert_eq!(status.plaintext_count, 4);
        assert!(status.integrations.is_empty());
    }

    #[test]
    fn status_of_ready_lists_unreadable_messages_of_the_active_project() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        store
            .write(
                &SecretName::integration("demo", "slack", "token").unwrap(),
                "v",
            )
            .unwrap();
        std::fs::write(
            tmp.path().join("secrets/demo/redmine.api_key.enc"),
            "speedwave-secret:v1:broken",
        )
        .unwrap();

        let active = status_of(tmp.path(), &SecretStoreState::Ready, Some("demo"));
        let other = status_of(tmp.path(), &SecretStoreState::Ready, Some("other"));
        let none = status_of(tmp.path(), &SecretStoreState::Ready, None);

        assert_eq!(active.state, SecretStoreStateName::Ready);
        assert_eq!(active.unreadable.len(), 1);
        assert!(active.unreadable[0].contains("redmine"));
        assert!(other.unreadable.is_empty());
        assert!(none.unreadable.is_empty());
    }

    #[test]
    fn reset_refuses_without_confirmation_and_keeps_the_files() {
        let tmp = tempfile::tempdir().unwrap();
        let secret = seed_enc(tmp.path(), "demo", "slack.token.enc");
        let health = health(tmp.path());

        assert!(reset_in(tmp.path(), false, None, &health).is_err());
        assert!(secret.exists());
    }

    #[test]
    fn reset_discards_the_ciphertexts_and_returns_ready() {
        let tmp = tempfile::tempdir().unwrap();
        let secret = seed_enc(tmp.path(), "demo", "slack.token.enc");
        let health = health(tmp.path());

        let status = reset_in(tmp.path(), true, Some("demo"), &health).unwrap();

        assert_eq!(status.state, SecretStoreStateName::Ready);
        assert!(!secret.exists());
        assert_eq!(*health.0.lock().unwrap(), SecretStoreState::Ready);
        assert!(ensure_ready_in(tmp.path()).is_ok());
    }

    #[test]
    fn reset_refuses_outside_key_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let name = SecretName::integration("demo", "slack", "token").unwrap();
        store.write(&name, "v").unwrap();
        let health = health(tmp.path());

        assert!(reset_in(tmp.path(), true, None, &health).is_err());
        assert_eq!(store.read(&name).unwrap().unwrap().as_str(), "v");
    }

    #[test]
    fn reset_refuses_with_a_malformed_key_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("secret-store.key"), "garbage").unwrap();
        let secret = seed_enc(tmp.path(), "demo", "slack.token.enc");
        let health = health(tmp.path());

        assert!(reset_in(tmp.path(), true, None, &health).is_err());
        assert!(secret.exists());
    }

    #[test]
    fn status_matches_ts_mirror() {
        use crate::ts_mirror::{rust_fields, serde_names, ts_interface_fields, ts_union_members};
        let ts = include_str!("../../src/src/app/models/secret-store.ts");
        let status = SecretStoreStatus {
            state: SecretStoreStateName::Ready,
            integrations: Vec::new(),
            plaintext_count: 0,
            unreadable: Vec::new(),
        };
        let integration = SecretStoreIntegration {
            project: String::new(),
            service: String::new(),
        };
        assert_eq!(
            rust_fields(&status),
            ts_interface_fields(ts, "SecretStoreStatus")
        );
        assert_eq!(
            rust_fields(&integration),
            ts_interface_fields(ts, "SecretStoreIntegration")
        );
        assert_eq!(
            serde_names(&[
                SecretStoreStateName::Ready,
                SecretStoreStateName::KeyMissing,
                SecretStoreStateName::PlaintextInStore,
                SecretStoreStateName::KeyUnreadable,
            ]),
            ts_union_members(ts, "SecretStoreState")
        );
    }
}
