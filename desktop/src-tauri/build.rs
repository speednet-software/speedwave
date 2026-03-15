// TODO: Remove this allow and add doc comments to all public items
#![allow(missing_docs)]

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let build_context = manifest_dir.join("build-context");
    let repo_root = manifest_dir
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let allow_stubs = std::env::var_os("SPEEDWAVE_ALLOW_BUNDLE_STUBS").is_some();
    let hash_root = if build_context.join("containers").exists()
        && build_context.join("mcp-servers").exists()
    {
        build_context.clone()
    } else {
        repo_root.clone()
    };

    validate_bundle_resource_declarations(&manifest_dir, &target_os).unwrap();
    speedwave_runtime::bundle::validate_bundled_runtime_assets(&manifest_dir, &target_os, allow_stubs)
        .unwrap();

    let manifest =
        speedwave_runtime::bundle::generate_bundle_manifest(env!("CARGO_PKG_VERSION"), &hash_root)
            .unwrap();
    std::fs::create_dir_all(&build_context).unwrap();
    std::fs::write(
        build_context.join(speedwave_runtime::bundle::BUNDLE_MANIFEST_FILE),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();

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
        repo_root.join("scripts").join("bundle-build-context.sh").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        repo_root.join("scripts").join("build-native-macos.sh").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        repo_root.join("scripts").join("bundle-native-assets.sh").display()
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
}

fn validate_bundle_resource_declarations(manifest_dir: &Path, target_os: &str) -> Result<(), String> {
    let config_name = match target_os {
        "macos" => "tauri.macos.conf.json",
        "linux" => "tauri.linux.conf.json",
        "windows" => "tauri.windows.conf.json",
        other => return Err(format!("unsupported target OS for Tauri resources validation: {other}")),
    };
    let config_path = manifest_dir.join(config_name);
    let raw = std::fs::read_to_string(&config_path)
        .map_err(|err| format!("failed to read {}: {err}", config_path.display()))?;
    let json: Value = serde_json::from_str(&raw)
        .map_err(|err| format!("failed to parse {}: {err}", config_path.display()))?;
    let resources = json
        .get("bundle")
        .and_then(|bundle| bundle.get("resources"))
        .and_then(Value::as_object)
        .ok_or_else(|| format!("bundle.resources missing in {}", config_path.display()))?;

    for asset in speedwave_runtime::bundle::required_bundled_assets(target_os)
        .map_err(|err| err.to_string())?
    {
        if !resource_covers_asset(resources, asset.path) {
            return Err(format!(
                "tauri resource config {} does not declare required asset {}",
                config_path.display(),
                asset.path
            ));
        }
    }

    Ok(())
}

fn resource_covers_asset(resources: &Map<String, Value>, asset_path: &str) -> bool {
    resources.keys().any(|key| {
        let normalized = key.trim_end_matches('/');
        asset_path == normalized || (key.ends_with('/') && asset_path.starts_with(&format!("{normalized}/")))
    })
}
