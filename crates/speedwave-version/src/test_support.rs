use std::path::Path;

#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
pub(crate) fn git(dir: &Path, args: &[&str]) {
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

#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
pub(crate) fn init_repo() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().expect("tempdir");
    git(tmp.path(), &["init", "-q", "-b", "dev"]);
    tmp
}

#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
pub(crate) fn commit(dir: &Path, msg: &str) {
    std::fs::write(dir.join("f.txt"), msg).expect("write fixture file");
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", msg]);
}
