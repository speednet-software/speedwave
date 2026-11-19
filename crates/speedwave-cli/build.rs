//! Build script: emits `SPEEDWAVE_VERSION` and `SPEEDWAVE_UPDATER_PUBKEY` for the crate.

use std::path::{Path, PathBuf};

const TAURI_CONF: &str = "desktop/src-tauri/tauri.conf.json";

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string()));
    let repo_root = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .map(PathBuf::from)
        .unwrap_or(manifest_dir);

    speedwave_version::emit_cargo_version(&repo_root);
    emit_updater_pubkey(&repo_root.join(TAURI_CONF));
}

fn emit_updater_pubkey(conf_path: &Path) {
    let pubkey = read_updater_pubkey(conf_path);
    println!("cargo:rustc-env=SPEEDWAVE_UPDATER_PUBKEY={pubkey}");
    println!("cargo:rerun-if-changed={}", conf_path.display());
}

fn read_updater_pubkey(conf_path: &Path) -> String {
    let text = std::fs::read_to_string(conf_path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", conf_path.display()));
    let conf: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", conf_path.display()));
    match conf["plugins"]["updater"]["pubkey"].as_str() {
        Some(pubkey) if !pubkey.trim().is_empty() => pubkey.trim().to_string(),
        _ => panic!("{} has no plugins.updater.pubkey", conf_path.display()),
    }
}
