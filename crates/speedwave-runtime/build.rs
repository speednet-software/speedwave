use std::path::PathBuf;

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string()));
    let repo_root = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .map(PathBuf::from)
        .unwrap_or(manifest_dir);

    let version = std::env::var("SPEEDWAVE_VERSION")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let (version, warning) = speedwave_version::resolve_version(&repo_root, None);
            if let Some(e) = warning {
                println!(
                    "cargo:warning=SPEEDWAVE_VERSION not set and could not compute from git ({e}); defaulting to 0.0.0"
                );
            }
            version
        });

    println!("cargo:rustc-env=SPEEDWAVE_VERSION={version}");
    println!("cargo:rerun-if-env-changed=SPEEDWAVE_VERSION");
}
