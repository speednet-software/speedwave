//! CloudStorage TCC detection, probe, classification, and upstream helper.
//!
// macOS CloudStorage services (OneDrive, Dropbox, Google Drive) require
// Transparency Consent and Control (TCC) permission before the app can
// read directories managed by those services. When TCC is missing,
// `read_dir` returns EPERM (errno 13). This module centralizes all
// detection and reporting logic so every Tauri command entry point uses
// the same probe.

use std::io::ErrorKind;
use std::path::Path;
use std::time::Duration;

/// Error prefix embedded in `Err(...)` strings when a CloudStorage TCC
/// permission failure is detected. Format: `"CloudStorage TCC required: {stable_id}|{dir}"`.
/// Recognized by `restore_projects` (reconcile.rs) for substitution and by
/// `compute_project_switch_failure_payload` (main.rs) for UI routing.
///
/// SSOT — TypeScript callers mirror this via `cloudstorage-prefix.ts`.
pub use crate::consts::CLOUDSTORAGE_TCC_PREFIX;

/// User-facing substituted message used by both interactive and
/// non-interactive surfaces when a CloudStorage TCC failure is detected.
/// SSOT — Rust callers use it directly; TypeScript callers can use a
/// matching constant in cloudstorage-prefix.ts (test-asserted to match).
pub const TCC_USER_REMEDIATION_MESSAGE: &str =
    "Cloud storage permission required. Open the project from the project view to resolve.";

/// Probe timeout for a single `read_dir` attempt on a CloudStorage path.
/// CloudStorage directories under TCC denial respond immediately with EPERM,
/// so 5 s is generous — the timeout primarily guards against unexpected
/// network-backed mounts stalling.
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

/// Detects whether `path` is inside a known CloudStorage managed directory.
///
/// Returns `Some(provider)` if the path is under a recognized CloudStorage
/// root, `None` otherwise. macOS-only detection; other platforms always
/// return `None`.
///
/// Provider tokens are matched only at component boundaries — i.e. either
/// directly under `~/Library/CloudStorage/<Token>...` or as a top-level
/// subdirectory of the user's home (`/Users/<u>/<Token>...`). A path like
/// `/Users/alice/Projects/NotOneDriveBackup` is **not** matched.
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
        // The remaining path must start with `<token>` and the next byte
        // must be a component boundary.
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

/// Detects whether `path` lives under a known cloud-storage sync root. Not yet
/// implemented on Windows — always `None`.
#[cfg(target_os = "windows")]
pub fn detect_cloudstorage_provider(_path: &Path) -> Option<CloudStorageProvider> {
    None
}

/// Returns `true` if the IO error represents a TCC/permission denial.
pub fn is_permission_error(err: &std::io::Error) -> bool {
    matches!(err.kind(), ErrorKind::PermissionDenied)
}

/// Probes whether `path` is readable with a timeout.
///
/// Spawns a blocking thread and joins with a timeout. If `read_dir` returns
/// a permission error, classifies it as a TCC failure. Other errors and
/// timeouts return `Ok(())` (non-CloudStorage failure — let the caller
/// handle it normally).
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

/// Checks whether a path under a detected CloudStorage provider is readable.
///
/// Returns:
/// - `Ok(())` if not a CloudStorage path, or if readable
/// - `Err(provider)` if CloudStorage detected and TCC EPERM observed
pub fn check_cloudstorage_readability(path: &Path) -> Result<(), CloudStorageProvider> {
    let Some(provider) = detect_cloudstorage_provider(path) else {
        return Ok(());
    };

    match check_path_readable_with_timeout(path) {
        Err(e) if is_permission_error(&e) => Err(provider),
        _ => Ok(()),
    }
}

/// Pre-flight check for Tauri command entry points.
///
/// If `project_path` is under a CloudStorage provider and reading it fails
/// with EPERM, returns a prefix-encoded error string. The prefix is recognized
/// by `restore_projects` (for substitution) and `compute_project_switch_failure_payload`
/// (for UI routing). On non-macOS platforms or non-CloudStorage paths, returns `Ok(())`.
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
#[allow(clippy::unwrap_used, clippy::expect_used)]
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
        // Regression: a directory whose name contains "OneDrive" mid-token
        // (e.g. "NotOneDriveBackup") must NOT be misclassified as OneDrive.
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
        // Token at component boundary but not under /Users/ — not a real
        // CloudStorage mount. Avoids matching test fixtures and tmp paths.
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
        // This test simulates what would happen on macOS with a TCC-denied path.
        // Since we can't reproduce the actual TCC denial in a unit test, we verify
        // the error format by calling the formatting logic directly.
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
}
