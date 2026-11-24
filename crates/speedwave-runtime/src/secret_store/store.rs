use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use speedwave_crypto::Key;
use zeroize::Zeroizing;

use super::error::{io_failure, operation_failure, SecretStoreError};
use super::format;
use super::key_source::{FileKeySource, KeySource};
use super::layout::{self, LOCK_SUFFIX};
use super::name::{SecretName, ENCRYPTED_SUFFIX};

const SECRETS_DIR: &str = "secrets";
const KEY_FILE: &str = "secret-store.key";

/// Encrypted secret files of every project, sealed under one install key.
pub struct SecretStore {
    secrets_dir: PathBuf,
    source: Box<dyn KeySource>,
    key: Mutex<Option<Key>>,
}

/// Every secret of one project: readable values and names of files that cannot be read.
#[derive(Default)]
pub struct ProjectSecrets {
    /// Secrets that decrypted, sorted by name.
    pub values: Vec<(SecretName, Zeroizing<String>)>,
    /// Secrets whose file is corrupt, tampered with or sealed under another key.
    pub unreadable: Vec<SecretName>,
}

impl fmt::Debug for ProjectSecrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names: Vec<&SecretName> = self.values.iter().map(|(name, _)| name).collect();
        f.debug_struct("ProjectSecrets")
            .field("values", &names)
            .field("value_count", &self.values.len())
            .field("unreadable", &self.unreadable)
            .field("unreadable_count", &self.unreadable.len())
            .finish()
    }
}

impl SecretStore {
    /// Opens the store of `data_dir` with the install key file; never creates the key.
    pub fn open(data_dir: &Path) -> Result<Self, SecretStoreError> {
        Self::open_with(
            data_dir,
            Box::new(FileKeySource::new(data_dir.join(KEY_FILE))),
        )
    }

    /// Opens the store of `data_dir` with a custom key source; fails closed when the key is
    /// missing but encrypted secrets exist.
    pub fn open_with(
        data_dir: &Path,
        source: Box<dyn KeySource>,
    ) -> Result<Self, SecretStoreError> {
        let secrets_dir = data_dir.join(SECRETS_DIR);
        let mut key = source.load()?;
        if key.is_none() && layout::contains_encrypted(&secrets_dir)? {
            key = Some(source.load()?.ok_or(SecretStoreError::KeyMissing)?);
        }
        Ok(Self {
            secrets_dir,
            source,
            key: Mutex::new(key),
        })
    }

    /// Creates the install key when there is none and no encrypted secret exists yet.
    pub fn ensure_key(&self) -> Result<(), SecretStoreError> {
        let mut guard = self.lock_key();
        self.key_or_create(&mut guard).map(|_| ())
    }

    /// Derives a stable token from the install key (HKDF), creating the key on first use.
    pub fn derive_token(
        &self,
        purpose: &str,
        project: &str,
        service: &str,
    ) -> Result<Zeroizing<String>, SecretStoreError> {
        let mut guard = self.lock_key();
        let key = self.key_or_create(&mut guard)?;
        speedwave_crypto::derive_token(key, purpose, project, service)
            .map(Zeroizing::new)
            .map_err(|_| operation_failure("derive token"))
    }

