//! The `main` window's capability must grant every native window setter or action the
//! Angular UI calls through `getCurrentWindow()`; getters come with `core:window:default`.

#![expect(
    clippy::unwrap_used,
    reason = "test file, a failed read aborts the test"
)]

use std::path::{Path, PathBuf};

const WINDOW_ACTIONS: &[&str] = &[
    "center",
    "close",
    "destroy",
    "hide",
    "maximize",
    "minimize",
    "requestUserAttention",
    "show",
    "startDragging",
    "startResizeDragging",
    "toggleMaximize",
    "unmaximize",
    "unminimize",
];

fn collect_ts_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name != "node_modules") {
                collect_ts_sources(&path, out);
            }
        } else if path.extension().is_some_and(|ext| ext == "ts")
            && !path.to_string_lossy().ends_with(".spec.ts")
        {
            out.push(path);
        }
    }
}

fn window_calls(source: &str) -> Vec<String> {
    const CALL: &str = "getCurrentWindow().";
    source
        .match_indices(CALL)
        .filter_map(|(at, _)| {
            let rest = &source[at + CALL.len()..];
            let method: String = rest
                .chars()
                .take_while(char::is_ascii_alphanumeric)
                .collect();
            rest[method.len()..].starts_with('(').then_some(method)
        })
        .collect()
}

fn kebab_case(method: &str) -> String {
    let mut out = String::with_capacity(method.len() + 4);
    for c in method.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn needs_explicit_permission(method: &str) -> bool {
    method.starts_with("set") || WINDOW_ACTIONS.contains(&method)
}

#[test]
fn kebab_case_matches_tauri_permission_names() {
    assert_eq!(kebab_case("setTheme"), "set-theme");
    assert_eq!(kebab_case("startResizeDragging"), "start-resize-dragging");
    assert_eq!(kebab_case("close"), "close");
}

#[test]
fn window_calls_reads_only_invoked_methods() {
    let source = "a.then(() => getCurrentWindow().setTheme(mode)); getCurrentWindow().label;";
    assert_eq!(window_calls(source), vec!["setTheme".to_string()]);
    assert!(window_calls("no window api here").is_empty());
}

#[test]
fn main_window_capability_grants_every_window_setter_the_ui_calls() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let raw = std::fs::read_to_string(manifest.join("capabilities").join("default.json")).unwrap();
    let capability: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(serde_json::Value::as_str)
        .collect();

    let mut sources = Vec::new();
    collect_ts_sources(&manifest.join("..").join("src").join("src"), &mut sources);
    let mut calls = Vec::new();
    for file in &sources {
        let text = std::fs::read_to_string(file).unwrap();
        for method in window_calls(&text) {
            calls.push((file.clone(), method));
        }
    }
    assert!(
        calls.iter().any(|(_, method)| method == "setTheme"),
        "the scan must see NativeThemeAdapter's setTheme call; found {calls:?}"
    );

    let missing: Vec<String> = calls
        .iter()
        .filter(|(_, method)| needs_explicit_permission(method))
        .map(|(file, method)| (file, format!("core:window:allow-{}", kebab_case(method))))
        .filter(|(_, permission)| !granted.contains(&permission.as_str()))
        .map(|(file, permission)| format!("{}: {permission}", file.display()))
        .collect();
    assert!(
        missing.is_empty(),
        "capabilities/default.json must grant these window calls: {missing:?}"
    );
}
