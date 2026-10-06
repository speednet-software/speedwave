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
