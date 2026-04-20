//! Tauri build script — validates bundled assets and generates bundle manifest.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

fn main() {
    if let Err(e) = run() {
        println!("cargo:warning=build.rs failed: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR")?);
    let build_context = manifest_dir.join("build-context");
    let repo_root = manifest_dir
        .parent()
        .ok_or("manifest_dir must have a parent (desktop/)")?
        .parent()
        .ok_or("desktop/ must have a parent (repo root)")?
        .to_path_buf();
    let target_os = std::env::var("CARGO_CFG_TARGET_OS")?;
    let allow_stubs = std::env::var_os("SPEEDWAVE_ALLOW_BUNDLE_STUBS").is_some();
    let hash_root = if build_context.join("containers").exists()
        && build_context.join("mcp-servers").exists()
    {
        build_context.clone()
    } else {
        repo_root.clone()
    };

    validate_bundle_resource_declarations(&manifest_dir, &target_os)?;
    speedwave_runtime::bundle::validate_bundled_runtime_assets(
        &manifest_dir,
        &target_os,
        allow_stubs,
    )?;

    let manifest =
        speedwave_runtime::bundle::generate_bundle_manifest(env!("CARGO_PKG_VERSION"), &hash_root)?;
    std::fs::create_dir_all(&build_context)?;
    let manifest_json = serde_json::to_vec_pretty(&manifest)?;
    std::fs::write(
        build_context.join(speedwave_runtime::bundle::BUNDLE_MANIFEST_FILE),
        manifest_json,
    )?;

    println!(
        "cargo:rerun-if-changed={}",
        repo_root.join("containers").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        repo_root.join("mcp-servers").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        repo_root.join("native").join("macos").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        repo_root
            .join("scripts")
            .join("bundle-build-context.sh")
            .display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        repo_root
            .join("scripts")
            .join("build-native-macos.sh")
            .display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        repo_root
            .join("scripts")
            .join("bundle-native-assets.sh")
            .display()
    );
    println!("cargo:rerun-if-changed={}", build_context.display());
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("tauri.macos.conf.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("tauri.linux.conf.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("tauri.windows.conf.json").display()
    );
    println!("cargo:rerun-if-env-changed=SPEEDWAVE_ALLOW_BUNDLE_STUBS");

    tauri_build::build();
    Ok(())
}

/// Checks that every required bundled asset has a matching entry in the
/// platform-specific Tauri resource configuration.
fn validate_bundle_resource_declarations(
    manifest_dir: &Path,
    target_os: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let config_name = match target_os {
        "macos" => "tauri.macos.conf.json",
        "linux" => "tauri.linux.conf.json",
        "windows" => "tauri.windows.conf.json",
        other => {
            return Err(
                format!("unsupported target OS for Tauri resources validation: {other}").into(),
            )
        }
    };
    let config_path = manifest_dir.join(config_name);
    let raw = std::fs::read_to_string(&config_path)?;
    let json: Value = serde_json::from_str(&raw)?;
    let resources = json
        .get("bundle")
        .and_then(|bundle| bundle.get("resources"))
        .and_then(Value::as_object)
        .ok_or_else(|| format!("bundle.resources missing in {}", config_path.display()))?;

    for asset in speedwave_runtime::bundle::required_bundled_assets(target_os)? {
        if !resource_covers_asset(resources, asset.path) {
            return Err(format!(
                "tauri resource config {} does not declare required asset {}",
                config_path.display(),
                asset.path
            )
            .into());
        }
    }

    Ok(())
}

/// Returns true if any Tauri resource key covers the given asset path
/// (exact match or prefix match for directory-style keys ending with `/`).
fn resource_covers_asset(resources: &Map<String, Value>, asset_path: &str) -> bool {
    resources.keys().any(|key| {
        let normalized = key.trim_end_matches('/');
        asset_path == normalized
            || (key.ends_with('/') && asset_path.starts_with(&format!("{normalized}/")))
    })
}
