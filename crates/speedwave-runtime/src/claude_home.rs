//! Per-project Claude Code home directory (`<data_dir>/claude-home/<project>/`).
//! Bind-mount target for Claude Code credentials/sessions/onboarding state;
//! Speedwave only locates (compose mount) and clears it (`speedwave logout`).

use std::io;
use std::path::{Path, PathBuf};

/// Returns `<data_dir>/claude-home/<project>/`. The caller is responsible for
/// validating `project` as a safe directory component beforehand.
pub fn claude_home_dir(data_dir: &Path, project: &str) -> PathBuf {
    data_dir
        .join(crate::consts::CLAUDE_HOME_SUBDIR)
        .join(project)
}

/// True when `.claude/.credentials.json` exists — a real "logged in to Claude
/// Code" signal, independent of which provider is active.
pub fn has_anthropic_oauth_credentials(data_dir: &Path, project: &str) -> bool {
    claude_home_dir(data_dir, project)
        .join(".claude")
        .join(".credentials.json")
        .exists()
}

/// Removes Claude Code's credential files (`.claude/.credentials.json` and
/// `.claude.json`) from the project's claude-home directory. Returns the count
/// removed; missing files are not an error (idempotent), both are attempted.
pub fn remove_claude_credentials(data_dir: &Path, project: &str) -> io::Result<usize> {
    let home = claude_home_dir(data_dir, project);
    let targets = [
        home.join(".claude").join(".credentials.json"),
        home.join(".claude.json"),
    ];
    let mut removed = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for path in &targets {
        match std::fs::remove_file(path) {
            Ok(()) => removed += 1,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => errors.push(format!("{}: {e}", path.display())),
        }
    }
    if errors.is_empty() {
        Ok(removed)
    } else {
        Err(io::Error::other(format!(
            "failed to remove {} credential file(s): {}",
            errors.len(),
            errors.join("; ")
        )))
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
mod tests {
    use super::*;

    #[test]
    fn claude_home_dir_layout() {
        let p = claude_home_dir(Path::new("/data"), "myproj");
        assert_eq!(p, Path::new("/data/claude-home/myproj"));
    }

    #[test]
    fn remove_both_files_present() {
        let tmp = tempfile::tempdir().unwrap();
        let home = claude_home_dir(tmp.path(), "p");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude").join(".credentials.json"), "{}").unwrap();
        std::fs::write(home.join(".claude.json"), "{}").unwrap();
        assert_eq!(remove_claude_credentials(tmp.path(), "p").unwrap(), 2);
        assert!(!home.join(".claude").join(".credentials.json").exists());
        assert!(!home.join(".claude.json").exists());
    }

    #[test]
    fn remove_only_credentials_present() {
        let tmp = tempfile::tempdir().unwrap();
        let home = claude_home_dir(tmp.path(), "p");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude").join(".credentials.json"), "{}").unwrap();
        assert_eq!(remove_claude_credentials(tmp.path(), "p").unwrap(), 1);
    }

    #[test]
    fn remove_nothing_present_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(remove_claude_credentials(tmp.path(), "p").unwrap(), 0);
    }

    #[test]
    fn has_oauth_credentials_true_when_file_present() {
        let tmp = tempfile::tempdir().unwrap();
        let home = claude_home_dir(tmp.path(), "p");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude").join(".credentials.json"), "{}").unwrap();
        assert!(has_anthropic_oauth_credentials(tmp.path(), "p"));
    }

    #[test]
    fn has_oauth_credentials_false_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        // Home exists but no credentials file.
        std::fs::create_dir_all(claude_home_dir(tmp.path(), "p").join(".claude")).unwrap();
        assert!(!has_anthropic_oauth_credentials(tmp.path(), "p"));
    }

    #[test]
    fn has_oauth_credentials_false_when_home_missing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!has_anthropic_oauth_credentials(tmp.path(), "nope"));
    }

    #[test]
    fn has_oauth_credentials_is_scoped_to_project() {
        let tmp = tempfile::tempdir().unwrap();
        let home = claude_home_dir(tmp.path(), "proj-a");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude").join(".credentials.json"), "{}").unwrap();
        // A different project sees no credentials.
        assert!(!has_anthropic_oauth_credentials(tmp.path(), "proj-b"));
    }

    #[test]
    fn remove_is_scoped_to_project_dir() {
        // A plain project component cannot reach outside claude-home/<project>.
        let tmp = tempfile::tempdir().unwrap();
        let home = claude_home_dir(tmp.path(), "proj-a");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude").join(".credentials.json"), "{}").unwrap();
        // Removing a *different* project removes nothing.
        assert_eq!(remove_claude_credentials(tmp.path(), "proj-b").unwrap(), 0);
        assert!(home.join(".claude").join(".credentials.json").exists());
    }
}
