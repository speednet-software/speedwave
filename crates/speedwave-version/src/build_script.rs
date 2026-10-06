use crate::git::git_dir_paths;
use crate::version::resolve_version;
use std::path::Path;

/// Emits `SPEEDWAVE_VERSION` for a build script (env override, else computed
/// from git, else `0.0.0`) plus `cargo:rerun-if-changed` for git HEAD/refs.
#[expect(
    clippy::print_stdout,
    reason = "shared build.rs helper: cargo reads build directives from stdout by convention"
)]
pub fn emit_cargo_version(repo_root: &Path) -> String {
    let version = std::env::var("SPEEDWAVE_VERSION")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let (version, warning) = resolve_version(repo_root, None);
            if let Some(e) = warning {
                println!(
                    "cargo:warning=SPEEDWAVE_VERSION not set and could not compute from git ({e}); defaulting to 0.0.0"
                );
            }
            version
        });

    println!("cargo:rustc-env=SPEEDWAVE_VERSION={version}");
    println!("cargo:rerun-if-env-changed=SPEEDWAVE_VERSION");

    if let Some((git_dir, common_dir)) = git_dir_paths(repo_root) {
        println!("cargo:rerun-if-changed={}", git_dir.join("HEAD").display());
        println!(
            "cargo:rerun-if-changed={}",
            common_dir.join("refs").display()
        );
        let packed_refs = common_dir.join("packed-refs");
        if packed_refs.exists() {
            println!("cargo:rerun-if-changed={}", packed_refs.display());
        }
    }

    version
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test code: panics on failure are acceptable assertions"
)]
mod tests {
    use super::*;

    #[test]
    fn emit_cargo_version_returns_the_env_override_without_touching_git() {
        let tmp = tempfile::tempdir().expect("tempdir");
        std::env::set_var("SPEEDWAVE_VERSION", "9.9.9");
        let version = emit_cargo_version(tmp.path());
        std::env::remove_var("SPEEDWAVE_VERSION");
        assert_eq!(version, "9.9.9");
    }
}
