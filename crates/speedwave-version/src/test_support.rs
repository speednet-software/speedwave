use std::path::Path;

#[expect(
    clippy::expect_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
pub(crate) fn git(dir: &Path, args: &[&str]) {
    let identity: &[&str] = &["-c", "user.name=t", "-c", "user.email=t@t"];
    let with_identity = [identity, args].concat();
    crate::git::run_git(dir, &with_identity).expect("git invocation for test fixture");
}

#[expect(
    clippy::expect_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
pub(crate) fn init_repo() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().expect("tempdir");
    git(tmp.path(), &["init", "-q", "-b", "dev"]);
    tmp
}

#[expect(
    clippy::expect_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
pub(crate) fn commit(dir: &Path, msg: &str) {
    std::fs::write(dir.join("f.txt"), msg).expect("write fixture file");
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", msg]);
}
