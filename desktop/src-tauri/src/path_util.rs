//! Small filesystem/path helpers shared across desktop modules.

use std::ffi::OsStr;
use std::path::PathBuf;

/// Searches `path_var` (a `PATH`-style separated list) for `name`, returning
/// the first entry that is a file. Pure — takes the search path as a parameter for testability.
pub(crate) fn which_in_path_var(path_var: &OsStr, name: &str) -> Option<PathBuf> {
    std::env::split_paths(path_var)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Minimal `which` — looks for `name` on the process `$PATH`. Returns
/// `Some(path)` of the first directory entry that is a file.
pub(crate) fn which_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    which_in_path_var(&path, name)
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "unwrap is fine in test assertions")]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn finds_file_in_first_matching_dir() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        // tool exists in `b` only
        let bin = b.path().join("fake-tool");
        let mut f = std::fs::File::create(&bin).unwrap();
        f.write_all(b"#!/bin/sh\n").unwrap();
        let joined = std::env::join_paths([a.path(), b.path()]).unwrap();
        assert_eq!(
            which_in_path_var(&joined, "fake-tool").as_deref(),
            Some(bin.as_path())
        );
    }

    #[test]
    fn prefers_earlier_dir_on_path() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        for d in [a.path(), b.path()] {
            let mut f = std::fs::File::create(d.join("dup")).unwrap();
            f.write_all(b"x").unwrap();
        }
        let joined = std::env::join_paths([a.path(), b.path()]).unwrap();
        assert_eq!(
            which_in_path_var(&joined, "dup").as_deref(),
            Some(a.path().join("dup").as_path())
        );
    }

    #[test]
    fn returns_none_when_absent() {
        let a = tempfile::tempdir().unwrap();
        let joined = std::env::join_paths([a.path()]).unwrap();
        assert!(which_in_path_var(&joined, "definitely-not-real-xyz").is_none());
    }

    #[test]
    fn returns_none_for_empty_path() {
        assert!(which_in_path_var(OsStr::new(""), "anything").is_none());
    }

    #[test]
    fn ignores_directory_named_like_binary() {
        let a = tempfile::tempdir().unwrap();
        std::fs::create_dir(a.path().join("notabin")).unwrap();
        let joined = std::env::join_paths([a.path()]).unwrap();
        assert!(which_in_path_var(&joined, "notabin").is_none());
    }
}