    /// Decrypts one secret; `Ok(None)` when it was never written.
    pub fn read(&self, name: &SecretName) -> Result<Option<Zeroizing<String>>, SecretStoreError> {
        let line = match std::fs::read_to_string(self.path_of(name)) {
            Ok(line) => line,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                return Err(SecretStoreError::Unreadable(name.clone()))
            }
            Err(e) => return Err(io_failure("read secret", &e)),
        };
        let mut guard = self.lock_key();
        let key = self.key_if_present(&mut guard)?;
        format::open_line(key, name, &line)
            .map(Some)
            .ok_or_else(|| SecretStoreError::Unreadable(name.clone()))
    }

    /// Seals and atomically writes one secret, creating the install key on the very first write.
    pub fn write(&self, name: &SecretName, value: &str) -> Result<(), SecretStoreError> {
        let line = {
            let mut guard = self.lock_key();
            let key = self.key_or_create(&mut guard)?;
            format::seal_line(key, name, value)?
        };
        let dir = self.prepare_project_dir(name.project())?;
        crate::fs_perms::write_restricted_file_atomic(&dir.join(name.file_name()), &line)
            .map_err(|_| operation_failure("write secret"))
    }

    /// Removes one secret file; a missing file is success.
    pub fn delete(&self, name: &SecretName) -> Result<(), SecretStoreError> {
        match std::fs::remove_file(self.path_of(name)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_failure("delete secret", &e)),
        }
    }

    /// Whether the secret file exists; nothing is decrypted.
    pub fn exists(&self, name: &SecretName) -> bool {
        self.path_of(name).is_file()
    }

    /// Reads every secret of a project; a bad file lands in `unreadable` and never fails the call.
    pub fn read_project(&self, project: &str) -> Result<ProjectSecrets, SecretStoreError> {
        let mut secrets = ProjectSecrets::default();
        if crate::validation::validate_project_name(project).is_err() {
            return Ok(secrets);
        }
        for file_name in self.enc_file_names(project)? {
            let Some(name) = SecretName::from_file_name(project, &file_name) else {
                continue;
            };
            match self.read(&name) {
                Ok(Some(value)) => secrets.values.push((name, value)),
                Ok(None) => {}
                Err(SecretStoreError::Io(_) | SecretStoreError::Unreadable(_)) => {
                    secrets.unreadable.push(name)
                }
                Err(e) => return Err(e),
            }
        }
        secrets.values.sort_by(|a, b| a.0.cmp(&b.0));
        secrets.unreadable.sort();
        Ok(secrets)
    }

    /// Path of the lock file that guards one secret; creates the project directory owner-only.
    pub fn lock_path(&self, name: &SecretName) -> PathBuf {
        let dir = self
            .prepare_project_dir(name.project())
            .unwrap_or_else(|_| self.secrets_dir.join(name.project()));
        dir.join(format!("{}{LOCK_SUFFIX}", name.file_name()))
    }

    /// Fails with a count when the store holds anything but encrypted secrets, locks and temp files.
    pub fn verify_layout(&self) -> Result<(), SecretStoreError> {
        match layout::count_unexpected(&self.secrets_dir)? {
            0 => Ok(()),
            count => Err(SecretStoreError::PlaintextInStore { count }),
        }
    }

    fn lock_key(&self) -> MutexGuard<'_, Option<Key>> {
        self.key.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn key_if_present<'a>(&self, slot: &'a mut Option<Key>) -> Result<&'a Key, SecretStoreError> {
        if slot.is_none() {
            *slot = self.source.load()?;
        }
        slot.as_ref().ok_or(SecretStoreError::KeyMissing)
    }

    fn key_or_create<'a>(&self, slot: &'a mut Option<Key>) -> Result<&'a Key, SecretStoreError> {
        if slot.is_none() {
            *slot = Some(self.load_or_create_key()?);
        }
        slot.as_ref().ok_or(SecretStoreError::KeyMissing)
    }

    fn load_or_create_key(&self) -> Result<Key, SecretStoreError> {
        if let Some(key) = self.source.load()? {
            return Ok(key);
        }
        if layout::contains_encrypted(&self.secrets_dir)? {
            return self.source.load()?.ok_or(SecretStoreError::KeyMissing);
        }
        self.source.create()
    }

    fn path_of(&self, name: &SecretName) -> PathBuf {
        self.secrets_dir.join(name.project()).join(name.file_name())
    }

    fn prepare_project_dir(&self, project: &str) -> Result<PathBuf, SecretStoreError> {
        let dir = self.secrets_dir.join(project);
        crate::fs_perms::ensure_owner_only_dir(&self.secrets_dir)
            .map_err(|_| operation_failure("prepare secrets directory"))?;
        crate::fs_perms::ensure_owner_only_dir(&dir)
            .map_err(|_| operation_failure("prepare project directory"))?;
        Ok(dir)
    }

    fn enc_file_names(&self, project: &str) -> Result<Vec<String>, SecretStoreError> {
        let read = match std::fs::read_dir(self.secrets_dir.join(project)) {
            Ok(read) => read,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(io_failure("list secrets", &e)),
        };
        let mut names = Vec::new();
        for entry in read {
            let entry = entry.map_err(|e| io_failure("list secrets", &e))?;
            if let Some(name) = entry.file_name().to_str() {
                if name.ends_with(ENCRYPTED_SUFFIX) {
                    names.push(name.to_owned());
                }
            }
        }
        Ok(names)
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    const SENTINEL: &str = "SENTINEL-997-store-value";

    fn name(service: &str, field: &str) -> SecretName {
        SecretName::integration("demo", service, field).unwrap()
    }

    fn enc_path(root: &Path, name: &SecretName) -> PathBuf {
        root.join("secrets")
            .join(name.project())
            .join(name.file_name())
    }

    fn key_path(root: &Path) -> PathBuf {
        root.join("secret-store.key")
    }

    fn seed_key(root: &Path) {
        FileKeySource::new(key_path(root)).create().unwrap();
    }

    #[test]
    fn roundtrip_returns_unicode_and_empty_values() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let unicode = name("slack", "token");
        let empty = name("slack", "empty");

        store
            .write(&unicode, "zażółć gęślą jaźń \u{1F512}")
            .unwrap();
        store.write(&empty, "").unwrap();

        assert_eq!(
            store.read(&unicode).unwrap().unwrap().as_str(),
            "zażółć gęślą jaźń \u{1F512}"
        );
        assert_eq!(store.read(&empty).unwrap().unwrap().as_str(), "");
    }

    #[test]
    fn the_file_on_disk_is_a_versioned_line_without_the_value() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let secret = name("slack", "token");
        store.write(&secret, SENTINEL).unwrap();

        let content = std::fs::read_to_string(enc_path(tmp.path(), &secret)).unwrap();
        assert!(content.starts_with("speedwave-secret:v1:"));
        assert!(!content.contains(SENTINEL));
        assert!(!content.trim_start().starts_with('{'));
        assert_eq!(content.trim_end().lines().count(), 1);
    }

    #[test]
    fn two_writes_of_the_same_value_produce_different_files() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let secret = name("slack", "token");

        store.write(&secret, "same").unwrap();
        let first = std::fs::read_to_string(enc_path(tmp.path(), &secret)).unwrap();
        store.write(&secret, "same").unwrap();
        let second = std::fs::read_to_string(enc_path(tmp.path(), &secret)).unwrap();

        assert_ne!(first, second);
        assert_eq!(store.read(&secret).unwrap().unwrap().as_str(), "same");
    }

    #[test]
    fn overwriting_replaces_the_value() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let secret = name("slack", "token");
        store.write(&secret, "old").unwrap();
        store.write(&secret, "new").unwrap();
        assert_eq!(store.read(&secret).unwrap().unwrap().as_str(), "new");
    }

    #[test]
    fn a_file_copied_to_another_name_is_unreadable() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let source = name("slack", "token");
        let target = name("github", "token");
        store.write(&source, "v").unwrap();
        std::fs::copy(enc_path(tmp.path(), &source), enc_path(tmp.path(), &target)).unwrap();

        assert!(matches!(
            store.read(&target),
            Err(SecretStoreError::Unreadable(n)) if n == target
        ));
        assert_eq!(store.read(&source).unwrap().unwrap().as_str(), "v");
    }

    #[test]
    fn a_file_copied_to_another_project_is_unreadable() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let source = name("slack", "token");
        let target = SecretName::integration("other", "slack", "token").unwrap();
        store.write(&source, "v").unwrap();
        std::fs::create_dir_all(enc_path(tmp.path(), &target).parent().unwrap()).unwrap();
        std::fs::copy(enc_path(tmp.path(), &source), enc_path(tmp.path(), &target)).unwrap();

        assert!(matches!(
            store.read(&target),
            Err(SecretStoreError::Unreadable(_))
        ));
    }

    #[test]
    fn a_secret_sealed_under_another_key_is_unreadable_and_others_still_read() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let good = name("slack", "token");
        let foreign = name("github", "token");
        store.write(&good, "good").unwrap();

        let other_key = Key::from_bytes([9u8; 32]);
        let line = format::seal_line(&other_key, &foreign, "foreign").unwrap();
        std::fs::write(enc_path(tmp.path(), &foreign), line).unwrap();

        assert!(matches!(
            store.read(&foreign),
            Err(SecretStoreError::Unreadable(_))
        ));
        let project = store.read_project("demo").unwrap();
        assert_eq!(project.values.len(), 1);
        assert_eq!(project.values[0].0, good);
        assert_eq!(project.values[0].1.as_str(), "good");
        assert_eq!(project.unreadable, vec![foreign]);
    }

    #[test]
    fn truncated_garbage_and_non_base64_files_are_unreadable() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let secret = name("slack", "token");
        store.write(&secret, "value").unwrap();
        let path = enc_path(tmp.path(), &secret);
        let valid = std::fs::read_to_string(&path).unwrap();
        let id = valid.split(':').nth(2).unwrap().to_owned();

        let cases = [
            valid[..valid.len() - 6].to_owned(),
            "garbage".to_owned(),
            String::new(),
            format!("speedwave-secret:v1:{id}:***not-base64***"),
            format!("speedwave-secret:v1:{id}:AAAA"),
            "{\"token\":\"x\"}".to_owned(),
        ];
        for case in cases {
            std::fs::write(&path, &case).unwrap();
            assert!(
                matches!(store.read(&secret), Err(SecretStoreError::Unreadable(_))),
                "{case:?}"
            );
        }
        std::fs::write(&path, [0xffu8, 0xfe, 0x00]).unwrap();
        assert!(matches!(
            store.read(&secret),
            Err(SecretStoreError::Unreadable(_))
        ));
    }

    #[test]
    fn reading_an_unwritten_secret_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        seed_key(tmp.path());
        let store = SecretStore::open(tmp.path()).unwrap();
        assert!(store.read(&name("slack", "token")).unwrap().is_none());
    }

    #[test]
    fn open_without_a_key_but_with_enc_files_is_key_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let secret = name("slack", "token");
        store.write(&secret, "v").unwrap();
        std::fs::remove_file(key_path(tmp.path())).unwrap();

        assert!(matches!(
            SecretStore::open(tmp.path()),
            Err(SecretStoreError::KeyMissing)
        ));
        assert!(!key_path(tmp.path()).exists());
    }

    #[test]
    fn a_store_without_a_cached_key_fails_closed_when_the_key_file_vanished() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let secret = name("slack", "token");
        store.write(&secret, "v").unwrap();
        let late = SecretStore::open(tmp.path()).unwrap();
        std::fs::remove_file(key_path(tmp.path())).unwrap();
        let fresh = SecretStore {
            secrets_dir: tmp.path().join("secrets"),
            source: Box::new(FileKeySource::new(key_path(tmp.path()))),
            key: Mutex::new(None),
        };

        assert!(matches!(
            fresh.write(&name("slack", "other"), "x"),
            Err(SecretStoreError::KeyMissing)
        ));
        assert!(matches!(
            fresh.read(&secret),
            Err(SecretStoreError::KeyMissing)
        ));
        assert!(!key_path(tmp.path()).exists());
        assert_eq!(late.read(&secret).unwrap().unwrap().as_str(), "v");
    }

    #[test]
    fn without_a_key_and_without_enc_files_reads_are_none_and_create_no_key() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();

        assert!(store.read(&name("slack", "token")).unwrap().is_none());
        assert!(store.read_project("demo").unwrap().values.is_empty());
        assert!(!store.exists(&name("slack", "token")));

        assert!(!key_path(tmp.path()).exists());
    }

    #[test]
    fn the_first_write_creates_the_key_and_another_instance_shares_it() {
        let tmp = tempfile::tempdir().unwrap();
        let desktop = SecretStore::open(tmp.path()).unwrap();
        let cli = SecretStore::open(tmp.path()).unwrap();
        let secret = name("slack", "token");

        desktop.write(&secret, "from-desktop").unwrap();

        assert!(key_path(tmp.path()).is_file());
        assert_eq!(cli.read(&secret).unwrap().unwrap().as_str(), "from-desktop");
        cli.write(&name("github", "token"), "from-cli").unwrap();
        let reopened = SecretStore::open(tmp.path()).unwrap();
        assert_eq!(reopened.read_project("demo").unwrap().values.len(), 2);
        assert_eq!(
            std::fs::read_to_string(key_path(tmp.path())).unwrap().len(),
            64
        );
    }

    #[test]
    fn ensure_key_creates_the_key_once_and_keeps_it() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        store.ensure_key().unwrap();
        let first = std::fs::read(key_path(tmp.path())).unwrap();
        store.ensure_key().unwrap();
        SecretStore::open(tmp.path()).unwrap().ensure_key().unwrap();
        assert_eq!(std::fs::read(key_path(tmp.path())).unwrap(), first);
    }

    #[test]
    fn concurrent_first_writes_create_one_key_and_keep_every_value_readable() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let root = root.clone();
                std::thread::spawn(move || {
                    let store = SecretStore::open(&root).unwrap();
                    store
                        .write(&name("slack", &format!("token-{i}")), &format!("value-{i}"))
                        .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let store = SecretStore::open(&root).unwrap();
        for i in 0..8 {
            let value = store
                .read(&name("slack", &format!("token-{i}")))
                .unwrap()
                .unwrap();
            assert_eq!(value.as_str(), format!("value-{i}"));
        }
        let project = store.read_project("demo").unwrap();
        assert_eq!(project.values.len(), 8);
        assert!(project.unreadable.is_empty());
        let key_files = std::fs::read_dir(&root)
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains("key")
            })
            .count();
        assert_eq!(key_files, 1);
    }

    #[test]
    fn a_malformed_key_file_is_key_unreadable_and_stays_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(key_path(tmp.path()), "not-a-key").unwrap();

        assert!(matches!(
            SecretStore::open(tmp.path()),
            Err(SecretStoreError::KeyUnreadable)
        ));
        let source = FileKeySource::new(key_path(tmp.path()));
        let store = SecretStore {
            secrets_dir: tmp.path().join("secrets"),
            source: Box::new(source),
            key: Mutex::new(None),
        };
        assert!(matches!(
            store.write(&name("slack", "token"), "v"),
            Err(SecretStoreError::KeyUnreadable)
        ));
        assert!(matches!(
            store.ensure_key(),
            Err(SecretStoreError::KeyUnreadable)
        ));
        assert_eq!(
            std::fs::read_to_string(key_path(tmp.path())).unwrap(),
            "not-a-key"
        );
        assert!(!tmp.path().join("secrets").exists());
    }

    #[test]
    fn delete_is_idempotent_and_exists_tracks_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let secret = name("slack", "token");

        store.delete(&secret).unwrap();
        assert!(!store.exists(&secret));

        store.write(&secret, "v").unwrap();
        assert!(store.exists(&secret));

        store.delete(&secret).unwrap();
        store.delete(&secret).unwrap();
        assert!(!store.exists(&secret));
        assert!(store.read(&secret).unwrap().is_none());
    }

    #[test]
    fn exists_does_not_decrypt() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let secret = name("slack", "token");
        store.write(&secret, "v").unwrap();
        std::fs::write(enc_path(tmp.path(), &secret), "garbage").unwrap();
        assert!(store.exists(&secret));
    }

    #[test]
    fn read_project_sorts_values_and_ignores_other_files_and_projects() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        store.write(&name("slack", "token"), "1").unwrap();
        store.write(&name("github", "token"), "2").unwrap();
        store
            .write(
                &SecretName::integration("other", "slack", "token").unwrap(),
                "3",
            )
            .unwrap();
        let dir = tmp.path().join("secrets").join("demo");
        std::fs::write(dir.join("slack.token.enc.lock"), "").unwrap();
        std::fs::write(dir.join("Weird.Name.enc"), "x").unwrap();

        let project = store.read_project("demo").unwrap();

        let names: Vec<String> = project.values.iter().map(|(n, _)| n.to_string()).collect();
        assert_eq!(names, vec!["demo/github.token", "demo/slack.token"]);
        assert!(project.unreadable.is_empty());
    }

    #[test]
    fn read_project_of_an_unknown_or_invalid_project_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        store.write(&name("slack", "token"), "v").unwrap();
        for project in ["nothing", "../demo", ""] {
            let secrets = store.read_project(project).unwrap();
            assert!(secrets.values.is_empty());
            assert!(secrets.unreadable.is_empty());
        }
    }

    #[test]
    fn lock_path_sits_next_to_the_enc_file_and_creates_the_project_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let secret = name("slack", "token");

        let lock = store.lock_path(&secret);

        assert_eq!(
            lock,
            tmp.path()
                .join("secrets")
                .join("demo")
                .join("slack.token.enc.lock")
        );
        assert!(lock.parent().unwrap().is_dir());
        crate::fs_perms::with_file_lock_in(&lock, || Ok(())).unwrap();
        store.write(&secret, "v").unwrap();
        store.verify_layout().unwrap();
    }

    #[test]
    fn verify_layout_accepts_a_clean_store_and_a_missing_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        store.verify_layout().unwrap();
        store.write(&name("slack", "token"), "v").unwrap();
        let dir = tmp.path().join("secrets").join("demo");
        std::fs::write(dir.join("slack.token.enc.lock"), "").unwrap();
        std::fs::write(dir.join(".slack.token.enc.tmp.1.2"), "x").unwrap();
        store.verify_layout().unwrap();
    }

    #[test]
    fn verify_layout_reports_a_count_for_plaintext_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        store.write(&name("slack", "token"), "v").unwrap();
        let dir = tmp.path().join("secrets").join("demo");

        std::fs::write(dir.join("slack.token"), SENTINEL).unwrap();
        assert!(matches!(
            store.verify_layout(),
            Err(SecretStoreError::PlaintextInStore { count: 1 })
        ));
        std::fs::remove_file(dir.join("slack.token")).unwrap();

        std::fs::write(dir.join("x.enc.lock"), "locked").unwrap();
        assert!(matches!(
            store.verify_layout(),
            Err(SecretStoreError::PlaintextInStore { count: 1 })
        ));
        std::fs::remove_file(dir.join("x.enc.lock")).unwrap();

        std::fs::write(tmp.path().join("secrets").join("loose.txt"), SENTINEL).unwrap();
        let err = store.verify_layout().err().unwrap();
        assert!(matches!(
            err,
            SecretStoreError::PlaintextInStore { count: 1 }
        ));
        assert!(!format!("{err} {err:?}").contains(SENTINEL));
    }

    #[test]
    fn project_secrets_debug_prints_names_and_counts_only() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        store.write(&name("slack", "token"), SENTINEL).unwrap();
        let project = store.read_project("demo").unwrap();

        let text = format!("{project:?}");

        assert!(!text.contains(SENTINEL));
        assert!(text.contains("demo/slack.token"));
        assert!(text.contains("value_count: 1"));
    }

    #[test]
    fn store_errors_never_contain_the_value_or_the_data_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let secret = name("slack", "token");
        store.write(&secret, SENTINEL).unwrap();
        std::fs::write(enc_path(tmp.path(), &secret), "garbage").unwrap();

        let err = store.read(&secret).err().unwrap();
        let text = format!("{err} {err:?}");
        assert!(!text.contains(SENTINEL));
        assert!(!text.contains(tmp.path().to_str().unwrap()));
    }

    #[test]
    fn a_directory_where_the_enc_file_should_be_is_an_io_error_for_read() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let secret = name("slack", "token");
        store.write(&name("github", "token"), "v").unwrap();
        std::fs::create_dir(enc_path(tmp.path(), &secret)).unwrap();

        assert!(matches!(store.read(&secret), Err(SecretStoreError::Io(_))));
        let project = store.read_project("demo").unwrap();
        assert_eq!(project.unreadable, vec![secret]);
        assert_eq!(project.values.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn written_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        let secret = name("slack", "token");
        store.write(&secret, "v").unwrap();

        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&enc_path(tmp.path(), &secret)), 0o600);
        assert_eq!(mode(&tmp.path().join("secrets").join("demo")), 0o700);
        assert_eq!(mode(&tmp.path().join("secrets")), 0o700);
        assert_eq!(mode(&key_path(tmp.path())), 0o600);
    }
    #[test]
    fn derived_tokens_are_stable_per_install_and_differ_per_scope() {
        let tmp = tempfile::tempdir().unwrap();
        let first = SecretStore::open(tmp.path()).unwrap();
        let token = first.derive_token("bearer", "demo", "slack").unwrap();
        let second = SecretStore::open(tmp.path()).unwrap();

        assert_eq!(
            second.derive_token("bearer", "demo", "slack").unwrap(),
            token
        );
        assert_ne!(
            second.derive_token("bearer", "demo", "github").unwrap(),
            token
        );
        assert_eq!(token.len(), 64);
        assert!(key_path(tmp.path()).is_file());
    }

    #[test]
    fn a_derived_token_needs_the_key_when_secrets_exist_without_it() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::open(tmp.path()).unwrap();
        store.write(&name("slack", "token"), "v").unwrap();
        std::fs::remove_file(key_path(tmp.path())).unwrap();

        let reopened = SecretStore::open_with(
            tmp.path(),
            Box::new(FileKeySource::new(key_path(tmp.path()))),
        );

        assert!(matches!(reopened, Err(SecretStoreError::KeyMissing)));
    }
}
