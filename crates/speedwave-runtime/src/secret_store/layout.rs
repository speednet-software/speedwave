use std::fs::DirEntry;
use std::path::Path;

use super::error::{io_failure, SecretStoreError};
use super::name::ENCRYPTED_SUFFIX;

pub(super) const LOCK_SUFFIX: &str = ".lock";
const TEMP_INFIX: &str = ".enc.tmp";
const LEGACY_ANTHROPIC_KEY_FILE: &str = "anthropic_api_key";
const LEGACY_AUTH_TOKEN_SUFFIX: &str = "-auth-token";

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

pub(super) fn may_hold_ciphertext(secrets_dir: &Path) -> Result<bool, SecretStoreError> {
    Ok(contains_encrypted(secrets_dir)? || has_unrecoverable_entry(secrets_dir)?)
}

fn has_unrecoverable_entry(secrets_dir: &Path) -> Result<bool, SecretStoreError> {
    Ok(count_unrecoverable(secrets_dir)? > 0)
}

pub(super) fn count_unrecoverable(secrets_dir: &Path) -> Result<usize, SecretStoreError> {
    let mut count = 0;
    for entry in entries(secrets_dir)? {
        if has_encrypted_name(&entry) {
            count += 1;
            continue;
        }
        let kind = entry
            .file_type()
            .map_err(|e| io_failure("list secrets", &e))?;
        if kind.is_file() {
            continue;
        }
        if !kind.is_dir() {
            if std::fs::metadata(entry.path()).is_ok_and(|meta| meta.is_dir()) {
                count += 1;
            }
            continue;
        }
        if entry.file_name().to_str().is_none() {
            count += 1;
            continue;
        }
        count += entries(&entry.path())?
            .iter()
            .filter(|inner| has_encrypted_name(inner))
            .count();
    }
    Ok(count)
}

fn has_encrypted_name(entry: &DirEntry) -> bool {
    entry
        .file_name()
        .to_string_lossy()
        .ends_with(ENCRYPTED_SUFFIX)
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

pub(super) fn remove_unexpected(secrets_dir: &Path) -> Result<usize, SecretStoreError> {
    match std::fs::symlink_metadata(secrets_dir) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            return Err(SecretStoreError::Io(
                "clean secrets: the secrets path is not a directory".to_owned(),
            ))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(io_failure("clean secrets", &e)),
    }
    let mut removed = 0;
    for entry in entries(secrets_dir)? {
        if !is_directory(&entry) {
            remove_entry(&entry)?;
            removed += 1;
            continue;
        }
        for inner in entries(&entry.path())? {
            if !is_expected_in_project_dir(&inner) {
                remove_entry(&inner)?;
                removed += 1;
            }
        }
    }
    Ok(removed)
}

fn remove_entry(entry: &DirEntry) -> Result<(), SecretStoreError> {
    let path = entry.path();
    let kind = entry
        .file_type()
        .map_err(|e| io_failure("remove unexpected entry", &e))?;
    let result = if kind.is_dir() {
        std::fs::remove_dir_all(&path)
    } else {
        std::fs::remove_file(&path).or_else(|first| std::fs::remove_dir(&path).map_err(|_| first))
    };
    match result {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_failure("remove unexpected entry", &e)),
    }
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
        || is_legacy_plaintext_file(name)
        || is_atomic_write_temp(name)
        || (name.ends_with(LOCK_SUFFIX) && entry.metadata().is_ok_and(|meta| meta.len() == 0))
}

