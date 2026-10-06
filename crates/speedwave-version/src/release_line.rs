use crate::error::VersionError;
use crate::git::run_git;
use std::path::Path;

pub(crate) fn parse_release_minor_from_branch_name(branch: &str) -> Option<u64> {
    branch.strip_prefix("release/0.")?.parse::<u64>().ok()
}

pub(crate) fn highest_release_minor(repo: &Path) -> Result<Option<u64>, VersionError> {
    Ok(list_release_refs(repo)?.into_iter().map(|(m, _)| m).max())
}

pub(crate) fn highest_release_minor_below(
    repo: &Path,
    ceiling: u64,
) -> Result<Option<u64>, VersionError> {
    Ok(list_release_refs(repo)?
        .into_iter()
        .map(|(m, _)| m)
        .filter(|m| *m < ceiling)
        .max())
}

pub(crate) fn find_release_ref(repo: &Path, minor: u64) -> Result<String, VersionError> {
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

pub(crate) fn stable_tag_for_line(repo: &Path, minor: u64) -> Result<String, VersionError> {
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
}
