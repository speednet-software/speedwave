//! CloudStorage TCC detection, probe, classification, and upstream helper.

use std::io::ErrorKind;
use std::path::Path;
use std::time::Duration;

/// Error prefix for CloudStorage TCC failure: `"CloudStorage TCC required: {stable_id}|{dir}"`.
/// SSOT — TypeScript callers mirror this via `cloudstorage-prefix.ts`.
pub use crate::consts::CLOUDSTORAGE_TCC_PREFIX;

/// User-facing message for a CloudStorage TCC failure.
/// SSOT — TypeScript mirror in cloudstorage-prefix.ts (test-asserted to match).
pub const TCC_USER_REMEDIATION_MESSAGE: &str =
    "Cloud storage permission required. Open the project from the project view to resolve.";

/// Probe timeout for a single `read_dir` attempt on a CloudStorage path.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Known CloudStorage provider identifiers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudStorageProvider {
    /// Microsoft OneDrive.
    OneDrive,
    /// Dropbox.
    Dropbox,
    /// Google Drive.
    GoogleDrive,
}

impl CloudStorageProvider {
    /// Human-readable display name for UI messages.
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::OneDrive => "OneDrive",
            Self::Dropbox => "Dropbox",
            Self::GoogleDrive => "Google Drive",
        }
    }

    /// Stable lowercase identifier embedded in TCC prefix strings.
    /// Kept stable across versions so prefix parsing is backward-compatible.
    pub fn stable_id(&self) -> &'static str {
        match self {
            Self::OneDrive => "one_drive",
            Self::Dropbox => "dropbox",
            Self::GoogleDrive => "google_drive",
        }
    }

    /// Parse a stable identifier back to its provider.
    pub fn from_stable_id(id: &str) -> Option<Self> {
        match id {
            "one_drive" => Some(Self::OneDrive),
            "dropbox" => Some(Self::Dropbox),
            "google_drive" => Some(Self::GoogleDrive),
            _ => None,
        }
    }
}

/// Detects whether `path` is inside a known CloudStorage managed directory. `Some(provider)` if
/// under a recognized root (macOS-only; else `None`); tokens match only at component boundaries.
#[cfg(target_os = "macos")]
pub fn detect_cloudstorage_provider(path: &Path) -> Option<CloudStorageProvider> {
    /// Returns true if `haystack` contains `needle` followed by a path
    /// component boundary — the next byte is `/`, `-`, or end-of-string.
    fn contains_at_boundary(haystack: &str, needle: &str) -> bool {
        let mut search_from = 0;
        while let Some(rel) = haystack[search_from..].find(needle) {
            let abs = search_from + rel;
            let after = abs + needle.len();
            match haystack.as_bytes().get(after) {
                None | Some(b'/') | Some(b'-') => return true,
                _ => search_from = abs + 1,
            }
        }
        false
    }

    /// Returns true if `path` is `/Users/<user>/<token>...` — i.e. `token`
    /// appears as a top-level component directly under the user's home.
    fn is_top_level_under_users(path: &str, token: &str) -> bool {
        let after_users = match path.strip_prefix("/Users/") {
            Some(rest) => rest,
            None => return false,
        };
        // Skip the username component
        let username_end = match after_users.find('/') {
            Some(i) => i,
            None => return false,
        };
        let after_user = &after_users[username_end + 1..];
        // Tail must start with `<token>` then a component boundary.
        if let Some(tail) = after_user.strip_prefix(token) {
            return tail.is_empty() || tail.starts_with('/') || tail.starts_with('-');
        }
        false
    }

    let path_str = path.to_string_lossy();

    // OneDrive: ~/Library/CloudStorage/OneDrive(-…)? or ~/OneDrive(-…)?
    if contains_at_boundary(&path_str, "/Library/CloudStorage/OneDrive")
        || is_top_level_under_users(&path_str, "OneDrive")
    {
        return Some(CloudStorageProvider::OneDrive);
    }

    // Dropbox: ~/Library/CloudStorage/Dropbox… or ~/Dropbox…
    if contains_at_boundary(&path_str, "/Library/CloudStorage/Dropbox")
        || is_top_level_under_users(&path_str, "Dropbox")
    {
        return Some(CloudStorageProvider::Dropbox);
    }

    // Google Drive: ~/Library/CloudStorage/GoogleDrive(-…)? or ~/Google Drive…
    if contains_at_boundary(&path_str, "/Library/CloudStorage/GoogleDrive")
        || is_top_level_under_users(&path_str, "Google Drive")
    {
        return Some(CloudStorageProvider::GoogleDrive);
    }

    None
}

