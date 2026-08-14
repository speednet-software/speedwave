//! Desktop-crate mirror of `crates/speedwave-runtime/tests/prod_data_dir_untouched.rs`.
//! Own-process integration test (a `tests/` binary, not a `#[cfg(test)]` unit
//! test inside `containers_cmd.rs`): catches transitive data-dir leaks that
//! the lexical `no_raw_data_dir_in_tests` scanner cannot. A call like
//! `config::save_user_config()` reads the process-wide `data_dir()`
//! `OnceLock`, which freezes to whatever `SPEEDWAVE_DATA_DIR` resolves to at
//! first touch *in that process*. A source-text scanner sees no literal
//! `~/.speedwave` and passes; a `#[cfg(test)]` unit test would share the
//! `speedwave-desktop` test binary's single process with every other unit
//! test, so some earlier, unrelated test may have already frozen the
//! OnceLock before this one runs, making any isolation assertion meaningless.
//! Only a dedicated `tests/` binary — its own process, unfrozen `OnceLock` —
//! makes "set `SPEEDWAVE_DATA_DIR`, write, inspect the real home directory
//! afterward" a proof rather than a coincidence. This is exactly the class of
//! bug that let `update_llm_config`'s pre-split tests write to a user's real
//! `~/.speedwave/config.json`.

#![expect(
    clippy::expect_used,
    reason = "test file uses expect() only, never unwrap()"
)]

use std::path::PathBuf;
use std::time::SystemTime;

use speedwave_runtime::{config, consts};

/// `SPEEDWAVE_DATA_DIR` basename must match `^[a-z][a-z0-9-]{0,63}$`.
/// `tempfile` basenames start with a dot and mix case, so nest a
/// regex-valid child under an outer tempdir.
fn regex_valid_data_dir() -> (tempfile::TempDir, PathBuf) {
    let outer = tempfile::tempdir().expect("tempdir");
    let child = outer.path().join("speedwave-desktop-prod-untouched");
    std::fs::create_dir(&child).expect("create child data dir");
    (outer, child)
}

/// `None` if the path does not exist (the strongest assertion — production
/// was never created); otherwise `Some(mtime)`.
fn snapshot(path: &std::path::Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok().and_then(|m| m.modified().ok())
}

#[test]
#[serial_test::serial]
fn desktop_llm_save_smoke_does_not_touch_prod_data_dir() {
    let prod = dirs::home_dir().expect("home dir").join(consts::DATA_DIR);

    let before_exists = prod.exists();
    let before_mtime = snapshot(&prod);

    let (_outer, tmp_data_dir) = regex_valid_data_dir();

    // Defense-in-depth: routes any transitive bare-`data_dir()` into the tempdir.
    std::env::set_var(consts::DATA_DIR_ENV, &tmp_data_dir);

    // This is the exact fn that leaked (config::save_user_config, reached
    // transitively by the pre-split `update_llm_config`'s write path).
    // Calling it first in this fresh process proves it respects the env var
    // rather than a `Path`-parameterized twin the leak could route around.
    let cfg = config::SpeedwaveUserConfig::default();
    // SSOT-allow: deliberate bare call — the point of this test is proving it respects SPEEDWAVE_DATA_DIR in a fresh process.
    config::save_user_config(&cfg).expect("save_user_config");

    let saved_path = tmp_data_dir.join("config.json");
    assert!(
        saved_path.is_file(),
        "smoke did not write config.json at {saved_path:?}"
    );

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