fn is_legacy_plaintext_file(name: &str) -> bool {
    name == LEGACY_ANTHROPIC_KEY_FILE
        || (name.len() > LEGACY_AUTH_TOKEN_SUFFIX.len() && name.ends_with(LEGACY_AUTH_TOKEN_SUFFIX))
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
        assert_eq!(remove_unexpected(&secrets).unwrap(), 0);
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
    fn may_hold_ciphertext_is_false_for_an_empty_or_clean_store() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = tmp.path().join("secrets");
        assert!(!may_hold_ciphertext(&secrets).unwrap());
        let dir = project_dir(tmp.path());
        assert!(!may_hold_ciphertext(&secrets).unwrap());
        std::fs::write(dir.join("a.b.enc.lock"), "").unwrap();
        std::fs::write(dir.join("anthropic_api_key"), "x").unwrap();
        std::fs::create_dir(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("deep.enc"), "x").unwrap();
        assert!(!may_hold_ciphertext(&secrets).unwrap());
    }

    #[test]
    fn may_hold_ciphertext_is_true_for_an_enc_file_or_enc_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = tmp.path().join("secrets");
        let dir = project_dir(tmp.path());
        std::fs::create_dir(dir.join("slack.token.enc")).unwrap();
        assert!(may_hold_ciphertext(&secrets).unwrap());
        std::fs::remove_dir(dir.join("slack.token.enc")).unwrap();
        std::fs::write(dir.join("slack.token.enc"), "x").unwrap();
        assert!(may_hold_ciphertext(&secrets).unwrap());
    }

    #[test]
    fn may_hold_ciphertext_is_true_for_a_loose_enc_entry_in_the_secrets_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = tmp.path().join("secrets");
        project_dir(tmp.path());
        std::fs::write(secrets.join("loose.enc"), "x").unwrap();
        assert!(may_hold_ciphertext(&secrets).unwrap());
        std::fs::remove_file(secrets.join("loose.enc")).unwrap();
        std::fs::create_dir(secrets.join("dir.enc")).unwrap();
        assert!(may_hold_ciphertext(&secrets).unwrap());
    }

    #[test]
    fn count_unrecoverable_counts_enc_names_and_odd_project_dirs_only() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = tmp.path().join("secrets");
        let dir = project_dir(tmp.path());
        assert_eq!(count_unrecoverable(&secrets).unwrap(), 0);
        std::fs::write(secrets.join(".DS_Store"), "x").unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        assert_eq!(count_unrecoverable(&secrets).unwrap(), 0);
        std::fs::write(secrets.join("loose.enc"), "x").unwrap();
        std::fs::create_dir(dir.join("a.b.enc")).unwrap();
        std::fs::write(dir.join("c.d.enc"), "x").unwrap();
        assert_eq!(count_unrecoverable(&secrets).unwrap(), 3);
    }

    #[test]
    fn may_hold_ciphertext_ignores_loose_non_enc_files() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = tmp.path().join("secrets");
        project_dir(tmp.path());
        std::fs::write(secrets.join(".DS_Store"), "x").unwrap();
        std::fs::write(secrets.join("notes.txt"), "x").unwrap();
        std::fs::write(secrets.join("loose.json"), "{}").unwrap();
        assert!(!may_hold_ciphertext(&secrets).unwrap());
    }

    #[cfg(windows)]
    fn unpaired_surrogate_name(prefix: &str, suffix: &str) -> std::ffi::OsString {
        use std::os::windows::ffi::OsStringExt;
        let wide: Vec<u16> = prefix
            .encode_utf16()
            .chain(std::iter::once(0xD800))
            .chain(suffix.encode_utf16())
            .collect();
        std::ffi::OsString::from_wide(&wide)
    }

    #[cfg(windows)]
    #[test]
    fn may_hold_ciphertext_is_true_for_a_non_utf8_project_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = tmp.path().join("secrets");
        std::fs::create_dir_all(&secrets).unwrap();
        std::fs::create_dir(secrets.join(unpaired_surrogate_name("pro", "ject"))).unwrap();
        assert!(may_hold_ciphertext(&secrets).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn may_hold_ciphertext_is_true_for_a_non_utf8_enc_name() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = tmp.path().join("secrets");
        let dir = project_dir(tmp.path());
        std::fs::write(dir.join(unpaired_surrogate_name("sl", "ck.token.enc")), "x").unwrap();
        assert!(may_hold_ciphertext(&secrets).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn may_hold_ciphertext_is_true_for_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secrets = tmp.path().join("secrets");
        let dir = project_dir(tmp.path());
        std::os::unix::fs::symlink(
            outside.path().join("victim.enc"),
            dir.join("slack.token.enc"),
        )
        .unwrap();
        assert!(may_hold_ciphertext(&secrets).unwrap());
        std::fs::remove_file(dir.join("slack.token.enc")).unwrap();
        assert!(!may_hold_ciphertext(&secrets).unwrap());
        std::os::unix::fs::symlink(outside.path(), secrets.join("linked")).unwrap();
        assert!(may_hold_ciphertext(&secrets).unwrap());
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_str().unwrap().to_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn expected_entries_are_kept() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = project_dir(tmp.path());
        std::fs::write(dir.join("slack.token.enc"), "x").unwrap();
        std::fs::write(dir.join("slack.token.enc.lock"), "").unwrap();
        std::fs::write(dir.join(".slack.token.enc.tmp.4242.7"), "x").unwrap();
        std::fs::create_dir_all(tmp.path().join("secrets").join("empty")).unwrap();

        assert_eq!(remove_unexpected(&tmp.path().join("secrets")).unwrap(), 0);

        assert_eq!(
            names_in(&dir),
            [
                ".slack.token.enc.tmp.4242.7",
                "slack.token.enc",
                "slack.token.enc.lock"
            ]
        );
        assert!(tmp.path().join("secrets").join("empty").is_dir());
    }

    #[test]
    fn unexpected_entries_are_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = project_dir(tmp.path());
        std::fs::write(dir.join("slack.token.enc"), "x").unwrap();
        std::fs::write(dir.join("slack.token"), "x").unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        std::fs::write(dir.join("busy.enc.lock"), "locked").unwrap();
        std::fs::create_dir(dir.join("subdir")).unwrap();
        std::fs::write(dir.join("subdir").join("deep.txt"), "x").unwrap();

        assert_eq!(remove_unexpected(&tmp.path().join("secrets")).unwrap(), 4);

        assert_eq!(names_in(&dir), ["slack.token.enc"]);
    }

    #[test]
    fn legacy_plaintext_files_are_kept() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = project_dir(tmp.path());
        std::fs::write(dir.join("anthropic_api_key"), "x").unwrap();
        std::fs::write(dir.join("slack-auth-token"), "x").unwrap();
        std::fs::write(dir.join("my-plugin-auth-token"), "x").unwrap();

        assert_eq!(remove_unexpected(&tmp.path().join("secrets")).unwrap(), 0);

        assert_eq!(names_in(&dir).len(), 3);
    }

    #[test]
    fn other_plaintext_beside_pending_legacy_files_is_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = project_dir(tmp.path());
        std::fs::write(dir.join("anthropic_api_key"), "x").unwrap();
        std::fs::write(dir.join("-auth-token"), "x").unwrap();
        std::fs::write(dir.join("anthropic_api_key.bak"), "x").unwrap();
        std::fs::write(dir.join("slack-auth-token.txt"), "x").unwrap();
        std::fs::write(dir.join("other_api_key"), "x").unwrap();
        std::fs::create_dir(dir.join("db-auth-token")).unwrap();

        assert_eq!(remove_unexpected(&tmp.path().join("secrets")).unwrap(), 5);

        assert_eq!(names_in(&dir), ["anthropic_api_key"]);
    }

    #[test]
    fn a_loose_file_in_the_secrets_dir_is_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = project_dir(tmp.path());
        let secrets = tmp.path().join("secrets");
        std::fs::write(secrets.join("loose.json"), "{}").unwrap();
        std::fs::write(secrets.join(".DS_Store"), "x").unwrap();

        assert_eq!(remove_unexpected(&secrets).unwrap(), 2);

        assert_eq!(names_in(&secrets), ["demo"]);
        assert!(dir.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_removed_and_never_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("victim.txt"), "keep").unwrap();
        let secrets = tmp.path().join("secrets");
        let dir = project_dir(tmp.path());
        std::os::unix::fs::symlink(outside.path().join("victim.txt"), dir.join("link.txt"))
            .unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.join("link-dir")).unwrap();
        std::os::unix::fs::symlink(outside.path(), secrets.join("linked")).unwrap();

        assert_eq!(remove_unexpected(&secrets).unwrap(), 3);

        assert!(names_in(&dir).is_empty());
        assert_eq!(names_in(&secrets), ["demo"]);
        assert_eq!(names_in(outside.path()), ["victim.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_secrets_dir_is_refused_and_its_target_is_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("victim.txt"), "keep").unwrap();
        std::os::unix::fs::symlink(outside.path(), tmp.path().join("secrets")).unwrap();

        let result = remove_unexpected(&tmp.path().join("secrets"));

        assert!(matches!(result, Err(SecretStoreError::Io(_))));
        assert_eq!(names_in(outside.path()), ["victim.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn an_entry_that_cannot_be_removed_is_an_error() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = project_dir(tmp.path());
        std::fs::write(dir.join("junk.txt"), "x").unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let result = remove_unexpected(&tmp.path().join("secrets"));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();

        assert!(matches!(result, Err(SecretStoreError::Io(_))));
        assert!(dir.join("junk.txt").is_file());
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
