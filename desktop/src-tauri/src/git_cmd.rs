// Lightweight git introspection for the chat status bar.
//
// Only one command exists: `get_git_branch` — returns the current branch name
// for the active project's working directory, or `None` when the directory is
// not a git repo / git is unavailable. The status strip in the composer uses
// this to display `<branch icon> main` next to the session cost.

use std::path::Path;
use std::process::Command;

use speedwave_runtime::config;

/// Returns the current git branch for `project`, or `None` if the project
/// directory is not a git repository (or git can't be executed).
///
/// Resolves the project's `dir` from the user config and runs
/// `git rev-parse --abbrev-ref HEAD` against it. Detached HEADs return
/// `Some("HEAD")` — the frontend treats that label like any other branch.
#[tauri::command]
pub(crate) fn get_git_branch(project: String) -> Result<Option<String>, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    let Some(entry) = user_config.find_project(&project) else {
        return Ok(None);
    };
    Ok(read_branch(Path::new(&entry.dir)))
}

/// Runs `git rev-parse --abbrev-ref HEAD` in `dir` and returns the trimmed
/// branch name. Any non-zero exit (not a git repo, git missing, etc.) maps
/// to `None` so the UI silently hides the branch chip.
fn read_branch(dir: &Path) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn run(args: &[&str], dir: &Path) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed in {}", dir.display());
    }

    #[test]
    fn read_branch_returns_none_for_non_repo() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_branch(tmp.path()), None);
    }

    #[test]
    fn read_branch_returns_initial_branch_name() {
        let tmp = tempfile::tempdir().unwrap();
        run(&["init", "-b", "speedwave-test"], tmp.path());
        run(&["config", "user.email", "t@t"], tmp.path());
        run(&["config", "user.name", "t"], tmp.path());
        run(&["commit", "--allow-empty", "-m", "init"], tmp.path());
        assert_eq!(read_branch(tmp.path()), Some("speedwave-test".into()));
    }

    #[test]
    fn read_branch_returns_none_for_unborn_head() {
        let tmp = tempfile::tempdir().unwrap();
        run(&["init", "-b", "main"], tmp.path());
        // No commits yet — HEAD points at an unborn branch, so rev-parse
        // exits non-zero and we surface that as `None`.
        assert_eq!(read_branch(tmp.path()), None);
    }

    #[test]
    fn read_branch_follows_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        run(&["init", "-b", "main"], tmp.path());
        run(&["config", "user.email", "t@t"], tmp.path());
        run(&["config", "user.name", "t"], tmp.path());
        run(&["commit", "--allow-empty", "-m", "init"], tmp.path());
        run(&["checkout", "-b", "feat/x"], tmp.path());
        assert_eq!(read_branch(tmp.path()), Some("feat/x".into()));
    }

    #[test]
    fn read_branch_detached_head_returns_head_label() {
        let tmp = tempfile::tempdir().unwrap();
        run(&["init", "-b", "main"], tmp.path());
        run(&["config", "user.email", "t@t"], tmp.path());
        run(&["config", "user.name", "t"], tmp.path());
        run(&["commit", "--allow-empty", "-m", "first"], tmp.path());
        run(&["commit", "--allow-empty", "-m", "second"], tmp.path());
        run(&["checkout", "HEAD~1"], tmp.path());
        assert_eq!(read_branch(tmp.path()), Some("HEAD".into()));
    }

    #[test]
    fn read_branch_returns_none_for_missing_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope");
        assert_eq!(read_branch(&missing), None);
    }

    #[test]
    fn get_git_branch_returns_none_for_unknown_project() {
        let res = get_git_branch("__definitely_not_a_real_project__".into()).unwrap();
        assert_eq!(res, None);
    }
}
