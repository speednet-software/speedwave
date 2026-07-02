//! SSOT for host→engine path handling, enforced by the drift detector
//! `tests/no_raw_engine_path.rs`.

use std::path::Path;

/// Converts a host path to the path seen by the container engine.
/// Windows: `C:\Users\...` → `/mnt/c/Users/...`; macOS: unchanged (1:1 mount).
pub fn to_engine_path(path: &Path) -> anyhow::Result<String> {
    #[cfg(target_os = "windows")]
    {
        let wsl = crate::runtime::wsl::windows_to_wsl_path(path)?;
        Ok(wsl.to_string_lossy().to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(path.to_string_lossy().to_string())
    }
}

/// Like [`to_engine_path`] but takes a `&str` (convenience for `project_dir`).
pub fn str_to_engine_path(path: &str) -> anyhow::Result<String> {
    to_engine_path(Path::new(path))
}

/// Strips the `\\?\` extended-length prefix from `<drive>:\` paths (SSOT).
/// `canonicalize` adds it; non-engine consumers (config.json, UI) choke on it.
pub fn strip_extended_length_prefix(path: &str) -> &str {
    let b = path.as_bytes();
    if b.len() >= 7
        && path.starts_with(r"\\?\")
        && b[4].is_ascii_alphabetic()
        && b[5] == b':'
        && (b[6] == b'\\' || b[6] == b'/')
    {
        &path[4..]
    } else {
        path
    }
}

/// Joins a relative `child` onto an already-engine-side `vm_root` with `/`
/// (never `PathBuf::join`, which mangles a `/`-rooted WSL path on Windows).
pub fn vm_path_join(vm_root: &str, child: &str) -> String {
    debug_assert!(
        !child.starts_with('/'),
        "vm_path_join child must be relative, got: {child}"
    );
    format!("{}/{}", vm_root.trim_end_matches('/'), child)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn vm_path_join_inserts_single_separator() {
        // WSL root + "Containerfile" yields exactly one "/" separator.
        assert_eq!(
            vm_path_join(
                "/mnt/c/Users/u/.speedwave/plugins/example-plugin",
                "Containerfile"
            ),
            "/mnt/c/Users/u/.speedwave/plugins/example-plugin/Containerfile"
        );
    }

    #[test]
    fn vm_path_join_collapses_trailing_slashes_and_keeps_forward_slash() {
        // Trailing slashes collapse; separator is always "/" on every host OS.
        assert_eq!(
            vm_path_join("/mnt/c/x/", "Containerfile"),
            "/mnt/c/x/Containerfile"
        );
        assert_eq!(vm_path_join("/mnt/c/x///", "y"), "/mnt/c/x/y");
        let joined = vm_path_join("/mnt/c/some/dir", "sub/Containerfile");
        assert!(
            !joined.contains('\\'),
            "must never use backslash, got: {joined}"
        );
        assert_eq!(joined, "/mnt/c/some/dir/sub/Containerfile");
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn to_engine_path_is_identity_on_unix() {
        // On macOS/Linux the host path is the engine path (Lima 1:1 mount).
        assert_eq!(
            to_engine_path(Path::new("/Users/u/.speedwave/plugins/x")).unwrap(),
            "/Users/u/.speedwave/plugins/x"
        );
        assert_eq!(
            str_to_engine_path("/Users/u/proj").unwrap(),
            "/Users/u/proj"
        );
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn to_engine_path_returns_path_unchanged_on_non_windows() {
        let path = Path::new("/home/user/projects/acme");
        assert_eq!(to_engine_path(path).unwrap(), "/home/user/projects/acme");
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn str_to_engine_path_returns_path_unchanged_on_non_windows() {
        assert_eq!(
            str_to_engine_path("/home/user/projects/acme").unwrap(),
            "/home/user/projects/acme"
        );
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn to_engine_path_handles_path_with_spaces() {
        let path = Path::new("/home/user/my projects/acme corp");
        assert_eq!(
            to_engine_path(path).unwrap(),
            "/home/user/my projects/acme corp"
        );
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn str_to_engine_path_handles_absolute_path() {
        assert_eq!(
            str_to_engine_path("/usr/local/share/speedwave").unwrap(),
            "/usr/local/share/speedwave"
        );
    }

    #[test]
    fn strip_extended_length_prefix_drive_paths() {
        assert_eq!(
            strip_extended_length_prefix(r"\\?\C:\Users\User\proj"),
            r"C:\Users\User\proj"
        );
        assert_eq!(
            strip_extended_length_prefix(r"\\?\d:/mixed/slash"),
            r"d:/mixed/slash"
        );
    }

    #[test]
    fn strip_extended_length_prefix_passthrough() {
        // UNC verbatim, plain drive, POSIX, and short strings stay unchanged.
        assert_eq!(
            strip_extended_length_prefix(r"\\?\UNC\server\share"),
            r"\\?\UNC\server\share"
        );
        assert_eq!(strip_extended_length_prefix(r"C:\plain"), r"C:\plain");
        assert_eq!(strip_extended_length_prefix("/unix/path"), "/unix/path");
        assert_eq!(strip_extended_length_prefix(r"\\?\C"), r"\\?\C");
    }
}
