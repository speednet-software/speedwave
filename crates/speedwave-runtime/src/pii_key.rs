//! Per-project PII tokenization key: a persistent 32-byte AES-SIV key generated once on
//! first use, stored hex-encoded next to `policy.json` (mirrors `pii_policy` layout).

use std::io::Write;
use std::path::{Path, PathBuf};

use rand::RngCore;

/// Path of the per-project tokenization key inside the policy dir.
pub fn project_key_path_in(data_dir: &Path, project: &str) -> PathBuf {
    crate::pii_policy::policy_config_dir_in(data_dir, project).join("key")
}

/// Exclusive create on first use; loser of a race sees `Ok`. A crash mid-write leaves an unreadable file.
pub fn ensure_project_key_in(data_dir: &Path, project: &str) -> anyhow::Result<()> {
    let path = project_key_path_in(data_dir, project);
    crate::fs_perms::ensure_owner_only_dir(&crate::pii_policy::policy_config_dir_in(
        data_dir, project,
    ))?;

    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(e) => {
            return Err(anyhow::anyhow!(
                "failed to create PII tokenization key at {}: {e}",
                path.display()
            ))
        }
    };

    // Best-effort cleanup on any failure after file creation.
    if let Err(e) = write_and_sync_key(&mut file, &path) {
        let _ = std::fs::remove_file(&path);
        return Err(e);
    }

    Ok(())
}

/// Writes and durable-syncs the key, then syncs the parent directory.
fn write_and_sync_key(file: &mut std::fs::File, path: &std::path::Path) -> anyhow::Result<()> {
    crate::fs_perms::set_owner_only(path).map_err(|e| {
        anyhow::anyhow!("failed to restrict permissions on {}: {e}", path.display())
    })?;

    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let hex = crate::bundle::bytes_to_hex(&bytes);

    file.write_all(hex.as_bytes())?;
    file.flush()?;
    crate::fs_perms::fsync_file_durable(file)?;

    // Ensure the directory entry is durable.
    if let Some(parent) = path.parent() {
        crate::fs_perms::fsync_parent_dir(parent);
    }

    Ok(())
}

/// Reads and decodes the key; `Err` when absent, unreadable, or malformed
/// (fail-closed; the error never carries the file's content, only its path).
pub fn read_project_key_in(data_dir: &Path, project: &str) -> anyhow::Result<[u8; 32]> {
    let path = project_key_path_in(data_dir, project);
    let content = std::fs::read_to_string(&path).map_err(|e| {
        anyhow::anyhow!(
            "cannot read PII tokenization key at {}: {e}",
            path.display()
        )
    })?;
    decode_hex_key(content.trim()).map_err(|e| {
        anyhow::anyhow!(
            "PII tokenization key at {} is malformed: {e}",
            path.display()
        )
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

    #[test]
    fn ensure_creates_64_lowercase_hex_chars_in_the_policy_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        ensure_project_key_in(tmp.path(), "proj").unwrap();

        let path = project_key_path_in(tmp.path(), "proj");
        assert_eq!(
            path,
            crate::pii_policy::policy_config_dir_in(tmp.path(), "proj").join("key")
        );
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content.len(),
            64,
            "file must hold exactly 64 chars, no trailing newline"
        );
        assert!(content
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    #[cfg(unix)]
    fn ensure_sets_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        ensure_project_key_in(tmp.path(), "proj").unwrap();

        let path = project_key_path_in(tmp.path(), "proj");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "key file must be owner-only");
        let dir_mode =
            std::fs::metadata(crate::pii_policy::policy_config_dir_in(tmp.path(), "proj"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
        assert_eq!(dir_mode, 0o700, "policy dir must be owner-only");
    }

    #[test]
    fn ensure_is_idempotent_and_never_overwrites_an_existing_key() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_project_key_in(tmp.path(), "proj").unwrap();
        let path = project_key_path_in(tmp.path(), "proj");
        let first = std::fs::read(&path).unwrap();

        ensure_project_key_in(tmp.path(), "proj").unwrap();
        let second = std::fs::read(&path).unwrap();

        assert_eq!(
            first, second,
            "a second ensure must not change the key file"
        );
    }

    #[test]
    fn ensure_on_a_pre_existing_key_file_leaves_its_content_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = crate::pii_policy::policy_config_dir_in(tmp.path(), "proj");
        crate::fs_perms::ensure_owner_only_dir(&dir).unwrap();
        let path = project_key_path_in(tmp.path(), "proj");
        std::fs::write(&path, "not-a-real-key-just-a-placeholder").unwrap();

        ensure_project_key_in(tmp.path(), "proj").unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "not-a-real-key-just-a-placeholder",
            "ensure must hit the AlreadyExists branch and never touch existing content"
        );
    }

    #[test]
    fn read_after_ensure_decodes_to_the_same_32_bytes_as_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_project_key_in(tmp.path(), "proj").unwrap();

        let key = read_project_key_in(tmp.path(), "proj").unwrap();
        let hex_on_disk = std::fs::read_to_string(project_key_path_in(tmp.path(), "proj")).unwrap();
        assert_eq!(crate::bundle::bytes_to_hex(&key), hex_on_disk.trim());
    }

    #[test]
    fn read_errs_when_the_key_file_is_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let err = read_project_key_in(tmp.path(), "proj")
            .unwrap_err()
            .to_string();
        assert!(!err.is_empty());
    }

    #[test]
    fn read_errs_on_a_short_key_without_leaking_content() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = crate::pii_policy::policy_config_dir_in(tmp.path(), "proj");
        crate::fs_perms::ensure_owner_only_dir(&dir).unwrap();
        let path = project_key_path_in(tmp.path(), "proj");
        std::fs::write(&path, "a".repeat(63)).unwrap();

        let err = read_project_key_in(tmp.path(), "proj")
            .unwrap_err()
            .to_string();
        assert!(!err.contains(&"a".repeat(63)));
        assert!(err.contains("63"));
    }

    #[test]
    fn read_errs_on_non_hex_content_without_leaking_it() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = crate::pii_policy::policy_config_dir_in(tmp.path(), "proj");
        crate::fs_perms::ensure_owner_only_dir(&dir).unwrap();
        let path = project_key_path_in(tmp.path(), "proj");
        let bogus = "z".repeat(64);
        std::fs::write(&path, &bogus).unwrap();

        let err = read_project_key_in(tmp.path(), "proj")
            .unwrap_err()
            .to_string();
        assert!(!err.contains(&bogus));
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
