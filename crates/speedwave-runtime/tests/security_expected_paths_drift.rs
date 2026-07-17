//! Drift detector: every `SecurityExpectedPaths::compute` call site must chain
//! `.with_telemetry_locked(...)` or the MDM mount requirement silently degrades.

#![expect(clippy::expect_used, reason = "test code")]

use std::path::{Path, PathBuf};

const SCAN_ROOTS: &[&str] = &[
    "crates/speedwave-runtime/src",
    "crates/speedwave-cli/src",
    "desktop/src-tauri/src",
];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root resolves")
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("readable source dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn every_compute_call_site_chains_with_telemetry_locked() {
    let root = repo_root();
    let mut files = Vec::new();
    for scan in SCAN_ROOTS {
        rust_files(&root.join(scan), &mut files);
    }
    assert!(
        files.len() > 50,
        "scan roots look wrong: {} files",
        files.len()
    );

    let mut violations = Vec::new();
    for file in &files {
        let src = std::fs::read_to_string(file).expect("readable rust file");
        let mut from = 0;
        while let Some(pos) = src[from..].find("SecurityExpectedPaths::compute(") {
            let abs = from + pos;
            from = abs + 1;
            let line_start = src[..abs].rfind('\n').map_or(0, |i| i + 1);
            let prev_line_start = src[..line_start.saturating_sub(1)]
                .rfind('\n')
                .map_or(0, |i| i + 1);
            if src[prev_line_start..line_start].contains("// SSOT-allow:") {
                continue;
            }
            let tail_end = (abs + 300).min(src.len());
            if !src[abs..tail_end].contains(".with_telemetry_locked(") {
                let line_no = src[..abs].lines().count();
                violations.push(format!("{}:{line_no}", file.display()));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "SecurityExpectedPaths::compute without .with_telemetry_locked (add the chain, \
         or a preceding `// SSOT-allow: <reason>` line):\n{}",
        violations.join("\n")
    );
}
