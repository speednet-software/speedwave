use std::path::Path;

use serde::Serialize;
use speedwave_migrations::MigrationReport;
use speedwave_runtime::config;
use speedwave_runtime::secret_store::{
    discard_secrets_without_key, encrypted_integrations, secret_store_state, undiscardable_count,
    unreadable_integration_messages, SecretStoreState,
};

const KEY_MISSING_STEP: &str = "Complete the secret store recovery dialog to continue.";

pub(crate) struct MigrationNotices(Vec<String>);

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SecretStoreStateName {
    Ready,
    KeyMissing,
    KeyUnreadable,
    StoreUnavailable,
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
    unreadable: Vec<String>,
    migration_notices: Vec<String>,
}

impl MigrationNotices {
    pub(crate) fn from_report(report: Option<&MigrationReport>) -> Self {
        let notices = report
            .map(|report| {
                report
                    .failures
                    .iter()
                    .map(|(name, reason)| {
                        format!("Startup migration {name} did not finish: {reason}")
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self(notices)
    }
}

pub(crate) fn log_startup_state(data_dir: &Path) {
    let state = secret_store_state(data_dir);
    if state != SecretStoreState::Ready {
        log::warn!("secret store is not ready: {}", log_label(&state));
    }
}

fn state_name(state: &SecretStoreState) -> SecretStoreStateName {
    match state {
        SecretStoreState::Ready => SecretStoreStateName::Ready,
        SecretStoreState::KeyMissing => SecretStoreStateName::KeyMissing,
        SecretStoreState::KeyUnreadable => SecretStoreStateName::KeyUnreadable,
        SecretStoreState::StoreUnavailable => SecretStoreStateName::StoreUnavailable,
    }
}

fn log_label(state: &SecretStoreState) -> String {
    match state {
        SecretStoreState::Ready => "ready".to_owned(),
        SecretStoreState::KeyMissing => "key missing".to_owned(),
        SecretStoreState::KeyUnreadable => "key unreadable".to_owned(),
        SecretStoreState::StoreUnavailable => "store unavailable".to_owned(),
    }
}

#[tauri::command]
pub(crate) fn get_secret_store_status(
    notices: tauri::State<'_, MigrationNotices>,
) -> SecretStoreStatus {
    let data_dir = speedwave_runtime::consts::data_dir();
    let state = secret_store_state(data_dir);
    status_of(data_dir, &state, active_project().as_deref(), &notices.0)
}

#[tauri::command]
pub(crate) fn reset_secret_store(
    notices: tauri::State<'_, MigrationNotices>,
    confirmed: bool,
) -> Result<SecretStoreStatus, String> {
    let data_dir = speedwave_runtime::consts::data_dir();
    reset_in(data_dir, confirmed, active_project().as_deref(), &notices.0)
}

pub(crate) fn ensure_ready_for_start() -> Result<(), String> {
    ensure_ready_in(speedwave_runtime::consts::data_dir())
}

fn ensure_ready_in(data_dir: &Path) -> Result<(), String> {
    match refusal_for(&secret_store_state(data_dir)) {
        Some(message) => Err(message),
        None => Ok(()),
    }
}

fn refusal_for(state: &SecretStoreState) -> Option<String> {
    state.refusal(KEY_MISSING_STEP)
}

fn reset_in(
    data_dir: &Path,
    confirmed: bool,
    active_project: Option<&str>,
    migration_notices: &[String],
) -> Result<SecretStoreStatus, String> {
    if !confirmed {
        return Err("Creating a new secret store key needs an explicit confirmation.".to_owned());
    }
    if secret_store_state(data_dir) != SecretStoreState::KeyMissing {
        return Err("The secret store does not need a new key.".to_owned());
    }
    let removed = discard_secrets_without_key(data_dir).map_err(|e| e.to_string())?;
    log::warn!("secret store reset: discarded {removed} encrypted files without a key");
    let state = secret_store_state(data_dir);
    if state == SecretStoreState::KeyMissing {
        let remaining = undiscardable_count(data_dir).map_err(|e| e.to_string())?;
        let entries = if remaining == 1 { "entry" } else { "entries" };
        return Err(format!(
            "{remaining} {entries} in the secrets directory could not be removed automatically. Remove them by hand and try again."
        ));
    }
    Ok(status_of(
        data_dir,
        &state,
        active_project,
        migration_notices,
    ))
}

fn status_of(
    data_dir: &Path,
    state: &SecretStoreState,
    active_project: Option<&str>,
    migration_notices: &[String],
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
    let unreadable = match (state, active_project) {
        (SecretStoreState::Ready, Some(project)) => {
            unreadable_integration_messages(data_dir, project)
        }
        _ => Vec::new(),
    };
    SecretStoreStatus {
        state: state_name(state),
        integrations,
        unreadable,
        migration_notices: migration_notices.to_vec(),
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
    use speedwave_runtime::secret_store::{SecretName, SecretStore};

    fn seed_enc(root: &Path, project: &str, file: &str) -> std::path::PathBuf {
        let dir = root.join("secrets").join(project);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(file);
        std::fs::write(&path, "x").unwrap();
        path
    }

    fn report_with(failures: Vec<(&'static str, String)>) -> MigrationReport {
        MigrationReport {
            executed: Vec::new(),
            failures,
        }
    }

    #[test]
    fn an_empty_data_dir_is_ready() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(secret_store_state(tmp.path()), SecretStoreState::Ready);
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
        assert_eq!(secret_store_state(tmp.path()), SecretStoreState::Ready);
    }

    #[test]
    fn ciphertext_without_a_key_is_key_missing() {
        let tmp = tempfile::tempdir().unwrap();
        seed_enc(tmp.path(), "demo", "slack.token.enc");
        assert_eq!(secret_store_state(tmp.path()), SecretStoreState::KeyMissing);
        assert_eq!(
            ensure_ready_in(tmp.path()).unwrap_err(),
            "The secret store key is missing. Complete the secret store recovery dialog to continue."
        );
    }

    #[test]
    fn a_malformed_key_file_is_key_unreadable() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("secret-store.key"), "garbage").unwrap();
        seed_enc(tmp.path(), "demo", "slack.token.enc");
        assert_eq!(
            secret_store_state(tmp.path()),
            SecretStoreState::KeyUnreadable
        );
        assert!(ensure_ready_in(tmp.path()).unwrap_err().contains("damaged"));
    }

    #[test]
    fn unknown_entries_beside_the_secrets_are_removed_at_the_check() {
        let tmp = tempfile::tempdir().unwrap();
        SecretStore::open(tmp.path()).unwrap().ensure_key().unwrap();
        let plain = seed_enc(tmp.path(), "demo", "slack.token");
        let notes = seed_enc(tmp.path(), "demo", "notes.txt");
        let secret = seed_enc(tmp.path(), "demo", "slack.token.enc");

        assert_eq!(secret_store_state(tmp.path()), SecretStoreState::Ready);

        assert!(ensure_ready_in(tmp.path()).is_ok());
        assert!(!plain.exists());
        assert!(!notes.exists());
        assert!(secret.exists());
    }

    #[test]
    fn status_of_key_missing_lists_the_integrations() {
        let tmp = tempfile::tempdir().unwrap();
        seed_enc(tmp.path(), "demo", "slack.token.enc");
        seed_enc(tmp.path(), "demo", "slack.refresh_token.enc");
        seed_enc(tmp.path(), "demo", "redmine.api_key.enc");

        let status = status_of(tmp.path(), &SecretStoreState::KeyMissing, Some("demo"), &[]);

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
        assert!(status.unreadable.is_empty());
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

        let active = status_of(tmp.path(), &SecretStoreState::Ready, Some("demo"), &[]);
        let other = status_of(tmp.path(), &SecretStoreState::Ready, Some("other"), &[]);
        let none = status_of(tmp.path(), &SecretStoreState::Ready, None, &[]);

        assert_eq!(active.state, SecretStoreStateName::Ready);
        assert_eq!(active.unreadable.len(), 1);
        assert!(active.unreadable[0].contains("redmine"));
        assert!(other.unreadable.is_empty());
        assert!(none.unreadable.is_empty());
    }

    #[test]
    fn status_of_carries_the_migration_notices_in_every_state() {
        let tmp = tempfile::tempdir().unwrap();
        let notices = vec!["Startup migration a did not finish: 1 problem(s).".to_owned()];

        for state in [
            SecretStoreState::Ready,
            SecretStoreState::KeyMissing,
            SecretStoreState::KeyUnreadable,
            SecretStoreState::StoreUnavailable,
        ] {
            let status = status_of(tmp.path(), &state, None, &notices);
            assert_eq!(status.migration_notices, notices);
        }
    }

    #[test]
    fn notices_hold_one_text_per_failed_migration_and_nothing_without_failures() {
        let report = report_with(vec![
            (
                "secrets_at_rest",
                "1 problem(s): project alpha: the PII key could not be migrated".to_owned(),
            ),
            ("legacy_files", "2 paths could not be removed".to_owned()),
        ]);

        assert_eq!(
            MigrationNotices::from_report(Some(&report)).0,
            vec![
                "Startup migration secrets_at_rest did not finish: 1 problem(s): project alpha: the PII key could not be migrated".to_owned(),
                "Startup migration legacy_files did not finish: 2 paths could not be removed".to_owned(),
            ]
        );
        assert!(
            MigrationNotices::from_report(Some(&report_with(Vec::new())))
                .0
                .is_empty()
        );
        assert!(MigrationNotices::from_report(None).0.is_empty());
    }

    #[test]
    fn a_malformed_key_without_secrets_is_key_unreadable_and_stays_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let key = tmp.path().join("secret-store.key");
        std::fs::write(&key, "").unwrap();

        assert_eq!(
            secret_store_state(tmp.path()),
            SecretStoreState::KeyUnreadable
        );
        assert!(ensure_ready_in(tmp.path()).unwrap_err().contains("damaged"));
        assert!(reset_in(tmp.path(), true, None, &[]).is_err());
        assert_eq!(std::fs::read_to_string(&key).unwrap(), "");
    }

    #[test]
    fn reset_refuses_without_confirmation_and_keeps_the_files() {
        let tmp = tempfile::tempdir().unwrap();
        let secret = seed_enc(tmp.path(), "demo", "slack.token.enc");

        assert!(reset_in(tmp.path(), false, None, &[]).is_err());
        assert!(secret.exists());
    }

    #[test]
    fn reset_discards_the_ciphertexts_and_returns_ready() {
        let tmp = tempfile::tempdir().unwrap();
        let secret = seed_enc(tmp.path(), "demo", "slack.token.enc");
        let notices = ["Startup migration x did not finish: y".to_owned()];

        let status = reset_in(tmp.path(), true, Some("demo"), &notices).unwrap();

        assert_eq!(status.state, SecretStoreStateName::Ready);
        assert_eq!(status.migration_notices, notices);
        assert!(!secret.exists());
        assert!(ensure_ready_in(tmp.path()).is_ok());
    }

    #[test]
    fn reset_reports_the_count_of_entries_it_cannot_remove() {
        let tmp = tempfile::tempdir().unwrap();
        let secret = seed_enc(tmp.path(), "demo", "slack.token.enc");
        std::fs::create_dir(tmp.path().join("secrets/demo/dir.enc")).unwrap();
        std::fs::write(tmp.path().join("secrets").join("loose.enc"), "x").unwrap();

        let err = reset_in(tmp.path(), true, None, &[]).unwrap_err();

        assert_eq!(
            err,
            "2 entries in the secrets directory could not be removed automatically. Remove them by hand and try again."
        );
        assert!(!secret.exists());
        assert!(!err.contains("dir.enc"));
    }

    #[cfg(unix)]
    #[test]
    fn reset_reports_a_symlinked_project_dir_it_cannot_remove() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("other.enc"), "keep").unwrap();
        std::fs::create_dir_all(tmp.path().join("secrets")).unwrap();
        std::os::unix::fs::symlink(outside.path(), tmp.path().join("secrets/linked")).unwrap();

        let err = reset_in(tmp.path(), true, None, &[]).unwrap_err();

        assert!(err.starts_with("1 entry in the secrets directory could not be removed"));
        assert!(outside.path().join("other.enc").exists());
    }

