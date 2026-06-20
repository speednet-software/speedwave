//! Drift detector: production code must channel bind addresses through
//! `compose::host_bind_address()`. Bypass with `// SSOT-allow: <reason>`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};

fn walk_rs(root: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(root).expect("read_dir").flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if name == "target" || name.starts_with(".") {
                continue;
            }
            walk_rs(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

fn manifest_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
        .parent()
        .expect("repo root")
        .to_path_buf()
}

/// Lines containing one of these substrings, or a `// SSOT-allow:` marker on
/// the same or previous line, are exempt. Production code outside these
/// allowlists must use `host_bind_address()`.
const PATTERNS: &[&str] = &[
    "TcpListener::bind(\"127.0.0.1",
    "TcpListener::bind((\"127.0.0.1",
    "TcpListener::bind(\"localhost",
    "[127, 0, 0, 1]",
    "Ipv4Addr::LOCALHOST",
    "SocketAddr::from(([127",
];

fn is_in_test_module(lines: &[&str], idx: usize) -> bool {
    // Walk backwards looking for `mod tests {` / `#[cfg(test)] mod` / `#[test]`.
    for i in (0..idx).rev() {
        let l = lines[i].trim_start();
        if l.starts_with("mod tests")
            || l.starts_with("#[cfg(test)]")
            || l.starts_with("#[test]")
            || l.starts_with("#[cfg(any(test")
        {
            return true;
        }
        // Closing brace of a sibling top-level item — stop scanning back.
        if l == "}" && lines[i].starts_with('}') {
            // Top-level close before any test marker: not test code.
            return false;
        }
    }
    false
}

fn has_allow_marker(line: &str, prev: Option<&&str>) -> bool {
    line.contains("// SSOT-allow:") || prev.is_some_and(|p| p.contains("// SSOT-allow:"))
}

/// Files known to bind/connect loopback for legitimate host-internal reasons
/// (upstream IDE WebSocket, plugin local-UI URL, etc.). Reviewed at landing
/// time; new entries require justification in the PR.
const ALLOWLISTED_FILES: &[&str] = &[
    // Host→host: WS URL Tauri uses to dial the external IDE (VSCode/Cursor).
    "desktop/src-tauri/src/bridges/ide_bridge.rs",
    // Host→host: local UI URL returned to the Angular webview.
    "desktop/src-tauri/src/bridges/plugin_host_bridge.rs",
    // SSRF policy + URL validators — match loopback literals, not bind.
    "desktop/src-tauri/src/url_validation.rs",
    "desktop/src-tauri/src/http_util.rs",
    "desktop/src-tauri/src/llm_cmd.rs",
    // External-IDE discovery: probes loopback for VSCode/Cursor sentinel files.
    "desktop/src-tauri/src/health.rs",
    // E2E WebDriver listener is host-internal (`feature = "e2e"`).
    "desktop/src-tauri/src/main.rs",
];

#[test]
fn no_hardcoded_loopback_bind_outside_tests() {
    let root = manifest_root();
    let crate_src = root.join("crates").join("speedwave-runtime").join("src");
    let desktop_src = root.join("desktop").join("src-tauri").join("src");

    let mut files = Vec::new();
    walk_rs(&crate_src, &mut files);
    walk_rs(&desktop_src, &mut files);

    let mut violations: Vec<String> = Vec::new();
    for file in &files {
        let rel = file.strip_prefix(&root).unwrap_or(file);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if ALLOWLISTED_FILES.iter().any(|f| rel_str == *f) {
            continue;
        }
        let content = match std::fs::read_to_string(file) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let lines: Vec<&str> = content.lines().collect();
        for (idx, line) in lines.iter().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") || trimmed.starts_with("///") {
                continue;
            }
            let prev = if idx > 0 { lines.get(idx - 1) } else { None };
            if has_allow_marker(line, prev) {
                continue;
            }
            for pat in PATTERNS {
                if line.contains(pat) && !is_in_test_module(&lines, idx) {
                    violations.push(format!(
                        "{}:{}: matches {pat:?}\n  > {}",
                        rel.display(),
                        idx + 1,
                        line.trim_end()
                    ));
                }
            }
        }
    }

    assert!(
        violations.is_empty(),
        "found {} hardcoded loopback bind/connect sites in production code — \
         channel through compose::host_bind_address() or add a `// SSOT-allow: <reason>` marker:\n\n{}",
        violations.len(),
        violations.join("\n\n")
    );
}