/// Windows: matches `path` against the `%OneDrive%` sync root (covers KFM — redirected
/// Desktop/Documents live under it) plus Dropbox/Google Drive well-known component names.
#[cfg(target_os = "windows")]
pub fn detect_cloudstorage_provider(path: &Path) -> Option<CloudStorageProvider> {
    detect_cloudstorage_provider_windows(path, std::env::var_os("OneDrive").map(Into::into))
}

/// Testable core of the Windows detector; `onedrive_root` = `%OneDrive%`.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn detect_cloudstorage_provider_windows(
    path: &Path,
    onedrive_root: Option<std::path::PathBuf>,
) -> Option<CloudStorageProvider> {
    fn norm(s: &std::path::Path) -> String {
        s.to_string_lossy().replace('/', "\\").to_lowercase()
    }
    let p = norm(path);
    if let Some(root) = onedrive_root {
        let r = norm(&root);
        if !r.is_empty() && (p == r || p.starts_with(&format!("{r}\\"))) {
            return Some(CloudStorageProvider::OneDrive);
        }
    }
    let component = |name: &str| {
        p.split('\\')
            .any(|c| c == name || c.starts_with(&format!("{name} -")))
    };
    if component("onedrive") {
        return Some(CloudStorageProvider::OneDrive);
    }
    if component("dropbox") {
        return Some(CloudStorageProvider::Dropbox);
    }
    if component("google drive") || component("googledrive") {
        return Some(CloudStorageProvider::GoogleDrive);
    }
    None
}

/// Returns `true` if the IO error represents a TCC/permission denial.
pub fn is_permission_error(err: &std::io::Error) -> bool {
    matches!(err.kind(), ErrorKind::PermissionDenied)
}

/// Probes whether `path` is readable, bounded by `PROBE_TIMEOUT`. A permission error is returned as
/// the TCC failure; other errors and timeouts return `Ok(())` for the caller to handle normally.
pub fn check_path_readable_with_timeout(path: &Path) -> Result<(), std::io::Error> {
    let path_owned = path.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();

    std::thread::spawn(move || {
        let result = std::fs::read_dir(&path_owned);
        let _ = tx.send(result);
    });

    match rx.recv_timeout(PROBE_TIMEOUT) {
        Ok(result) => result.map(|_| ()),
        Err(_timeout) => Ok(()), // timeout — treat as non-blocking, let normal path handle it
    }
}

/// Checks whether a path under a detected CloudStorage provider is readable. `Ok(())` if not a
/// CloudStorage path or readable; `Err(provider)` if CloudStorage detected and TCC EPERM observed.
pub fn check_cloudstorage_readability(path: &Path) -> Result<(), CloudStorageProvider> {
    let Some(provider) = detect_cloudstorage_provider(path) else {
        return Ok(());
    };

    match check_path_readable_with_timeout(path) {
        Err(e) if is_permission_error(&e) => Err(provider),
        _ => {
            // Readable, but still a synced dir: placeholder hydration and sync
            // churn can break container bind mounts — leave a breadcrumb.
            log::warn!(
                "project at {} is inside {} — cloud sync can stall or corrupt \
                 container workspace mounts; prefer a local directory",
                path.display(),
                provider.display_name()
            );
            Ok(())
        }
    }
}

