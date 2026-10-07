use crate::error::VersionError;
use crate::git::{ensure_git_repo, rev_list_count, run_git};
use crate::release_line::{
    highest_release_minor, parse_release_minor_from_branch_name, stable_tag_for_line,
};
use std::path::Path;

/// Computes the version string for the given branch (or the checked-out
/// branch, or a dev version off a detached `HEAD`, if `None`).
pub fn compute_version(repo: &Path, branch: Option<&str>) -> Result<String, VersionError> {
    compute_version_kind(repo, branch).map(|v| v.to_string())
}

/// Infallible wrapper around [`compute_version`] for build scripts: `0.0.0`
/// plus the error that caused the fallback, never an `Err`.
pub fn resolve_version(repo: &Path, branch: Option<&str>) -> (String, Option<VersionError>) {
    match compute_version(repo, branch) {
        Ok(v) => (v, None),
        Err(e) => ("0.0.0".to_string(), Some(e)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DevVersion {
    base_minor: u64,
    build: u64,
}

impl std::fmt::Display for DevVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "0.{}.0+{}", self.base_minor, self.build)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ReleaseVersion {
    minor: u64,
    patch: u64,
}

impl std::fmt::Display for ReleaseVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "0.{}.{}", self.minor, self.patch)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ComputedVersion {
    Dev(DevVersion),
    Release(ReleaseVersion),
}

impl std::fmt::Display for ComputedVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ComputedVersion::Dev(d) => d.fmt(f),
            ComputedVersion::Release(r) => r.fmt(f),
        }
    }
}

fn enforce_msi_build_limit(n: u64) -> Result<(), VersionError> {
    if n > 65535 {
        return Err(VersionError::BuildNumberExceedsMsiLimit(n));
    }
    Ok(())
}

fn compute_dev_version(repo: &Path) -> Result<DevVersion, VersionError> {
    let m = highest_release_minor(repo)?.unwrap_or(0);
    let build = rev_list_count(repo, "HEAD")?;
    enforce_msi_build_limit(build)?;
    Ok(DevVersion {
        base_minor: m + 1,
        build,
    })
}

fn compute_release_version(repo: &Path, minor: u64) -> Result<ReleaseVersion, VersionError> {
    let tag = stable_tag_for_line(repo, minor)?;
    let patch = rev_list_count(repo, &format!("{tag}..HEAD"))?;
    enforce_msi_build_limit(patch)?;
    Ok(ReleaseVersion { minor, patch })
}

