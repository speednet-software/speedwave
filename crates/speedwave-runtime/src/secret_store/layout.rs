use std::fs::DirEntry;
use std::path::Path;

use super::error::{io_failure, SecretStoreError};
use super::name::ENCRYPTED_SUFFIX;

pub(super) const LOCK_SUFFIX: &str = ".lock";
const TEMP_INFIX: &str = ".enc.tmp";

pub(super) fn contains_encrypted(secrets_dir: &Path) -> Result<bool, SecretStoreError> {
    for entry in entries(secrets_dir)? {
        if has_suffix(&entry, ENCRYPTED_SUFFIX) {
            return Ok(true);
        }
        if is_directory(&entry) {
            for inner in entries(&entry.path())? {
                if has_suffix(&inner, ENCRYPTED_SUFFIX) {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
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

fn has_suffix(entry: &DirEntry, suffix: &str) -> bool {
    entry
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
        || is_atomic_write_temp(name)
        || (name.ends_with(LOCK_SUFFIX) && entry.metadata().is_ok_and(|meta| meta.len() == 0))
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
    fn contains_encrypted_finds_a_loose_enc_file_in_the_secrets_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = tmp.path().join("secrets");
        std::fs::create_dir_all(&secrets).unwrap();
        std::fs::write(secrets.join("slack.token.enc"), "x").unwrap();
        assert!(contains_encrypted(&secrets).unwrap());
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
