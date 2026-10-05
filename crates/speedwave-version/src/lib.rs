//! Computes Speedwave's app version from git state.
//! Dev builds: `0.<M+1>.0+N`. Release-line builds (`release/0.M`): `0.M.Z`.

use std::path::{Path, PathBuf};

/// Errors from computing a version or a notes range against a git repository.
#[derive(Debug, thiserror::Error)]
pub enum VersionError {
    /// A `git` invocation failed (non-zero exit or could not be spawned).
    #[error("git command failed: {0}")]
    GitCommandFailed(String),
    /// The given path is not inside a git working tree.
    #[error("not a git repository: {0}")]
    NotAGitRepository(String),
    /// `HEAD` is detached and no explicit branch was given.
    #[error("HEAD is detached; pass an explicit branch name")]
    DetachedHead,
    /// The current (or given) branch is not a `release/0.*` line.
    #[error("branch '{0}' is not a release/0.* line")]
    NotOnReleaseLine(String),
    /// No stable release tag (`v0.M.0[+N]`) exists for a release line.
    #[error("no stable release tag found for release line 0.{0}")]
    NoStableTag(u64),
    /// More than one stable release tag matches a release line.
    #[error("more than one stable release tag found for release line 0.{0}: {1:?}")]
    AmbiguousStableTag(u64, Vec<String>),
    /// No `release/0.*` branch (local or remote) exists for a given minor.
    #[error("no release/0.{0} branch (local or remote) found")]
    NoReleaseLineMinor(u64),
    /// A promoted commit is an ancestor of the previous release line: the new
    /// stable would be older than the one already shipped.
    #[error(
        "promoted commit {0} is an ancestor of the previous release line 0.{1}: \
         the new stable would be older than the existing one"
    )]
    PromotedCommitIsAncestorOfPreviousLine(String, u64),
    /// No release line exists before the given minor (nothing to compare a
    /// promotion or a notes range against).
    #[error("no release line exists before 0.{0}")]
    NoPreviousReleaseLine(u64),
    /// The build/patch number would exceed WiX's 65535 MSI ceiling.
    #[error("build number {0} exceeds the 65535 MSI ceiling")]
    BuildNumberExceedsMsiLimit(u64),
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

/// The stable notes range for a promotion: the previous release line's
/// stable tag to `HEAD`, plus its own hotfix commits to skip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotesRange {
    /// The previous release line's stable tag (exclusive start of the range).
    pub since: String,
    /// Commits on the previous release line since its own stable tag.
    pub skip_commits: Vec<String>,
}

