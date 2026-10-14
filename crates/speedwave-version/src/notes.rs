use crate::error::VersionError;
use crate::git::{ensure_git_repo, resolve_branch, rev_list_lines, run_git_is_ancestor};
use crate::release_line::{
    find_release_ref, highest_release_minor_below, parse_release_minor_from_branch_name,
    stable_tag_for_line,
};
use std::path::Path;

/// The stable notes range for a promotion: the previous release line's
/// stable tag to `HEAD`, plus its own hotfix commits to skip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotesRange {
    /// The previous release line's stable tag (exclusive start of the range).
    pub since: String,
    /// Commits on the previous release line since its own stable tag.
    pub skip_commits: Vec<String>,
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

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
mod tests {
    use super::*;
    use crate::git::run_git;
    use crate::test_support::{commit, git, init_repo};

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
}
