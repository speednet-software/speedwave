use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rand::TryRng;
use speedwave_crypto::Key;
use zeroize::Zeroizing;

use super::error::{io_failure, operation_failure, SecretStoreError};

const KEY_LEN: usize = 32;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Where the install key lives; `create` must be race-safe and never replace an existing key.
pub trait KeySource: Send + Sync {
    /// Returns the key, or `None` when none was created yet; a malformed key is an error.
    fn load(&self) -> Result<Option<Key>, SecretStoreError>;

    /// Creates a fresh key; when another creator wins the race, returns the winner's key.
    fn create(&self) -> Result<Key, SecretStoreError>;
}

/// Key stored as 64 hex characters in an owner-only file.
pub struct FileKeySource {
    path: PathBuf,
}

impl FileKeySource {
    /// Key source backed by the file at `path`.
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn temp_path(&self) -> PathBuf {
        let file_name = self
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        self.path.with_file_name(format!(
            ".{file_name}.tmp.{}.{sequence}",
            std::process::id()
        ))
    }
}

impl KeySource for FileKeySource {
    fn load(&self) -> Result<Option<Key>, SecretStoreError> {
        let content = match std::fs::read(&self.path) {
            Ok(content) => Zeroizing::new(content),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io_failure("read key file", &e)),
        };
        let text = std::str::from_utf8(&content).map_err(|_| SecretStoreError::KeyUnreadable)?;
        Key::from_hex(text)
            .map(Some)
            .map_err(|_| SecretStoreError::KeyUnreadable)
    }

    fn create(&self) -> Result<Key, SecretStoreError> {
        let parent = self.path.parent();
        if let Some(parent) = parent {
            std::fs::create_dir_all(parent).map_err(|e| io_failure("create key directory", &e))?;
        }
        let mut bytes = Zeroizing::new([0u8; KEY_LEN]);
        rand::rngs::SysRng
            .try_fill_bytes(&mut *bytes)
            .map_err(|_| operation_failure("read OS entropy"))?;

        let temp = self.temp_path();
        let published =
            write_temp_key(&temp, &bytes).map(|()| std::fs::hard_link(&temp, &self.path));
        let _ = std::fs::remove_file(&temp);
        match published? {
            Ok(()) => {
                if let Some(parent) = parent {
                    crate::fs_perms::fsync_parent_dir(parent);
                }
                Ok(Key::from_bytes(*bytes))
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                self.load()?.ok_or(SecretStoreError::KeyUnreadable)
            }
            Err(e) => Err(io_failure("publish key file", &e)),
        }
    }
}