fn run_git(repo: &Path, args: &[&str]) -> Result<String, VersionError> {
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

fn run_git_is_ancestor(
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

fn ensure_git_repo(repo: &Path) -> Result<(), VersionError> {
    match run_git(repo, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(out) if out == "true" => Ok(()),
        _ => Err(VersionError::NotAGitRepository(repo.display().to_string())),
    }
}

fn resolve_branch(repo: &Path, branch: Option<&str>) -> Result<String, VersionError> {
    if let Some(b) = branch {
        return Ok(b.to_string());
    }
    match run_git(repo, &["symbolic-ref", "--short", "-q", "HEAD"]) {
        Ok(name) if !name.is_empty() => Ok(name),
        _ => Err(VersionError::DetachedHead),
    }
}

fn parse_release_minor_from_branch_name(branch: &str) -> Option<u64> {
    branch.strip_prefix("release/0.")?.parse::<u64>().ok()
}

fn parse_release_minor_from_ref(refname: &str) -> Option<u64> {
    let after = match refname.strip_prefix("refs/heads/release/0.") {
        Some(after) => after,
        None => refname
            .strip_prefix("refs/remotes/")
            .and_then(|rest| rest.split_once('/'))
            .and_then(|(_, rest)| rest.strip_prefix("release/0."))?,
    };
    after.parse::<u64>().ok()
}

fn list_release_refs(repo: &Path) -> Result<Vec<(u64, String)>, VersionError> {
    let out = run_git(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads/release",
            "refs/remotes",
        ],
    )?;
    let mut result = Vec::new();
    for line in out.lines() {
        if let Some(minor) = parse_release_minor_from_ref(line) {
            result.push((minor, line.to_string()));
        }
    }
    Ok(result)
}

fn highest_release_minor(repo: &Path) -> Result<Option<u64>, VersionError> {
    Ok(list_release_refs(repo)?.into_iter().map(|(m, _)| m).max())
}

fn highest_release_minor_below(repo: &Path, ceiling: u64) -> Result<Option<u64>, VersionError> {
    Ok(list_release_refs(repo)?
        .into_iter()
        .map(|(m, _)| m)
        .filter(|m| *m < ceiling)
        .max())
}

fn find_release_ref(repo: &Path, minor: u64) -> Result<String, VersionError> {
    let mut candidates: Vec<String> = list_release_refs(repo)?
        .into_iter()
        .filter(|(m, _)| *m == minor)
        .map(|(_, r)| r)
        .collect();
    candidates.sort_by_key(|r| u8::from(r.starts_with("refs/heads/")));
    candidates
        .into_iter()
        .next()
        .ok_or(VersionError::NoReleaseLineMinor(minor))
}

fn rev_list_count(repo: &Path, revspec: &str) -> Result<u64, VersionError> {
    let out = run_git(repo, &["rev-list", "--count", revspec])?;
    out.parse::<u64>().map_err(|_| {
        VersionError::GitCommandFailed(format!("unparsable rev-list --count output: {out}"))
    })
}

fn rev_list_lines(repo: &Path, revspec: &str) -> Result<Vec<String>, VersionError> {
    let out = run_git(repo, &["rev-list", revspec])?;
    Ok(out
        .lines()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect())
}

fn stable_tag_for_line(repo: &Path, minor: u64) -> Result<String, VersionError> {
    let pattern = format!("v0.{minor}.0*");
    let out = run_git(repo, &["tag", "--list", &pattern])?;
    let prefix = format!("v0.{minor}.0");
    let is_exact_match = |s: &str| -> bool {
        if s == prefix {
            return true;
        }
        match s
            .strip_prefix(&prefix)
            .and_then(|rest| rest.strip_prefix('+'))
        {
            Some(digits) => !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()),
            None => false,
        }
    };
    let matches: Vec<String> = out
        .lines()
        .filter(|l| is_exact_match(l))
        .map(|s| s.to_string())
        .collect();
    match matches.len() {
        0 => Err(VersionError::NoStableTag(minor)),
        1 => matches
            .first()
            .cloned()
            .ok_or(VersionError::NoStableTag(minor)),
        _ => Err(VersionError::AmbiguousStableTag(minor, matches)),
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

fn git_dir_paths(repo: &Path) -> Option<(PathBuf, PathBuf)> {
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

/// Emits `SPEEDWAVE_VERSION` for a build script (env override, else computed
/// from git, else `0.0.0`) plus `cargo:rerun-if-changed` for git HEAD/refs.
#[expect(
    clippy::print_stdout,
    reason = "shared build.rs helper: cargo reads build directives from stdout by convention"
)]
pub fn emit_cargo_version(repo_root: &Path) -> String {
    let version = std::env::var("SPEEDWAVE_VERSION")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let (version, warning) = resolve_version(repo_root, None);
            if let Some(e) = warning {
                println!(
                    "cargo:warning=SPEEDWAVE_VERSION not set and could not compute from git ({e}); defaulting to 0.0.0"
                );
            }
            version
        });

    println!("cargo:rustc-env=SPEEDWAVE_VERSION={version}");
    println!("cargo:rerun-if-env-changed=SPEEDWAVE_VERSION");

    if let Some((git_dir, common_dir)) = git_dir_paths(repo_root) {
        println!("cargo:rerun-if-changed={}", git_dir.join("HEAD").display());
        println!(
            "cargo:rerun-if-changed={}",
            common_dir.join("refs").display()
        );
        let packed_refs = common_dir.join("packed-refs");
        if packed_refs.exists() {
            println!("cargo:rerun-if-changed={}", packed_refs.display());
        }
    }

    version
}

