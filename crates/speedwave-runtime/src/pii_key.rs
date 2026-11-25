//! Per-project PII tokenization key: a persistent 32-byte AES-SIV key generated once on
//! first use, stored hex-encoded in the secret store (`SecretName::pii_key`).

use std::path::{Path, PathBuf};

use rand::TryRng;

use crate::secret_store::{SecretName, SecretStore, SecretStoreError};

const LEGACY_KEY_FILE: &str = "key";

/// Creates the key in the secret store when absent or unreadable.
pub fn ensure_project_key_in(data_dir: &Path, project: &str) -> anyhow::Result<()> {
    let name = SecretName::pii_key(project)?;
    let store = SecretStore::open(data_dir)?;
    if has_readable_key(&store, &name)? {
        return Ok(());
    }
    crate::fs_perms::with_file_lock_in(&store.lock_path(&name), || {
        if has_readable_key(&store, &name)? {
            return Ok(());
        }
        if legacy_key_file_in(data_dir, project).exists() {
            anyhow::bail!("PII key migration pending for project '{project}'");
        }
        if store.exists(&name) {
            log::warn!("the PII key of project '{project}' cannot be read, a new key replaces it");
        }
        store.write(&name, &generate_key_hex()?)?;
        Ok(())
    })
}

fn has_readable_key(store: &SecretStore, name: &SecretName) -> anyhow::Result<bool> {
    if !store.exists(name) {
        return Ok(false);
    }
    match store.read(name) {
        Ok(value) => Ok(value.is_some()),
        Err(SecretStoreError::Unreadable(_)) => Ok(false),
        Err(e) => Err(e.into()),
    }
}

fn legacy_key_file_in(data_dir: &Path, project: &str) -> PathBuf {
    crate::pii_policy::policy_config_dir_in(data_dir, project).join(LEGACY_KEY_FILE)
}

fn generate_key_hex() -> anyhow::Result<String> {
    let mut bytes = [0u8; 32];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .map_err(|e| anyhow::anyhow!("failed to read OS entropy for the PII key: {e}"))?;
    Ok(crate::bundle::bytes_to_hex(&bytes))
}

/// Reads and decodes the key; `Err` when absent, unreadable, or malformed
/// (fail-closed; the error never carries the stored content).
pub fn read_project_key_in(data_dir: &Path, project: &str) -> anyhow::Result<[u8; 32]> {
    let name = SecretName::pii_key(project)?;
    let value = SecretStore::open(data_dir)?
        .read(&name)?
        .ok_or_else(|| anyhow::anyhow!("PII tokenization key of project '{project}' is missing"))?;
    decode_hex_key(value.trim()).map_err(|e| {
        anyhow::anyhow!("PII tokenization key of project '{project}' is malformed: {e}")
    })
}

