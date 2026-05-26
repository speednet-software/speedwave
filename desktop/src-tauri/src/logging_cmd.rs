use std::sync::OnceLock;

const DEFAULT_BUNDLE_IDENTIFIER: &str = "pl.speedwave.desktop";

// `make dev` overrides identifier to `.dev` via TAURI_CONFIG; must match
// tauri-plugin-log's runtime LogDir target, not the value in tauri.conf.json.
static BUNDLE_IDENTIFIER: OnceLock<String> = OnceLock::new();

pub(crate) fn init_bundle_identifier(identifier: String) {
    if BUNDLE_IDENTIFIER.set(identifier).is_err() {
        log::debug!("init_bundle_identifier: already initialised; ignoring");
    }
}

fn bundle_identifier() -> &'static str {
    match BUNDLE_IDENTIFIER.get() {
        Some(s) => s.as_str(),
        None => {
            // Production build: return the default silently (Tauri setup might not
            // have run yet during early panic-hook output, etc.). Debug build:
            // surface the miss — it means desktop_log_dir() was consulted before
            // init_bundle_identifier and will return the release path under dev.
            #[cfg(all(debug_assertions, not(test)))]
            log::warn!(
                "bundle_identifier(): BUNDLE_IDENTIFIER not initialised yet; falling back to {DEFAULT_BUNDLE_IDENTIFIER}"
            );
            DEFAULT_BUNDLE_IDENTIFIER
        }
    }
}

// Matches tauri-plugin-log v2 TargetKind::LogDir resolution:
// macOS: ~/Library/Logs/<bundle>, Windows: %LOCALAPPDATA%/<bundle>/logs.
pub(crate) fn desktop_log_dir() -> Option<std::path::PathBuf> {
    let id = bundle_identifier();
    if cfg!(target_os = "macos") {
        let home = dirs::home_dir()?;
        Some(home.join("Library/Logs").join(id))
    } else {
        dirs::data_local_dir().map(|d| d.join(id).join("logs"))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn desktop_log_dir_returns_some_on_supported_platform() {
        let dir = desktop_log_dir();
        assert!(
            dir.is_some(),
            "desktop_log_dir must resolve under a normal home dir"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn desktop_log_dir_macos_path_under_library_logs() {
        let dir = desktop_log_dir().unwrap();
        let s = dir.to_string_lossy();
        assert!(
            s.contains("Library/Logs/") && s.contains(bundle_identifier()),
            "macOS path must point under Library/Logs/<bundle>, got {s}"
        );
        assert!(
            !s.contains("/logs"),
            "macOS path must NOT end with /logs subdir, got {s}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn desktop_log_dir_windows_path_under_local_appdata_logs() {
        let dir = desktop_log_dir().unwrap();
        let s = dir.to_string_lossy();
        // tauri-plugin-log v2 uses LOCALAPPDATA + bundle + /logs on Windows.
        assert!(
            s.contains("AppData") && s.contains("Local") && s.ends_with("logs"),
            "Windows path must be under LocalAppData/<bundle>/logs, got {s}"
        );
        assert!(
            s.contains(bundle_identifier()),
            "must contain bundle id, got {s}"
        );
    }

    #[test]
    fn desktop_log_dir_honours_initialised_identifier() {
        let dir = desktop_log_dir().unwrap();
        let s = dir.to_string_lossy();
        assert!(
            s.contains(bundle_identifier()),
            "path must contain active bundle identifier ({}), got {s}",
            bundle_identifier()
        );
    }
}
