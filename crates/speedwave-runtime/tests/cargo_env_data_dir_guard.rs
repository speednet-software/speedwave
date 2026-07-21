//! Guards the repo-level `.cargo/config.toml` `[env]` safety net: bare `cargo test`
//! must never resolve `consts::data_dir()` to the real `~/.speedwave`.

#![expect(
    clippy::expect_used,
    reason = "test file uses expect() only, never unwrap()"
)]

use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root resolves")
}

#[test]
fn cargo_env_guard_config_is_committed_and_pins_the_env() {
    let config = repo_root().join(".cargo/config.toml");
    let content = std::fs::read_to_string(&config)
        .expect(".cargo/config.toml must be committed — it is the bare-`cargo test` safety net");
    assert!(
        content.contains("SPEEDWAVE_DATA_DIR"),
        "config must set SPEEDWAVE_DATA_DIR under [env]"
    );
    assert!(
        content.contains("relative = true"),
        "value must be relative=true so cargo resolves it absolute per-worktree"
    );
    assert!(
        !content.contains("force = true"),
        "force must stay false so Makefile/e2e exports keep precedence"
    );
}

#[test]
fn gitignore_does_not_reignore_the_cargo_env_guard() {
    let gitignore =
        std::fs::read_to_string(repo_root().join(".gitignore")).expect(".gitignore readable");
    assert!(
        !gitignore.lines().any(|l| l.trim() == ".cargo/config.toml"),
        "re-ignoring .cargo/config.toml would silently drop the bare-cargo data-dir guard"
    );
}

#[test]
fn test_process_receives_a_safe_data_dir() {
    let val = std::env::var("SPEEDWAVE_DATA_DIR")
        .expect("SPEEDWAVE_DATA_DIR must reach test binaries (cargo [env] or Makefile export)");
    assert!(!val.trim().is_empty(), "empty-but-set resolves to prod");
    let path = PathBuf::from(&val);
    assert!(path.is_absolute(), "data_dir_from panics on relative paths");
    let basename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    assert_ne!(
        basename, ".speedwave",
        "test process pointed at the production data dir"
    );
}
