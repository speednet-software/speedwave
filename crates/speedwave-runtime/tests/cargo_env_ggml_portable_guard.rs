//! Guards the `.cargo/config.toml` `[env]` pin `GGML_NATIVE = "OFF"` (ADR-093).

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
fn cargo_config_pins_ggml_native_off() {
    let content = std::fs::read_to_string(repo_root().join(".cargo/config.toml"))
        .expect(".cargo/config.toml must be committed");
    assert!(
        content
            .lines()
            .any(|l| l.trim().replace(' ', "") == "GGML_NATIVE=\"OFF\""),
        ".cargo/config.toml [env] must set GGML_NATIVE = \"OFF\" so ggml targets a portable \
         CPU baseline instead of the build runner's CPU"
    );
}

#[test]
fn cargo_config_does_not_reenable_avx512() {
    let content = std::fs::read_to_string(repo_root().join(".cargo/config.toml"))
        .expect(".cargo/config.toml must be committed");
    assert!(
        !content
            .lines()
            .map(str::trim)
            .filter(|l| !l.starts_with('#'))
            .any(|l| l.starts_with("GGML_AVX512")),
        "GGML_AVX512* must not be set: the binary has no runtime CPU dispatch for ggml"
    );
}

#[test]
fn build_env_carries_ggml_native_off() {
    assert_eq!(
        std::env::var("GGML_NATIVE").as_deref(),
        Ok("OFF"),
        "GGML_NATIVE must be OFF in the cargo environment (check for a shell or CI override)"
    );
}
