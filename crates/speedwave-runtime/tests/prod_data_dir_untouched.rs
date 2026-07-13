//! Runtime backstop for the static scanner (`no_raw_data_dir_in_tests.rs`): catches *transitive*
//! data-dir leaks. Drives the `_in` variants with an explicit tempdir, never asserts on OnceLock.

#![expect(
    clippy::expect_used,
    reason = "test file uses expect() only, never unwrap()"
)]

use std::path::PathBuf;
use std::time::SystemTime;

use speedwave_runtime::{compose, consts};

/// Minimal compose YAML with a resolvable network ref (`save_compose_in`
/// validates refs in-memory and on read-back).
const VALID_YAML: &str = "version: '3'\nnetworks:\n  default:\n    driver: bridge\nservices:\n  app:\n    image: nginx\n    networks:\n      - default\n";

/// `SPEEDWAVE_DATA_DIR` basename must match `^[a-z][a-z0-9-]{0,63}$` (`derive_instance_name_from`).
/// `tempfile` basenames start with a dot and mix case, so nest a regex-valid child under an outer.
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

    // Record production state before the smoke (missing, or mtime fallback).
    let before_exists = prod.exists();
    let before_mtime = snapshot(&prod);

    let (_outer, tmp_data_dir) = regex_valid_data_dir();

    // Defense-in-depth: routes any transitive bare-`data_dir()` into the tempdir.
    std::env::set_var(consts::DATA_DIR_ENV, &tmp_data_dir);

    // Representative smoke: a data-dir-rooted write plus a path-resolution op.
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

    // Production must be untouched: still absent, or mtime unchanged.
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
