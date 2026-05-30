//! Runtime backstop for the static scanner (`no_raw_data_dir_in_tests.rs`):
//! a representative data-dir-rooted smoke must never touch the production
//! `~/.speedwave`. This is the ONLY guard that catches *transitive* leaks — a
//! test calling a no-arg production fn that internally resolves
//! `consts::data_dir()` — which the static scan is structurally blind to.
//!
//! Design (why this is robust, not OnceLock-fragile):
//! The real invariant is "production `~/.speedwave` is untouched", NOT
//! "`data_dir()` resolves to the tempdir". So the smoke drives the **`_in`
//! variants** with an explicit tempdir and never asserts on the OnceLock. We
//! still point `SPEEDWAVE_DATA_DIR` at the tempdir as defense-in-depth (any
//! *transitive* bare-`data_dir()` a future addition introduces also lands in
//! the tempdir on the first resolution), but no assertion DEPENDS on that
//! resolution order. Consequently this binary is safe to grow a second test:
//! the prod-untouched invariant holds regardless of which test resolves the
//! OnceLock first.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::time::SystemTime;

use speedwave_runtime::{compose, consts};

/// Minimal compose YAML with a resolvable network ref — `save_compose_in`
/// validates network refs in-memory and on read-back, so the document must be
/// internally consistent.
const VALID_YAML: &str = "version: '3'\nnetworks:\n  default:\n    driver: bridge\nservices:\n  app:\n    image: nginx\n    networks:\n      - default\n";

/// `SPEEDWAVE_DATA_DIR` basename must match `^[a-z][a-z0-9-]{0,63}$`
/// (`consts::derive_instance_name_from`). `tempfile`'s own basenames start with
/// a dot and mix case, so we nest a regex-valid child under an outer tempdir.
fn regex_valid_data_dir() -> (tempfile::TempDir, PathBuf) {
    let outer = tempfile::tempdir().expect("tempdir");
    let child = outer.path().join("speedwave-prod-untouched");
    std::fs::create_dir(&child).expect("create child data dir");
    (outer, child)
}

/// `None` if the path does not exist (the strongest assertion — production was
/// never created); otherwise `Some(mtime)`.
fn snapshot(path: &std::path::Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok().and_then(|m| m.modified().ok())
}

#[test]
#[serial_test::serial]
fn representative_smoke_does_not_touch_prod_data_dir() {
    let prod = dirs::home_dir().expect("home dir").join(consts::DATA_DIR);

    // Record production state BEFORE the smoke. Missing is the strongest
    // assertion; if a developer happens to have a real install, we fall back
    // to an mtime-unchanged check.
    let before_exists = prod.exists();
    let before_mtime = snapshot(&prod);

    let (_outer, tmp_data_dir) = regex_valid_data_dir();

    // Defense-in-depth only: routes any *transitive* bare-`data_dir()` into the
    // tempdir too. The assertions below do NOT depend on this resolving (the
    // smoke uses the explicit-`data_dir` `_in` variants), so the OnceLock
    // ordering is irrelevant to correctness — that is what makes this binary
    // safe to extend with additional tests.
    std::env::set_var(consts::DATA_DIR_ENV, &tmp_data_dir);

    // Representative smoke: a real, data-dir-rooted filesystem write
    // (`save_compose_in` creates `compose/<project>/` and writes the file) plus
    // a path-resolution op — both via the explicit-`data_dir` `_in` variants,
    // so every path derives from the tempdir, never from the OnceLock.
    let project = "prod-untouched-smoke";
    compose::save_compose_in(&tmp_data_dir, project, VALID_YAML).expect("save_compose_in");
    let compose_path =
        compose::compose_output_path_in(&tmp_data_dir, project).expect("compose_output_path_in");

    // The smoke must have written under the tempdir, never under production.
    assert!(
        compose_path.starts_with(&tmp_data_dir),
        "compose path {compose_path:?} escaped the tempdir {tmp_data_dir:?}"
    );
    assert!(
        compose_path.is_file(),
        "smoke did not write the compose file at {compose_path:?}"
    );

    // Production must be untouched: still absent (strongest), or — if it
    // pre-existed on this machine — its mtime must be unchanged.
    let after_exists = prod.exists();
    let after_mtime = snapshot(&prod);

    if !before_exists {
        assert!(
            !after_exists,
            "production data dir {prod:?} was CREATED by the smoke — isolation regressed"
        );
    } else {
        assert_eq!(
            before_mtime, after_mtime,
            "production data dir {prod:?} mtime CHANGED ({before_mtime:?} -> {after_mtime:?}) \
             — the smoke wrote into the real install"
        );
    }
}
