//! Cross-platform file/directory permission utilities.
//!
//! On Unix: sets mode 0o600 (file) or 0o700 (directory) — owner only.
//! On Windows: replaces the DACL with a single ACE granting GENERIC_ALL
//! to the current user only. The Win32 SE_FILE_OBJECT type covers both
//! regular files and directories, so the ACL helper is shared.

/// Restrict file permissions to owner-only access.
/// - Unix: `chmod 600`
/// - Windows: DACL with a single GENERIC_ALL ACE for the current user
pub fn set_owner_only(path: &std::path::Path) -> Result<(), String> {
    set_owner_only_with_mode(path, 0o600)
}

/// Restrict directory permissions to owner-only access.
/// - Unix: `chmod 700`
/// - Windows: DACL with a single GENERIC_ALL ACE for the current user
pub fn set_owner_only_dir(path: &std::path::Path) -> Result<(), String> {
    set_owner_only_with_mode(path, 0o700)
}

/// SSOT for `set_owner_only` and `set_owner_only_dir`. Unix mode differs
/// between files (`0o600`) and dirs (`0o700`); on Windows
/// `SE_FILE_OBJECT` handles both regular files and directories, so the
/// ACL helper is shared and `_mode` is ignored there.
fn set_owner_only_with_mode(path: &std::path::Path, _mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(_mode))
            .map_err(|e| e.to_string())?;
    }

    #[cfg(windows)]
    {
        set_windows_acl_owner_only(path)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn set_owner_only_sets_600_on_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.txt");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(b"secret")
            .unwrap();

        set_owner_only(&path).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "expected 0o600, got 0o{mode:o}");
        }
    }

    #[test]
    fn set_owner_only_preserves_file_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        std::fs::write(&path, r#"{"key":"value"}"#).unwrap();

        set_owner_only(&path).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, r#"{"key":"value"}"#);
    }

    #[test]
    fn set_owner_only_fails_on_nonexistent_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does_not_exist.txt");

        let result = set_owner_only(&path);
        assert!(result.is_err(), "should fail on nonexistent file");
    }

    #[test]
    fn set_owner_only_works_on_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.txt");
        std::fs::File::create(&path).unwrap();

        set_owner_only(&path).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "expected 0o600, got 0o{mode:o}");
        }
    }

    #[test]
    fn set_owner_only_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        std::fs::write(&path, "abc123").unwrap();

        set_owner_only(&path).unwrap();
        set_owner_only(&path).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "expected 0o600, got 0o{mode:o}");
        }
    }

    #[test]
    fn set_owner_only_dir_sets_700_on_unix() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("subdir");
        std::fs::create_dir(&target).unwrap();

        set_owner_only_dir(&target).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "expected 0o700, got 0o{mode:o}");
        }
    }

    #[test]
    fn set_owner_only_dir_works_on_existing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("existing");
        std::fs::create_dir(&target).unwrap();
        // Place a file inside — perms change on dir must not affect contents.
        std::fs::write(target.join("file.txt"), b"contents").unwrap();

        set_owner_only_dir(&target).unwrap();

        let content = std::fs::read_to_string(target.join("file.txt")).unwrap();
        assert_eq!(content, "contents");
    }

    #[test]
    fn set_owner_only_dir_fails_on_nonexistent_path() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("does_not_exist");

        let result = set_owner_only_dir(&target);
        assert!(result.is_err(), "should fail on nonexistent directory");
    }

    #[test]
    fn set_owner_only_tightens_world_readable_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("loose.txt");
        std::fs::write(&path, "open").unwrap();

        // Start with 0o644 (world-readable)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }

        set_owner_only(&path).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode, 0o600,
                "expected 0o600 after tightening, got 0o{mode:o}"
            );
        }
    }
}

/// Restrict a file to the current user only via Windows ACL.
/// **Returns `Err` on any Win32 failure** — the caller must treat the file
/// as world-readable and remove/quarantine it, since a silent failure would
/// leave secrets exposed on disk.
#[cfg(windows)]
#[allow(unsafe_code)]
fn set_windows_acl_owner_only(path: &std::path::Path) -> Result<(), String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_ALL};
    use windows_sys::Win32::Security::Authorization::{
        SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, GRANT_ACCESS, SE_FILE_OBJECT,
        TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, ACL, DACL_SECURITY_INFORMATION, NO_INHERITANCE,
        PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token_handle = std::mem::zeroed();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token_handle) == 0 {
            return Err("OpenProcessToken failed".to_string());
        }
        let mut buf = vec![0u8; 256];
        let mut returned = 0u32;
        if GetTokenInformation(
            token_handle,
            TokenUser,
            buf.as_mut_ptr().cast(),
            buf.len() as u32,
            &mut returned,
        ) == 0
        {
            CloseHandle(token_handle);
            return Err("GetTokenInformation failed".to_string());
        }
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut ea = EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: user.User.Sid as *mut _,
            },
        };
        let mut new_acl: *mut ACL = std::ptr::null_mut();
        if SetEntriesInAclW(1, &mut ea, std::ptr::null_mut(), &mut new_acl) != 0 {
            CloseHandle(token_handle);
            return Err("SetEntriesInAclW failed".to_string());
        }
        let wide_path: Vec<u16> = path
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let rc = SetNamedSecurityInfoW(
            wide_path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            new_acl,
            std::ptr::null_mut(),
        );
        LocalFree(new_acl.cast());
        CloseHandle(token_handle);
        if rc != 0 {
            return Err(format!("SetNamedSecurityInfoW failed: rc={rc}"));
        }
        Ok(())
    }
}