    #[test]
    fn a_stray_non_enc_file_does_not_block_the_reset() {
        let tmp = tempfile::tempdir().unwrap();
        seed_enc(tmp.path(), "demo", "slack.token.enc");
        std::fs::write(tmp.path().join("secrets").join(".DS_Store"), "x").unwrap();

        let status = reset_in(tmp.path(), true, None, &[]).unwrap();

        assert_eq!(status.state, SecretStoreStateName::Ready);
        assert!(!tmp.path().join("secrets/.DS_Store").exists());
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_secrets_dir_is_store_unavailable() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let secrets = tmp.path().join("secrets");
        std::fs::create_dir_all(&secrets).unwrap();
        std::fs::set_permissions(&secrets, std::fs::Permissions::from_mode(0o000)).unwrap();

        let state = secret_store_state(tmp.path());
        std::fs::set_permissions(&secrets, std::fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(state, SecretStoreState::StoreUnavailable);
    }

    #[test]
    fn store_unavailable_refuses_with_a_permissions_hint() {
        assert_eq!(
            refusal_for(&SecretStoreState::StoreUnavailable).as_deref(),
            Some("The secrets directory cannot be read. Check its permissions.")
        );
        assert_eq!(
            state_name(&SecretStoreState::StoreUnavailable),
            SecretStoreStateName::StoreUnavailable
        );
    }

    #[test]
    fn reset_refuses_outside_key_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let name = SecretName::integration("demo", "slack", "token").unwrap();
        store.write(&name, "v").unwrap();

        assert!(reset_in(tmp.path(), true, None, &[]).is_err());
        assert_eq!(store.read(&name).unwrap().unwrap().as_str(), "v");
    }

    #[test]
    fn reset_refuses_with_a_malformed_key_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("secret-store.key"), "garbage").unwrap();
        let secret = seed_enc(tmp.path(), "demo", "slack.token.enc");

        assert!(reset_in(tmp.path(), true, None, &[]).is_err());
        assert!(secret.exists());
    }

    #[test]
    fn status_matches_ts_mirror() {
        use crate::ts_mirror::{rust_fields, serde_names, ts_interface_fields, ts_union_members};
        let ts = include_str!("../../src/src/app/models/secret-store.ts");
        let status = SecretStoreStatus {
            state: SecretStoreStateName::Ready,
            integrations: Vec::new(),
            unreadable: Vec::new(),
            migration_notices: Vec::new(),
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
                SecretStoreStateName::KeyUnreadable,
                SecretStoreStateName::StoreUnavailable,
            ]),
            ts_union_members(ts, "SecretStoreState")
        );
    }
}
