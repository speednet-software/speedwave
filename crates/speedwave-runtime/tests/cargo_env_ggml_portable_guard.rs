//! Guards the portable ggml CPU baseline (ADR-093): the forced `.cargo/config.toml`
//! `[env]` pin `GGML_NATIVE = "OFF"`, no `GGML_*` override in the config or the CI
//! files, the desktop-bundle Rust cache key derived from the config, and the audited
//! whisper-rs-sys version whose build script forwards `GGML_*` to CMake.

#![expect(
    clippy::expect_used,
    reason = "test file uses expect() only, never unwrap()"
)]

use std::path::{Path, PathBuf};

const AUDITED_WHISPER_RS_SYS: &str = "0.15.0";

const DESKTOP_BUNDLE_CACHE_KEY: &str =
    "rust-cache-shared-key: desktop-bundle-${{ hashFiles('.cargo/config.toml') }}";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root resolves")
}

fn read_repo_file(rel: &str) -> String {
    std::fs::read_to_string(repo_root().join(rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

#[test]
fn cargo_config_pins_ggml_native_off() {
    let content = read_repo_file(".cargo/config.toml");
    assert!(
        content
            .lines()
            .any(|l| l.trim().replace(' ', "") == "GGML_NATIVE={value=\"OFF\",force=true}"),
        ".cargo/config.toml [env] must set GGML_NATIVE = {{ value = \"OFF\", force = true }} so \
         ggml targets a portable CPU baseline instead of the build machine's CPU, even when \
         the environment exports GGML_NATIVE"
    );
}

#[test]
fn cargo_config_does_not_reenable_avx512() {
    let content = read_repo_file(".cargo/config.toml");
    assert!(
        !content
            .lines()
            .map(str::trim)
            .filter(|l| !l.starts_with('#'))
            .any(|l| l.starts_with("GGML_AVX512")),
        ".cargo/config.toml must not set GGML_AVX512*: the binary has no runtime CPU dispatch \
         for ggml"
    );
}

#[test]
fn build_env_carries_ggml_native_off() {
    assert_eq!(
        std::env::var("GGML_NATIVE").as_deref(),
        Ok("OFF"),
        "GGML_NATIVE must be OFF in the cargo environment"
    );
}

#[test]
fn ci_files_set_no_ggml_variable() {
    let github = repo_root().join(".github");
    let mut files = Vec::new();
    for dir in ["workflows", "actions"] {
        let mut stack = vec![github.join(dir)];
        while let Some(path) = stack.pop() {
            if path.is_dir() {
                for entry in std::fs::read_dir(&path).expect("read .github dir") {
                    stack.push(entry.expect("dir entry").path());
                }
            } else if path
                .extension()
                .is_some_and(|ext| ext == "yml" || ext == "yaml")
            {
                files.push(path);
            }
        }
    }
    assert!(!files.is_empty(), "no workflow files found under .github");
    let offenders: Vec<_> = files
        .iter()
        .filter(|f| {
            std::fs::read_to_string(f)
                .expect("read workflow file")
                .contains("GGML_")
        })
        .collect();
    assert!(
        offenders.is_empty(),
        "CI files must not set GGML_* (whisper-rs-sys forwards every GGML_* env var to CMake; \
         ADR-093): {offenders:?}"
    );
}

#[test]
fn desktop_bundle_cache_key_hashes_cargo_config() {
    for workflow in [
        ".github/workflows/lane-build.yml",
        ".github/workflows/build-publish.yml",
    ] {
        assert!(
            read_repo_file(workflow)
                .lines()
                .any(|l| l.trim() == DESKTOP_BUNDLE_CACHE_KEY),
            "{workflow} must pass `{DESKTOP_BUNDLE_CACHE_KEY}` to setup-toolchain so a GGML_* \
             change in .cargo/config.toml never restores old ggml objects (ADR-093)"
        );
    }
}

#[test]
fn whisper_rs_sys_is_the_audited_version() {
    for lockfile in ["Cargo.lock", "desktop/src-tauri/Cargo.lock"] {
        let content = read_repo_file(lockfile);
        let version = content
            .split("[[package]]")
            .find(|pkg| pkg.contains("name = \"whisper-rs-sys\""))
            .and_then(|pkg| {
                pkg.lines()
                    .find_map(|l| l.trim().strip_prefix("version = "))
                    .map(|v| v.trim_matches('"').to_owned())
            })
            .expect("whisper-rs-sys is in the lockfile");
        assert_eq!(
            version, AUDITED_WHISPER_RS_SYS,
            "{lockfile}: whisper-rs-sys changed. Check that its build.rs still forwards GGML_* \
             env vars to CMake and sets no GGML_NATIVE itself, then update \
             AUDITED_WHISPER_RS_SYS and ADR-093's footnotes"
        );
    }
}