fn write_temp_key(temp: &Path, bytes: &[u8; KEY_LEN]) -> Result<(), SecretStoreError> {
    let _ = std::fs::remove_file(temp);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp)
        .map_err(|e| io_failure("create key file", &e))?;
    crate::fs_perms::set_owner_only(temp).map_err(|_| operation_failure("restrict key file"))?;
    let hex = Zeroizing::new(crate::bundle::bytes_to_hex(bytes));
    file.write_all(hex.as_bytes())
        .and_then(|()| file.flush())
        .map_err(|e| io_failure("write key file", &e))?;
    file.sync_all()
        .map_err(|e| io_failure("sync key file", &e))?;
    crate::fs_perms::fsync_file_durable(&file).map_err(|e| io_failure("sync key file", &e))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    fn source(dir: &Path) -> FileKeySource {
        FileKeySource::new(dir.join("secret-store.key"))
    }

    #[test]
    fn load_returns_none_when_the_file_is_absent() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(source(tmp.path()).load().unwrap().is_none());
    }

    #[test]
    fn create_writes_64_lowercase_hex_chars_and_load_returns_the_same_key() {
        let tmp = tempfile::tempdir().unwrap();
        let src = source(tmp.path());
        let created = src.create().unwrap();

        let content = std::fs::read_to_string(tmp.path().join("secret-store.key")).unwrap();
        assert_eq!(content.len(), 64);
        assert!(content
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert_eq!(src.load().unwrap().unwrap().id(), created.id());
        assert_eq!(Key::from_hex(&content).unwrap().id(), created.id());
    }

    #[test]
    fn create_makes_a_missing_parent_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let src = FileKeySource::new(tmp.path().join("nested").join("secret-store.key"));
        src.create().unwrap();
        assert!(src.load().unwrap().is_some());
    }

    #[test]
    fn create_never_replaces_an_existing_key() {
        let tmp = tempfile::tempdir().unwrap();
        let src = source(tmp.path());
        let first = src.create().unwrap();
        let before = std::fs::read(tmp.path().join("secret-store.key")).unwrap();

        let second = src.create().unwrap();

        assert_eq!(second.id(), first.id());
        assert_eq!(
            std::fs::read(tmp.path().join("secret-store.key")).unwrap(),
            before
        );
    }

    #[test]
    fn two_sources_create_different_keys_in_different_dirs() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        assert_ne!(
            source(a.path()).create().unwrap().id(),
            source(b.path()).create().unwrap().id()
        );
    }

    #[test]
    fn load_rejects_a_malformed_key_without_echoing_it() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("secret-store.key");
        let bogus = "SENTINEL-997-key-material";
        for content in [bogus.as_bytes(), b"", &[0xffu8, 0xfe][..]] {
            std::fs::write(&path, content).unwrap();
            let err = source(tmp.path()).load().err().unwrap();
            assert!(matches!(err, SecretStoreError::KeyUnreadable));
            assert!(!format!("{err} {err:?}").contains(bogus));
            assert_eq!(std::fs::read(&path).unwrap(), content);
        }
    }

    #[test]
    fn load_accepts_a_trailing_newline() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("secret-store.key");
        std::fs::write(&path, format!("{}\n", "ab".repeat(32))).unwrap();
        assert_eq!(
            source(tmp.path()).load().unwrap().unwrap().id(),
            Key::from_bytes([0xab; 32]).id()
        );
    }

    #[test]
    fn create_on_a_malformed_existing_file_fails_and_leaves_it_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("secret-store.key");
        std::fs::write(&path, "not a key").unwrap();

        let err = source(tmp.path()).create().err().unwrap();

        assert!(matches!(err, SecretStoreError::KeyUnreadable));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not a key");
    }

    #[test]
    fn load_reports_an_io_error_for_an_unreadable_path() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("secret-store.key")).unwrap();
        let err = source(tmp.path()).load().err().unwrap();
        assert!(matches!(err, SecretStoreError::Io(_)));
    }

    #[test]
    fn create_leaves_no_temp_file_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let src = source(tmp.path());
        src.create().unwrap();
        src.create().unwrap();

        let names: Vec<String> = std::fs::read_dir(tmp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["secret-store.key".to_owned()]);
    }

    #[test]
    fn a_stale_temp_file_does_not_block_writing_the_temp_key() {
        let tmp = tempfile::tempdir().unwrap();
        let temp = tmp.path().join(".secret-store.key.tmp.1.0");
        std::fs::write(&temp, "stale").unwrap();

        write_temp_key(&temp, &[0x11; KEY_LEN]).unwrap();

        assert_eq!(std::fs::read_to_string(&temp).unwrap(), "11".repeat(32));
    }

    #[test]
    fn create_keeps_a_complete_existing_key_byte_for_byte() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("secret-store.key");
        let existing = "cd".repeat(32);
        std::fs::write(&path, &existing).unwrap();

        let key = source(tmp.path()).create().unwrap();

        assert_eq!(key.id(), Key::from_bytes([0xcd; 32]).id());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), existing);
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1);
    }

    #[test]
    fn concurrent_creates_agree_on_one_key() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("secret-store.key");
        let ids: Vec<String> = (0..8)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || FileKeySource::new(path).create().unwrap().id())
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert!(ids.windows(2).all(|pair| pair[0] == pair[1]));
        assert_eq!(source(tmp.path()).load().unwrap().unwrap().id(), ids[0]);
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn created_key_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        source(tmp.path()).create().unwrap();
        let mode = std::fs::metadata(tmp.path().join("secret-store.key"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
