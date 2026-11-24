use std::fs::DirEntry;
use std::path::Path;

use super::error::{io_failure, SecretStoreError};
use super::name::ENCRYPTED_SUFFIX;

pub(super) const LOCK_SUFFIX: &str = ".lock";
const TEMP_INFIX: &str = ".enc.tmp";
const PENDING_ANTHROPIC_KEY_FILE: &str = "anthropic_api_key";
const PENDING_AUTH_TOKEN_SUFFIX: &str = "-auth-token";

pub(super) fn contains_encrypted(secrets_dir: &Path) -> Result<bool, SecretStoreError> {
    for entry in entries(secrets_dir)? {
        if !is_project_dir(&entry) {
            continue;
        }
        for inner in entries(&entry.path())? {
            if is_encrypted_file(&inner) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

pub(super) fn is_project_dir(entry: &DirEntry) -> bool {
    is_directory(entry) && entry.file_name().to_str().is_some()
}

pub(super) fn is_encrypted_file(entry: &DirEntry) -> bool {
    is_regular_file_with_suffix(entry, ENCRYPTED_SUFFIX)
}

pub(super) fn is_lock_file(entry: &DirEntry) -> bool {
    is_regular_file_with_suffix(entry, LOCK_SUFFIX)
}

pub(super) fn count_unexpected(secrets_dir: &Path) -> Result<usize, SecretStoreError> {
    let mut count = 0;
    for entry in entries(secrets_dir)? {
        if !is_directory(&entry) {
            count += 1;
            continue;
        }
        for inner in entries(&entry.path())? {
            if !is_expected_in_project_dir(&inner) {
                count += 1;
            }
        }
    }
    Ok(count)
}

fn entries(dir: &Path) -> Result<Vec<DirEntry>, SecretStoreError> {
    match std::fs::read_dir(dir) {
        Ok(read) => read
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| io_failure("list secrets", &e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(io_failure("list secrets", &e)),
    }
}

fn is_directory(entry: &DirEntry) -> bool {
    entry.file_type().is_ok_and(|kind| kind.is_dir())
}

fn is_regular_file_with_suffix(entry: &DirEntry, suffix: &str) -> bool {
    entry.file_type().is_ok_and(|kind| kind.is_file())
        && entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.ends_with(suffix))
}

fn is_expected_in_project_dir(entry: &DirEntry) -> bool {
    let Ok(kind) = entry.file_type() else {
        return false;
    };
    if !kind.is_file() {
        return false;
    }
    let file_name = entry.file_name();
    let Some(name) = file_name.to_str() else {
        return false;
    };
    name.ends_with(ENCRYPTED_SUFFIX)
        || is_pending_migration_file(name)
        || is_atomic_write_temp(name)
        || (name.ends_with(LOCK_SUFFIX) && entry.metadata().is_ok_and(|meta| meta.len() == 0))
}

fn is_pending_migration_file(name: &str) -> bool {
    name == PENDING_ANTHROPIC_KEY_FILE
        || (name.len() > PENDING_AUTH_TOKEN_SUFFIX.len()
            && name.ends_with(PENDING_AUTH_TOKEN_SUFFIX))
}

fn is_atomic_write_temp(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('.') else {
        return false;
    };
    let mut parts = rest.rsplitn(3, '.');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(seq), Some(pid), Some(head)) => {
            is_number(seq) && is_number(pid) && head.ends_with(TEMP_INFIX)
        }
        _ => false,
    }
}

fn is_number(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    fn project_dir(root: &Path) -> std::path::PathBuf {
        let dir = root.join("secrets").join("demo");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_secrets_dir_has_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = tmp.path().join("secrets");
        assert!(!contains_encrypted(&secrets).unwrap());
        assert_eq!(count_unexpected(&secrets).unwrap(), 0);
    }

    #[test]
    fn contains_encrypted_finds_an_enc_file_in_a_project_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = project_dir(tmp.path());
        assert!(!contains_encrypted(&tmp.path().join("secrets")).unwrap());
        std::fs::write(dir.join("a.b.lock"), "").unwrap();
        assert!(!contains_encrypted(&tmp.path().join("secrets")).unwrap());
        std::fs::write(dir.join("slack.token.enc"), "x").unwrap();
        assert!(contains_encrypted(&tmp.path().join("secrets")).unwrap());
    }

    #[test]
    fn contains_encrypted_ignores_a_loose_enc_file_in_the_secrets_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = tmp.path().join("secrets");
        std::fs::create_dir_all(&secrets).unwrap();
        std::fs::write(secrets.join("slack.token.enc"), "x").unwrap();
        assert!(!contains_encrypted(&secrets).unwrap());
    }

    #[test]
    fn contains_encrypted_ignores_nested_enc_files_and_enc_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = project_dir(tmp.path());
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("deep.enc"), "x").unwrap();
        std::fs::create_dir(dir.join("slack.token.enc")).unwrap();
        assert!(!contains_encrypted(&tmp.path().join("secrets")).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn contains_encrypted_ignores_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("victim.enc"), "x").unwrap();
        let secrets = tmp.path().join("secrets");
        let dir = project_dir(tmp.path());
        std::os::unix::fs::symlink(
            outside.path().join("victim.enc"),
            dir.join("slack.token.enc"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), secrets.join("linked")).unwrap();
        assert!(!contains_encrypted(&secrets).unwrap());
    }

    #[test]
    fn expected_entries_are_not_counted() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = project_dir(tmp.path());
        std::fs::write(dir.join("slack.token.enc"), "x").unwrap();
        std::fs::write(dir.join("slack.token.enc.lock"), "").unwrap();
        std::fs::write(dir.join(".slack.token.enc.tmp.4242.7"), "x").unwrap();
        std::fs::create_dir_all(tmp.path().join("secrets").join("empty")).unwrap();
        assert_eq!(count_unexpected(&tmp.path().join("secrets")).unwrap(), 0);
    }

    #[test]
    fn unexpected_entries_are_counted() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = project_dir(tmp.path());
        std::fs::write(dir.join("slack.token"), "x").unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        std::fs::write(dir.join("busy.enc.lock"), "locked").unwrap();
        std::fs::create_dir(dir.join("subdir")).unwrap();
        assert_eq!(count_unexpected(&tmp.path().join("secrets")).unwrap(), 4);
    }

    #[test]
    fn pending_migration_legacy_files_are_not_counted() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = project_dir(tmp.path());
        std::fs::write(dir.join("anthropic_api_key"), "x").unwrap();
        std::fs::write(dir.join("slack-auth-token"), "x").unwrap();
        std::fs::write(dir.join("my-plugin-auth-token"), "x").unwrap();
        assert_eq!(count_unexpected(&tmp.path().join("secrets")).unwrap(), 0);
    }

    #[test]
    fn other_plaintext_beside_pending_legacy_files_is_still_counted() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = project_dir(tmp.path());
        std::fs::write(dir.join("anthropic_api_key"), "x").unwrap();
        std::fs::write(dir.join("-auth-token"), "x").unwrap();
        std::fs::write(dir.join("anthropic_api_key.bak"), "x").unwrap();
        std::fs::write(dir.join("slack-auth-token.txt"), "x").unwrap();
        std::fs::write(dir.join("other_api_key"), "x").unwrap();
        std::fs::create_dir(dir.join("db-auth-token")).unwrap();
        assert_eq!(count_unexpected(&tmp.path().join("secrets")).unwrap(), 5);
    }

    #[test]
    fn a_loose_file_in_the_secrets_dir_is_counted() {
        let tmp = tempfile::tempdir().unwrap();
        project_dir(tmp.path());
        std::fs::write(tmp.path().join("secrets").join("loose.json"), "{}").unwrap();
        assert_eq!(count_unexpected(&tmp.path().join("secrets")).unwrap(), 1);
    }

    #[test]
    fn temp_file_names_are_matched_strictly() {
        assert!(is_atomic_write_temp(".slack.token.enc.tmp.1.0"));
        assert!(is_atomic_write_temp(".slack.token.enc.tmp.4242.17"));
        for name in [
            "slack.token.enc.tmp.1.0",
            ".slack.token.tmp.1.0",
            ".slack.token.enc.tmp.x.0",
            ".slack.token.enc.tmp.1.",
            ".slack.token.enc.tmp.1",
            ".tmp.1.0",
            ".",
            "",
        ] {
            assert!(!is_atomic_write_temp(name), "{name:?}");
        }
    }
}