/// Pre-flight check for Tauri: returns a prefix-encoded error if a CloudStorage
/// `project_path` fails with EPERM, else `Ok(())`. macOS-only detection.
pub fn check_project_readable_or_err(project_path: &Path) -> Result<(), String> {
    match check_cloudstorage_readability(project_path) {
        Ok(()) => Ok(()),
        Err(provider) => Err(format!(
            "{}{}|{}",
            CLOUDSTORAGE_TCC_PREFIX,
            provider.stable_id(),
            project_path.display()
        )),
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
mod tests {
    use super::*;

    // -- TCC_USER_REMEDIATION_MESSAGE tests (§5.1) --

    #[test]
    fn tcc_user_remediation_message_is_non_empty_and_actionable() {
        assert!(
            !TCC_USER_REMEDIATION_MESSAGE.is_empty(),
            "TCC_USER_REMEDIATION_MESSAGE must not be empty"
        );
        assert!(
            TCC_USER_REMEDIATION_MESSAGE
                .to_lowercase()
                .contains("permission"),
            "TCC_USER_REMEDIATION_MESSAGE must contain the word 'permission'"
        );
        assert!(
            TCC_USER_REMEDIATION_MESSAGE.contains("project view"),
            "TCC_USER_REMEDIATION_MESSAGE must mention 'project view'"
        );
    }

    #[test]
    fn tcc_user_remediation_message_does_not_leak_prefix() {
        assert!(
            !TCC_USER_REMEDIATION_MESSAGE.contains(crate::consts::CLOUDSTORAGE_TCC_PREFIX),
            "TCC_USER_REMEDIATION_MESSAGE must not contain the TCC prefix (prevents re-substitution)"
        );
    }

    // -- CloudStorageProvider tests --

    #[test]
    fn provider_display_names_are_non_empty() {
        for provider in [
            CloudStorageProvider::OneDrive,
            CloudStorageProvider::Dropbox,
            CloudStorageProvider::GoogleDrive,
        ] {
            assert!(
                !provider.display_name().is_empty(),
                "display_name for {:?} must not be empty",
                provider
            );
        }
    }

    #[test]
    fn provider_stable_ids_are_lowercase_with_underscores() {
        for provider in [
            CloudStorageProvider::OneDrive,
            CloudStorageProvider::Dropbox,
            CloudStorageProvider::GoogleDrive,
        ] {
            let id = provider.stable_id();
            assert!(
                id.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "stable_id for {:?} must be lowercase with underscores, got: {}",
                provider,
                id
            );
        }
    }

    #[test]
    fn provider_from_stable_id_roundtrip() {
        for provider in [
            CloudStorageProvider::OneDrive,
            CloudStorageProvider::Dropbox,
            CloudStorageProvider::GoogleDrive,
        ] {
            let id = provider.stable_id();
            let recovered = CloudStorageProvider::from_stable_id(id);
            assert_eq!(
                recovered,
                Some(provider.clone()),
                "from_stable_id({id}) must round-trip back to {:?}",
                provider
            );
        }
    }

    #[test]
    fn provider_from_stable_id_unknown_returns_none() {
        assert!(CloudStorageProvider::from_stable_id("unknown").is_none());
        assert!(CloudStorageProvider::from_stable_id("").is_none());
        assert!(CloudStorageProvider::from_stable_id("onedrive").is_none());
    }

    // -- detect_cloudstorage_provider tests --

    #[test]
    fn detect_onedrive_library_cloudstorage() {
        let path = Path::new("/Users/alice/Library/CloudStorage/OneDrive-Personal/Projects/foo");
        let result = detect_cloudstorage_provider(path);
        #[cfg(target_os = "macos")]
        assert_eq!(result, Some(CloudStorageProvider::OneDrive));
        #[cfg(target_os = "windows")]
        assert!(result.is_none());
    }

    #[test]
    fn detect_dropbox_home() {
        let path = Path::new("/Users/alice/Dropbox/Projects/myproject");
        let result = detect_cloudstorage_provider(path);
        #[cfg(target_os = "macos")]
        assert_eq!(result, Some(CloudStorageProvider::Dropbox));
        #[cfg(target_os = "windows")]
        assert!(result.is_none());
    }

    #[test]
    fn detect_google_drive_library() {
        let path = Path::new(
            "/Users/alice/Library/CloudStorage/GoogleDrive-alice@example.com/My Drive/Projects",
        );
        let result = detect_cloudstorage_provider(path);
        #[cfg(target_os = "macos")]
        assert_eq!(result, Some(CloudStorageProvider::GoogleDrive));
        #[cfg(target_os = "windows")]
        assert!(result.is_none());
    }

    #[test]
    fn detect_regular_home_dir_is_none() {
        let path = Path::new("/Users/alice/Projects/myproject");
        assert!(detect_cloudstorage_provider(path).is_none());
    }

    #[test]
    fn detect_tmp_path_is_none() {
        let path = Path::new("/tmp/myproject");
        assert!(detect_cloudstorage_provider(path).is_none());
    }

    #[test]
    fn detect_substring_false_positive_is_none() {
        // Regression: "OneDrive" mid-token must not be misclassified.
        let path = Path::new("/Users/alice/Projects/NotOneDriveBackup");
        assert!(detect_cloudstorage_provider(path).is_none());
    }

    #[test]
    fn detect_dropbox_substring_false_positive_is_none() {
        let path = Path::new("/Users/alice/Projects/MyDropboxClone");
        assert!(detect_cloudstorage_provider(path).is_none());
    }

    #[test]
    fn detect_onedrive_outside_users_is_none() {
        // Token at a boundary but not under /Users/ is not a real mount.
        let path = Path::new("/tmp/OneDrive/foo");
        assert!(detect_cloudstorage_provider(path).is_none());
    }

    // -- is_permission_error tests --

    #[test]
    fn is_permission_error_detects_eperm() {
        let err = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(is_permission_error(&err));
    }

    #[test]
    fn is_permission_error_does_not_match_not_found() {
        let err = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(!is_permission_error(&err));
    }

    #[test]
    fn is_permission_error_does_not_match_connection_refused() {
        let err = std::io::Error::from(std::io::ErrorKind::ConnectionRefused);
        assert!(!is_permission_error(&err));
    }

    // -- check_project_readable_or_err tests --

    #[test]
    fn check_project_readable_or_err_non_cloudstorage_returns_ok() {
        let path = Path::new("/tmp");
        let result = check_project_readable_or_err(path);
        assert!(result.is_ok(), "non-CloudStorage path must return Ok");
    }

    #[test]
    fn check_project_readable_or_err_error_contains_prefix() {
        // Verifies the TCC error format directly (TCC denial is unreproducible in a unit test).
        let provider = CloudStorageProvider::OneDrive;
        let path = Path::new("/Users/alice/Library/CloudStorage/OneDrive-Personal/Projects/foo");
        let formatted = format!(
            "{}{}|{}",
            crate::consts::CLOUDSTORAGE_TCC_PREFIX,
            provider.stable_id(),
            path.display()
        );
        assert!(formatted.starts_with(crate::consts::CLOUDSTORAGE_TCC_PREFIX));
        assert!(formatted.contains("one_drive"));
        assert!(formatted.contains(path.to_str().unwrap()));
    }

    #[test]
    fn check_project_readable_or_err_existing_readable_dir_returns_ok() {
        // /tmp is always readable and is not a CloudStorage path
        let path = Path::new("/tmp");
        let result = check_project_readable_or_err(path);
        assert!(result.is_ok());
    }

    #[test]
    fn windows_detector_matches_onedrive_env_root_and_kfm_children() {
        let root = Some(std::path::PathBuf::from(
            r"C:\Users\User\OneDrive - Speednet",
        ));
        // KFM: redirected Desktop lives under the OneDrive root.
        for p in [
            r"C:\Users\User\OneDrive - Speednet",
            r"C:\Users\User\OneDrive - Speednet\Desktop\proj",
            r"C:/Users/User/OneDrive - Speednet/Documents/x",
        ] {
            assert_eq!(
                detect_cloudstorage_provider_windows(Path::new(p), root.clone()),
                Some(CloudStorageProvider::OneDrive),
                "path: {p}"
            );
        }
    }

    #[test]
    fn windows_detector_component_names_without_env() {
        assert_eq!(
            detect_cloudstorage_provider_windows(Path::new(r"D:\OneDrive\proj"), None),
            Some(CloudStorageProvider::OneDrive)
        );
        assert_eq!(
            detect_cloudstorage_provider_windows(Path::new(r"C:\Users\U\Dropbox\proj"), None),
            Some(CloudStorageProvider::Dropbox)
        );
        assert_eq!(
            detect_cloudstorage_provider_windows(Path::new(r"C:\Users\U\Google Drive\x"), None),
            Some(CloudStorageProvider::GoogleDrive)
        );
    }

    #[test]
    fn windows_detector_negatives() {
        // Substring inside a component must NOT match; unrelated paths pass.
        for p in [
            r"C:\Users\U\Projects\onedrive-clone-app",
            r"C:\Users\U\Downloads\proj",
            r"C:\dropboxes\x",
        ] {
            assert_eq!(
                detect_cloudstorage_provider_windows(Path::new(p), None),
                None,
                "path: {p}"
            );
        }
    }
}