/// Decodes exactly 32 bytes from a lowercase-or-uppercase hex string; never
/// echoes the input in an error (only its length).
fn decode_hex_key(hex: &str) -> Result<[u8; 32], String> {
    if hex.len() != 64 {
        return Err(format!("expected 64 hex characters, found {}", hex.len()));
    }
    let mut bytes = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let pair = std::str::from_utf8(chunk).map_err(|_| "not valid UTF-8".to_string())?;
        bytes[i] =
            u8::from_str_radix(pair, 16).map_err(|_| "contains a non-hex character".to_string())?;
    }
    Ok(bytes)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    fn store_entry(root: &Path, project: &str) -> Option<String> {
        let name = SecretName::pii_key(project).unwrap();
        SecretStore::open(root)
            .unwrap()
            .read(&name)
            .unwrap()
            .map(|value| value.to_string())
    }

    fn legacy_key_file(root: &Path, project: &str) -> PathBuf {
        crate::pii_policy::policy_config_dir_in(root, project).join(LEGACY_KEY_FILE)
    }

    #[test]
    fn ensure_creates_64_lowercase_hex_chars_in_the_store_and_no_plaintext_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        ensure_project_key_in(tmp.path(), "proj").unwrap();

        let content = store_entry(tmp.path(), "proj").unwrap();
        assert_eq!(content.len(), 64, "no trailing newline");
        assert!(content
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert!(!legacy_key_file(tmp.path(), "proj").exists());
        assert!(tmp.path().join("secrets/proj/pii.key.enc").is_file());
    }

    #[test]
    fn ensure_is_idempotent_and_never_overwrites_an_existing_key() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_project_key_in(tmp.path(), "proj").unwrap();
        let first = store_entry(tmp.path(), "proj");

        ensure_project_key_in(tmp.path(), "proj").unwrap();

        assert_eq!(first, store_entry(tmp.path(), "proj"));
    }

    #[test]
    fn ensure_keeps_a_stored_key_even_when_a_legacy_file_lingers() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_project_key_in(tmp.path(), "proj").unwrap();
        let stored = store_entry(tmp.path(), "proj");
        let legacy = legacy_key_file(tmp.path(), "proj");
        crate::fs_perms::ensure_owner_only_dir(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, "f".repeat(64)).unwrap();

        ensure_project_key_in(tmp.path(), "proj").unwrap();

        assert_eq!(stored, store_entry(tmp.path(), "proj"));
    }

    #[test]
    fn ensure_refuses_to_mint_a_key_while_a_legacy_plaintext_key_awaits_migration() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = legacy_key_file(tmp.path(), "proj");
        crate::fs_perms::ensure_owner_only_dir(legacy.parent().unwrap()).unwrap();
        let legacy_content = "ab".repeat(32);
        std::fs::write(&legacy, &legacy_content).unwrap();

        let err = ensure_project_key_in(tmp.path(), "proj")
            .unwrap_err()
            .to_string();

        assert!(err.contains("migration pending"), "got: {err}");
        assert!(!err.contains(&legacy_content));
        assert_eq!(store_entry(tmp.path(), "proj"), None);
        assert_eq!(std::fs::read_to_string(&legacy).unwrap(), legacy_content);
    }

    #[test]
    fn ensure_fails_without_creating_a_key_when_the_install_key_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_project_key_in(tmp.path(), "first").unwrap();
        std::fs::remove_file(tmp.path().join("secret-store.key")).unwrap();

        assert!(ensure_project_key_in(tmp.path(), "second").is_err());
        assert!(!tmp.path().join("secret-store.key").exists());
        assert!(!tmp.path().join("secrets/second/pii.key.enc").exists());
    }

    #[test]
    fn concurrent_ensures_end_with_one_key() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let root = root.clone();
                std::thread::spawn(move || {
                    ensure_project_key_in(&root, "proj").unwrap();
                    read_project_key_in(&root, "proj").unwrap()
                })
            })
            .collect();
        let keys: Vec<[u8; 32]> = handles.into_iter().map(|h| h.join().unwrap()).collect();

        assert!(keys.windows(2).all(|pair| pair[0] == pair[1]));
        assert_eq!(
            crate::bundle::bytes_to_hex(&keys[0]),
            store_entry(tmp.path(), "proj").unwrap()
        );
    }

    #[test]
    fn read_after_ensure_decodes_to_the_same_32_bytes_as_the_store_value() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_project_key_in(tmp.path(), "proj").unwrap();

        let key = read_project_key_in(tmp.path(), "proj").unwrap();
        assert_eq!(
            crate::bundle::bytes_to_hex(&key),
            store_entry(tmp.path(), "proj").unwrap()
        );
    }

    #[test]
    fn read_errs_when_the_key_is_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let err = read_project_key_in(tmp.path(), "proj")
            .unwrap_err()
            .to_string();
        assert!(!err.is_empty());
    }

    #[test]
    fn read_errs_on_a_short_key_without_leaking_content() {
        let tmp = tempfile::tempdir().unwrap();
        let name = SecretName::pii_key("proj").unwrap();
        SecretStore::open(tmp.path())
            .unwrap()
            .write(&name, &"a".repeat(63))
            .unwrap();

        let err = read_project_key_in(tmp.path(), "proj")
            .unwrap_err()
            .to_string();
        assert!(!err.contains(&"a".repeat(63)));
        assert!(err.contains("63"));
    }

    #[test]
    fn read_errs_on_non_hex_content_without_leaking_it() {
        let tmp = tempfile::tempdir().unwrap();
        let name = SecretName::pii_key("proj").unwrap();
        let bogus = "z".repeat(64);
        SecretStore::open(tmp.path())
            .unwrap()
            .write(&name, &bogus)
            .unwrap();

        let err = read_project_key_in(tmp.path(), "proj")
            .unwrap_err()
            .to_string();
        assert!(!err.contains(&bogus));
    }

    #[test]
    fn read_errs_on_a_corrupt_store_entry() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_project_key_in(tmp.path(), "proj").unwrap();
        std::fs::write(tmp.path().join("secrets/proj/pii.key.enc"), "garbage\n").unwrap();

        assert!(read_project_key_in(tmp.path(), "proj").is_err());
    }

    #[test]
    fn ensure_replaces_an_unreadable_key_with_a_new_readable_one() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_project_key_in(tmp.path(), "proj").unwrap();
        let path = tmp.path().join("secrets/proj/pii.key.enc");
        std::fs::write(&path, "garbage\n").unwrap();

        ensure_project_key_in(tmp.path(), "proj").unwrap();

        let key = read_project_key_in(tmp.path(), "proj").unwrap();
        assert_eq!(
            crate::bundle::bytes_to_hex(&key),
            store_entry(tmp.path(), "proj").unwrap()
        );
        assert!(!std::fs::read_to_string(&path).unwrap().contains("garbage"));
    }

    #[test]
    fn ensure_keeps_an_unreadable_key_while_a_legacy_plaintext_key_awaits_migration() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_project_key_in(tmp.path(), "proj").unwrap();
        let path = tmp.path().join("secrets/proj/pii.key.enc");
        std::fs::write(&path, "garbage\n").unwrap();
        let legacy = legacy_key_file(tmp.path(), "proj");
        crate::fs_perms::ensure_owner_only_dir(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, "ab".repeat(32)).unwrap();

        let err = ensure_project_key_in(tmp.path(), "proj")
            .unwrap_err()
            .to_string();

        assert!(err.contains("migration pending"), "got: {err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "garbage\n");
    }

    #[test]
    fn two_projects_get_two_different_keys() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_project_key_in(tmp.path(), "proj-a").unwrap();
        ensure_project_key_in(tmp.path(), "proj-b").unwrap();

        let a = read_project_key_in(tmp.path(), "proj-a").unwrap();
        let b = read_project_key_in(tmp.path(), "proj-b").unwrap();
        assert_ne!(a, b);
    }
}
