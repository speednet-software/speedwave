use crate::error::VersionError;
use std::path::{Path, PathBuf};

pub(crate) fn run_git(repo: &Path, args: &[&str]) -> Result<String, VersionError> {
    // SSOT-allow: standalone build-dependency crate, no path to speedwave-runtime's spawn SSOT; shells out to git directly (SPEED-734).
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| VersionError::GitCommandFailed(format!("{args:?}: {e}")))?;
    if !output.status.success() {
        return Err(VersionError::GitCommandFailed(format!(
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) fn run_git_is_ancestor(
    repo: &Path,
    candidate: &str,
    ancestor_of: &str,
) -> Result<bool, VersionError> {
    let args = ["merge-base", "--is-ancestor", candidate, ancestor_of];
    // SSOT-allow: see run_git, same standalone-crate rationale.
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| VersionError::GitCommandFailed(format!("{args:?}: {e}")))?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(VersionError::GitCommandFailed(format!(
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))),
    }
}

pub(crate) fn ensure_git_repo(repo: &Path) -> Result<(), VersionError> {
    match run_git(repo, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(out) if out == "true" => Ok(()),
        _ => Err(VersionError::NotAGitRepository(repo.display().to_string())),
    }
}

pub(crate) fn resolve_branch(repo: &Path, branch: Option<&str>) -> Result<String, VersionError> {
    if let Some(b) = branch {
        return Ok(b.to_string());
    }
    match run_git(repo, &["symbolic-ref", "--short", "-q", "HEAD"]) {
        Ok(name) if !name.is_empty() => Ok(name),
        _ => Err(VersionError::DetachedHead),
    }
}

pub(crate) fn rev_list_count(repo: &Path, revspec: &str) -> Result<u64, VersionError> {
    let out = run_git(repo, &["rev-list", "--count", revspec])?;
    out.parse::<u64>().map_err(|_| {
        VersionError::GitCommandFailed(format!("unparsable rev-list --count output: {out}"))
    })
}

pub(crate) fn rev_list_lines(repo: &Path, revspec: &str) -> Result<Vec<String>, VersionError> {
    let out = run_git(repo, &["rev-list", revspec])?;
    Ok(out
        .lines()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect())
}

pub(crate) fn git_dir_paths(repo: &Path) -> Option<(PathBuf, PathBuf)> {
    let git_dir = run_git(repo, &["rev-parse", "--git-dir"]).ok()?;
    let common_dir = run_git(repo, &["rev-parse", "--git-common-dir"]).ok()?;
    let resolve = |raw: String| -> PathBuf {
        let p = PathBuf::from(raw);
        if p.is_absolute() {
            p
        } else {
            repo.join(p)
        }
    };
    Some((resolve(git_dir), resolve(common_dir)))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
mod tests {
    use super::*;
    use crate::test_support::{commit, git, init_repo};

    #[test]
    fn git_dir_paths_resolves_a_plain_repo() {
        let tmp = init_repo();
        commit(tmp.path(), "init");

        let (git_dir, common_dir) = git_dir_paths(tmp.path()).expect("resolved");
        assert_eq!(git_dir, tmp.path().join(".git"));
        assert_eq!(common_dir, tmp.path().join(".git"));
    }

    #[test]
    fn git_dir_paths_resolves_a_worktree_to_the_shared_common_dir() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        let worktree_dir = tmp.path().join("wt");
        git(
            tmp.path(),
            &[
                "worktree",
                "add",
                "--no-track",
                "-b",
                "wt-branch",
                worktree_dir.to_str().expect("utf8 path"),
            ],
        );

        let (git_dir, common_dir) = git_dir_paths(&worktree_dir).expect("resolved");
        let canonical = |p: &Path| std::fs::canonicalize(p).expect("canonicalize");
        let main_git_dir = canonical(&tmp.path().join(".git"));
        assert_eq!(canonical(&common_dir), main_git_dir);
        assert!(canonical(&git_dir).starts_with(main_git_dir.join("worktrees")));
        assert_ne!(canonical(&git_dir), canonical(&common_dir));
    }

    #[test]
    fn git_dir_paths_is_none_without_a_git_repository() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(git_dir_paths(tmp.path()).is_none());
    }
}
