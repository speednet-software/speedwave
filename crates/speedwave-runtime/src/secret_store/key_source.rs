use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rand::TryRng;
use speedwave_crypto::Key;
use zeroize::Zeroizing;

use super::error::{io_failure, operation_failure, SecretStoreError};

const KEY_LEN: usize = 32;
const RACE_LOAD_ATTEMPTS: u32 = 25;
const RACE_LOAD_DELAY: Duration = Duration::from_millis(20);

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

    fn load_winner(&self) -> Result<Key, SecretStoreError> {
        for _ in 1..RACE_LOAD_ATTEMPTS {
            match self.load() {
                Ok(Some(key)) => return Ok(key),
                Ok(None) | Err(SecretStoreError::KeyUnreadable) => {
                    std::thread::sleep(RACE_LOAD_DELAY)
                }
                Err(e) => return Err(e),
            }
        }
        self.load()?.ok_or(SecretStoreError::KeyUnreadable)
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
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_failure("create key directory", &e))?;
        }
        let mut bytes = Zeroizing::new([0u8; KEY_LEN]);
        rand::rngs::SysRng
            .try_fill_bytes(&mut *bytes)
            .map_err(|_| operation_failure("read OS entropy"))?;

        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return self.load_winner();
            }
            Err(e) => return Err(io_failure("create key file", &e)),
        };

        if let Err(e) = write_and_sync_key(&mut file, &self.path, &bytes) {
            let _ = std::fs::remove_file(&self.path);
            return Err(e);
        }
        Ok(Key::from_bytes(*bytes))
    }
}

fn write_and_sync_key(
    file: &mut std::fs::File,
    path: &Path,
    bytes: &[u8; KEY_LEN],
) -> Result<(), SecretStoreError> {
    crate::fs_perms::set_owner_only(path).map_err(|_| operation_failure("restrict key file"))?;
    let hex = Zeroizing::new(crate::bundle::bytes_to_hex(bytes));
    file.write_all(hex.as_bytes())
        .and_then(|()| file.flush())
        .map_err(|e| io_failure("write key file", &e))?;
    crate::fs_perms::fsync_file_durable(file).map_err(|e| io_failure("sync key file", &e))?;
    if let Some(parent) = path.parent() {
        crate::fs_perms::fsync_parent_dir(parent);
    }
    Ok(())
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
