//! SSOT for host→engine path handling. Every path that becomes an argv token
//! to `wsl.exe`/`nerdctl`/`limactl`/`compose -f`/`-v`, or a mount source written
//! into compose YAML, must be produced here — never by a hand-rolled translation
//! or a raw `PathBuf::join` on an already-translated path. The drift detector
//! `tests/no_raw_engine_path.rs` enforces this.

use std::path::Path;

/// Converts a host path to the path seen by the container engine.
///
/// On Windows, nerdctl runs inside WSL2 so host paths must be translated from
/// `C:\Users\...` to `/mnt/c/Users/...`. On macOS, Lima mounts the host home
/// at the same path inside the VM, so paths are returned unchanged.
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

/// Joins a child onto an already-engine-side (Linux/WSL) directory with `/`.
///
/// `vm_root` is a path bound for inside the VM/container (`/mnt/c/...` on
/// Windows). `PathBuf::join` must NOT be used: on Windows it inserts a backslash
/// and mishandles the `/`-rooted string, mangling `<root>/<child>` into garbage
/// (the `presaleContainerfile` plugin-build bug). Trailing slashes on `vm_root`
/// collapse so the result has exactly one separator.
pub fn vm_path_join(vm_root: &str, child: &str) -> String {
    debug_assert!(
        !child.starts_with('/'),
        "vm_path_join child must be relative, got: {child}"
    );
    format!("{}/{}", vm_root.trim_end_matches('/'), child)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vm_path_join_inserts_single_separator() {
        // The case the plugin build hit: a WSL root + "Containerfile" must yield
        // exactly one "/", never the dropped-separator "presaleContainerfile".
        assert_eq!(
            vm_path_join("/mnt/c/Users/u/.speedwave/plugins/presale", "Containerfile"),
            "/mnt/c/Users/u/.speedwave/plugins/presale/Containerfile"
        );
    }

    #[test]
    fn vm_path_join_collapses_trailing_slashes_and_keeps_forward_slash() {
        // Trailing slashes collapse; separator is always "/" on every host OS
        // (no backslash even on Windows).
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
}
