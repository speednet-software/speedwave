// Tauri commands for CloudStorage detection (used by CreateProjectModal).

use serde::Serialize;

/// Response from `detect_cloudstorage_path`.
#[derive(Debug, Serialize)]
pub struct CloudStorageDetectionResult {
    /// Whether the given path is inside a known CloudStorage managed directory.
    pub is_cloudstorage: bool,
    /// Human-readable provider name if detected (e.g. "OneDrive"), or null.
    pub provider: Option<String>,
}

/// Detects whether `dir` is inside a known CloudStorage managed directory. Used by
/// `CreateProjectModal` to warn before adding a project that may require TCC permission.
#[tauri::command]
pub fn detect_cloudstorage_path(dir: String) -> Result<CloudStorageDetectionResult, String> {
    let path = std::path::Path::new(&dir);
    match speedwave_runtime::cloudstorage::detect_cloudstorage_provider(path) {
        Some(provider) => Ok(CloudStorageDetectionResult {
            is_cloudstorage: true,
            provider: Some(provider.display_name().to_string()),
        }),
        None => Ok(CloudStorageDetectionResult {
            is_cloudstorage: false,
            provider: None,
        }),
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code asserts via unwrap")]
mod tests {
    use super::*;

    #[test]
    fn detect_cloudstorage_path_non_cloudstorage_returns_false() {
        let result = detect_cloudstorage_path("/tmp/myproject".to_string()).unwrap();
        assert!(!result.is_cloudstorage);
        assert!(result.provider.is_none());
    }

    #[test]
    fn detect_cloudstorage_path_home_projects_returns_false() {
        let result =
            detect_cloudstorage_path("/Users/alice/Projects/myproject".to_string()).unwrap();
        assert!(!result.is_cloudstorage);
        assert!(result.provider.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn detect_cloudstorage_path_onedrive_returns_true() {
        let result = detect_cloudstorage_path(
            "/Users/alice/Library/CloudStorage/OneDrive-Personal/Projects/foo".to_string(),
        )
        .unwrap();
        assert!(result.is_cloudstorage);
        assert_eq!(result.provider.as_deref(), Some("OneDrive"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn detect_cloudstorage_path_dropbox_returns_true() {
        let result =
            detect_cloudstorage_path("/Users/alice/Dropbox/Projects/myproject".to_string())
                .unwrap();
        assert!(result.is_cloudstorage);
        assert_eq!(result.provider.as_deref(), Some("Dropbox"));
    }
}