/// Refuses a promotion when `candidate` is an ancestor of the previous
/// release line's tip; a first-ever line always succeeds.
pub fn reject_if_ancestor_of_previous_line(
    repo: &Path,
    candidate: &str,
    new_minor: u64,
) -> Result<(), VersionError> {
    let previous_minor = match highest_release_minor_below(repo, new_minor)? {
        Some(m) => m,
        None => return Ok(()),
    };
    let previous_ref = find_release_ref(repo, previous_minor)?;
    if run_git_is_ancestor(repo, candidate, &previous_ref)? {
        Err(VersionError::PromotedCommitIsAncestorOfPreviousLine(
            candidate.to_string(),
            previous_minor,
        ))
    } else {
        Ok(())
    }
}

/// Computes the stable notes range for a promotion on the given
/// `release/0.M` branch: previous line's stable tag to `HEAD`, plus hotfixes.
pub fn notes_range(repo: &Path, branch: Option<&str>) -> Result<NotesRange, VersionError> {
    ensure_git_repo(repo)?;
    let branch_name = resolve_branch(repo, branch)?;
    let minor = parse_release_minor_from_branch_name(&branch_name)
        .ok_or_else(|| VersionError::NotOnReleaseLine(branch_name.clone()))?;
    let previous_minor = highest_release_minor_below(repo, minor)?
        .ok_or(VersionError::NoPreviousReleaseLine(minor))?;
    let previous_tag = stable_tag_for_line(repo, previous_minor)?;
    let previous_ref = find_release_ref(repo, previous_minor)?;
    let skip_commits = rev_list_lines(repo, &format!("{previous_tag}..{previous_ref}"))?;
    Ok(NotesRange {
        since: previous_tag,
        skip_commits,
    })
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .status()
            .expect("git invocation for test fixture");
        assert!(status.success(), "git {args:?} failed");
    }

    fn init_repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        git(tmp.path(), &["init", "-q", "-b", "dev"]);
        tmp
    }

    fn commit(dir: &Path, msg: &str) {
        std::fs::write(dir.join("f.txt"), msg).expect("write fixture file");
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", msg]);
    }

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
    fn release_line_with_ambiguous_stable_tags_is_a_named_error() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        git(tmp.path(), &["tag", "v0.21.0"]);
        commit(tmp.path(), "feat: a");
        git(tmp.path(), &["tag", "v0.21.0+5"]);

        let err = stable_tag_for_line(tmp.path(), 21).unwrap_err();
        assert!(matches!(err, VersionError::AmbiguousStableTag(21, _)));
    }

    #[test]
    fn parse_release_minor_from_ref_rejects_a_prefixed_branch_name() {
        assert_eq!(
            parse_release_minor_from_ref("refs/heads/release/0.21"),
            Some(21)
        );
        assert_eq!(
            parse_release_minor_from_ref("refs/remotes/origin/release/0.21"),
            Some(21)
        );
        assert_eq!(
            parse_release_minor_from_ref("refs/heads/x-release/0.99"),
            None
        );
        assert_eq!(
            parse_release_minor_from_ref("refs/remotes/origin/x-release/0.99"),
            None
        );
    }

    #[test]
    fn find_release_ref_prefers_the_remote_tracking_ref_over_a_local_branch() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        git(tmp.path(), &["branch", "release/0.20"]);
        git(
            tmp.path(),
            &["update-ref", "refs/remotes/origin/release/0.20", "HEAD"],
        );

        let found = find_release_ref(tmp.path(), 20).expect("found");
        assert_eq!(found, "refs/remotes/origin/release/0.20");
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
    fn promotion_is_rejected_when_candidate_is_an_ancestor_of_the_previous_line() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        commit(tmp.path(), "feat: a");
        let old_commit = run_git(tmp.path(), &["rev-parse", "HEAD"]).expect("rev-parse");
        git(tmp.path(), &["tag", "v0.20.0"]);
        git(tmp.path(), &["branch", "release/0.20"]);
        commit(tmp.path(), "feat: b");

        let err = reject_if_ancestor_of_previous_line(tmp.path(), &old_commit, 21).unwrap_err();
        assert!(matches!(
            err,
            VersionError::PromotedCommitIsAncestorOfPreviousLine(_, 20)
        ));
    }

    #[test]
    fn promotion_succeeds_when_candidate_is_ahead_of_the_previous_line() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        git(tmp.path(), &["tag", "v0.20.0"]);
        git(tmp.path(), &["branch", "release/0.20"]);
        commit(tmp.path(), "feat: a");
        let new_commit = run_git(tmp.path(), &["rev-parse", "HEAD"]).expect("rev-parse");

        reject_if_ancestor_of_previous_line(tmp.path(), &new_commit, 21).expect("not an ancestor");
    }

    #[test]
    fn promotion_of_the_first_ever_line_has_nothing_to_reject_against() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        let head = run_git(tmp.path(), &["rev-parse", "HEAD"]).expect("rev-parse");

        reject_if_ancestor_of_previous_line(tmp.path(), &head, 20).expect("no previous line");
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
    fn notes_range_spans_from_the_previous_lines_stable_tag_and_lists_its_hotfixes() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        commit(tmp.path(), "feat: a");
        git(tmp.path(), &["tag", "v0.20.0"]);
        git(tmp.path(), &["branch", "release/0.20"]);
        git(tmp.path(), &["checkout", "-q", "release/0.20"]);
        commit(tmp.path(), "fix: hotfix one");
        let hotfix_sha = run_git(tmp.path(), &["rev-parse", "HEAD"]).expect("rev-parse");
        git(tmp.path(), &["checkout", "-q", "dev"]);
        commit(tmp.path(), "feat: b");
        git(tmp.path(), &["tag", "v0.21.0+3"]);
        git(tmp.path(), &["branch", "release/0.21"]);
        git(tmp.path(), &["checkout", "-q", "release/0.21"]);

        let range = notes_range(tmp.path(), None).expect("notes range");
        assert_eq!(range.since, "v0.20.0");
        assert_eq!(range.skip_commits, vec![hotfix_sha]);
    }

    #[test]
    fn notes_range_on_the_first_ever_line_is_a_named_error() {
        let tmp = init_repo();
        commit(tmp.path(), "init");
        git(tmp.path(), &["tag", "v0.20.0"]);
        git(tmp.path(), &["branch", "release/0.20"]);
        git(tmp.path(), &["checkout", "-q", "release/0.20"]);

        let err = notes_range(tmp.path(), None).unwrap_err();
        assert!(matches!(err, VersionError::NoPreviousReleaseLine(20)));
    }

    #[test]
    fn notes_range_off_a_non_release_branch_is_a_named_error() {
        let tmp = init_repo();
        commit(tmp.path(), "init");

        let err = notes_range(tmp.path(), Some("dev")).unwrap_err();
        assert!(matches!(err, VersionError::NotOnReleaseLine(_)));
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

    #[test]
    fn emit_cargo_version_returns_the_env_override_without_touching_git() {
        let tmp = tempfile::tempdir().expect("tempdir");
        std::env::set_var("SPEEDWAVE_VERSION", "9.9.9");
        let version = emit_cargo_version(tmp.path());
        std::env::remove_var("SPEEDWAVE_VERSION");
        assert_eq!(version, "9.9.9");
    }
}