fn compute_version_kind(
    repo: &Path,
    branch: Option<&str>,
) -> Result<ComputedVersion, VersionError> {
    ensure_git_repo(repo)?;
    let resolved_branch = match branch {
        Some(b) => Some(b.to_string()),
        None => match run_git(repo, &["symbolic-ref", "--short", "-q", "HEAD"]) {
            Ok(name) if !name.is_empty() => Some(name),
            _ => None,
        },
    };
    match resolved_branch
        .as_deref()
        .and_then(parse_release_minor_from_branch_name)
    {
        Some(minor) => Ok(ComputedVersion::Release(compute_release_version(
            repo, minor,
        )?)),
        None => Ok(ComputedVersion::Dev(compute_dev_version(repo)?)),
    }
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
    use std::path::PathBuf;

    #[test]
    fn dev_version_base_is_zero_when_no_release_lines_exist() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        commit(tmp.path(), "feat: a");

        let v = compute_dev_version(tmp.path()).expect("compute");
        assert_eq!(v.base_minor, 1);
        assert_eq!(v.build, 2);
    }

    #[test]
    fn dev_version_base_is_highest_local_release_minor_plus_one() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        git(tmp.path(), &["branch", "release/0.20"]);
        git(tmp.path(), &["branch", "release/0.21"]);
        commit(tmp.path(), "feat: a");
        commit(tmp.path(), "feat: b");

        let v = compute_dev_version(tmp.path()).expect("compute");
        assert_eq!(v.base_minor, 22);
        assert_eq!(v.build, 3);
        assert_eq!(v.to_string(), "0.22.0+3");
    }

    #[test]
    fn dev_version_counts_remote_release_branches_too() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        git(
            tmp.path(),
            &["update-ref", "refs/remotes/origin/release/0.25", "HEAD"],
        );
        commit(tmp.path(), "feat: a");

        let v = compute_dev_version(tmp.path()).expect("compute");
        assert_eq!(v.base_minor, 26);
    }

    #[test]
    fn n_is_rev_list_count_from_head_not_from_a_tag() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        git(tmp.path(), &["tag", "v0.20.0"]);
        commit(tmp.path(), "feat: a");
        commit(tmp.path(), "feat: b");
        commit(tmp.path(), "feat: c");

        let v = compute_dev_version(tmp.path()).expect("compute");
        assert_eq!(v.build, 4);
    }

    #[test]
    fn release_line_z_counts_from_the_new_format_build_tag() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        commit(tmp.path(), "feat: a");
        git(tmp.path(), &["tag", "v0.21.0+37"]);
        git(tmp.path(), &["branch", "release/0.21"]);
        git(tmp.path(), &["checkout", "-q", "release/0.21"]);
        commit(tmp.path(), "fix: hotfix one");

        let v = compute_release_version(tmp.path(), 21).expect("compute");
        assert_eq!(
            v,
            ReleaseVersion {
                minor: 21,
                patch: 1
            }
        );
        assert_eq!(v.to_string(), "0.21.1");
    }

    #[test]
    fn release_line_recognizes_the_old_tag_format_without_build_metadata() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        git(tmp.path(), &["tag", "v0.20.0"]);
        git(tmp.path(), &["branch", "release/0.20"]);
        git(tmp.path(), &["checkout", "-q", "release/0.20"]);
        commit(tmp.path(), "fix: hotfix one");
        commit(tmp.path(), "fix: hotfix two");

        let v = compute_release_version(tmp.path(), 20).expect("compute");
        assert_eq!(
            v,
            ReleaseVersion {
                minor: 20,
                patch: 2
            }
        );
    }

    #[test]
    fn release_line_patch_counts_from_the_tag_not_from_a_backport_shifted_merge_base() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        commit(tmp.path(), "feat: a");
        git(tmp.path(), &["tag", "v0.20.0"]);
        git(tmp.path(), &["branch", "release/0.20"]);
        commit(tmp.path(), "feat: b");
        git(tmp.path(), &["checkout", "-q", "release/0.20"]);
        commit(tmp.path(), "fix: hotfix one");
        git(tmp.path(), &["checkout", "-q", "dev"]);
        git(
            tmp.path(),
            &[
                "merge",
                "-q",
                "--no-ff",
                "-X",
                "ours",
                "release/0.20",
                "-m",
                "merge: backport release/0.20 into dev",
            ],
        );
        git(tmp.path(), &["checkout", "-q", "release/0.20"]);
        commit(tmp.path(), "fix: hotfix two");

        let v = compute_release_version(tmp.path(), 20).expect("compute");
        assert_eq!(v.patch, 2);
    }

    #[test]
    fn release_line_with_no_stable_tag_is_a_named_error() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        git(tmp.path(), &["branch", "release/0.21"]);

        let err = compute_release_version(tmp.path(), 21).unwrap_err();
        assert!(matches!(err, VersionError::NoStableTag(21)));
    }

    #[test]
    fn compute_version_dispatches_on_branch_name() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        commit(tmp.path(), "feat: a");
        git(tmp.path(), &["tag", "v0.21.0+2"]);
        git(tmp.path(), &["branch", "release/0.21"]);

        let dev = compute_version_kind(tmp.path(), Some("dev")).expect("dev");
        assert!(matches!(dev, ComputedVersion::Dev(_)));

        let release = compute_version_kind(tmp.path(), Some("release/0.21")).expect("release");
        assert!(matches!(release, ComputedVersion::Release(_)));
    }

    #[test]
    fn compute_version_auto_detects_the_checked_out_branch() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        commit(tmp.path(), "feat: a");
        git(tmp.path(), &["tag", "v0.21.0+2"]);
        git(tmp.path(), &["branch", "release/0.21"]);
        git(tmp.path(), &["checkout", "-q", "release/0.21"]);

        let v = compute_version_kind(tmp.path(), None).expect("compute");
        assert!(matches!(v, ComputedVersion::Release(_)));
    }

    #[test]
    fn detached_head_without_an_explicit_branch_computes_a_dev_version() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        git(tmp.path(), &["branch", "release/0.20"]);
        commit(tmp.path(), "feat: a");
        commit(tmp.path(), "feat: b");
        git(tmp.path(), &["checkout", "-q", "--detach", "HEAD"]);

        let v = compute_version_kind(tmp.path(), None).expect("compute");
        match v {
            ComputedVersion::Dev(d) => {
                assert_eq!(d.base_minor, 21);
                assert_eq!(d.build, 3);
            }
            ComputedVersion::Release(_) => panic!("expected a dev version, got a release one"),
        }
    }

    #[test]
    fn detached_head_with_an_explicit_release_branch_still_computes_release_version() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        git(tmp.path(), &["tag", "v0.21.0"]);
        git(tmp.path(), &["branch", "release/0.21"]);
        commit(tmp.path(), "fix: hotfix");
        git(tmp.path(), &["checkout", "-q", "--detach", "HEAD"]);

        let v = compute_version_kind(tmp.path(), Some("release/0.21")).expect("compute");
        assert!(matches!(v, ComputedVersion::Release(_)));
    }

    #[test]
    fn msi_build_limit_allows_65535() {
        assert!(enforce_msi_build_limit(65535).is_ok());
    }

    #[test]
    fn msi_build_limit_rejects_65536() {
        let err = enforce_msi_build_limit(65536).unwrap_err();
        assert!(matches!(
            err,
            VersionError::BuildNumberExceedsMsiLimit(65536)
        ));
    }

    #[test]
    fn resolve_version_falls_back_to_0_0_0_without_a_git_repository() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let (version, warning) = resolve_version(tmp.path(), None);
        assert_eq!(version, "0.0.0");
        assert!(matches!(warning, Some(VersionError::NotAGitRepository(_))));
    }

    #[test]
    fn compute_version_without_git_is_a_named_error_not_a_silent_default() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let err = compute_version(tmp.path(), None).unwrap_err();
        assert!(matches!(err, VersionError::NotAGitRepository(_)));
    }

    #[test]
    fn nonexistent_repo_path_is_a_named_error() {
        let err = compute_version(&PathBuf::from("/no/such/path/at/all"), None).unwrap_err();
        assert!(matches!(err, VersionError::NotAGitRepository(_)));
    }
}
