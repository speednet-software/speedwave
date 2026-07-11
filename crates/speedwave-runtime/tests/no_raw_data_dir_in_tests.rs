//! Drift detector: test code must never resolve the production data dir via
//! `consts::data_dir()`. Catches only literal tokens; transitive resolution is
//! backstopped by `prod_data_dir_untouched.rs`. Bypass with `// SSOT-allow:`.

#![expect(
    clippy::expect_used,
    reason = "test assertions on setup/mock calls that must not silently fail"
)]

use std::path::{Path, PathBuf};

fn walk_rs(root: &Path, out: &mut Vec<PathBuf>) {
    let dir = match std::fs::read_dir(root) {
        Ok(d) => d,
        Err(_) => return,
    };
    for entry in dir.flatten() {
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

/// The bare-`data_dir()` resolutions forbidden inside test regions, ordered
/// longest-first so a qualified form is reported once, not as a substring.
const PATTERNS: &[&str] = &[
    "speedwave_runtime::consts::data_dir()",
    "crate::consts::data_dir()",
    "consts::data_dir()",
];

/// True when `#[cfg(test)]` / `#[cfg(any(test...` guards a test *module*
/// (the next item is `mod`), not a test-only production helper (`fn`/`pub fn`).
fn cfg_test_guards_a_module(lines: &[&str], cfg_idx: usize) -> bool {
    for l in lines.iter().skip(cfg_idx + 1) {
        let l = l.trim_start();
        if l.is_empty() || l.starts_with("//") || l.starts_with("#[") {
            continue;
        }
        return l.starts_with("mod ")
            || l.starts_with("pub mod ")
            || l.starts_with("pub(crate) mod ");
    }
    false
}

fn is_in_test_module(lines: &[&str], idx: usize) -> bool {
    // Walk backwards for the nearest enclosing test marker.
    for i in (0..idx).rev() {
        let l = lines[i].trim_start();
        if l.starts_with("mod tests") || l.starts_with("#[test]") {
            return true;
        }
        if (l.starts_with("#[cfg(test)]") || l.starts_with("#[cfg(any(test"))
            && cfg_test_guards_a_module(lines, i)
        {
            return true;
        }
        // Closing brace of a sibling top-level item — stop scanning back.
        if l == "}" && lines[i].starts_with('}') {
            return false;
        }
    }
    false
}

/// A file under a `tests/` directory is a cargo integration-test binary: the
/// whole file is test code, so every line is treated as a test region.
fn is_integration_test_file(rel_str: &str) -> bool {
    rel_str.contains("/tests/")
}

fn has_allow_marker(line: &str, prev: Option<&&str>) -> bool {
    line.contains("// SSOT-allow:") || prev.is_some_and(|p| p.contains("// SSOT-allow:"))
}

/// Integration-test binaries that legitimately set `SPEEDWAVE_DATA_DIR` to a
/// tempdir to exercise env-var wiring, plus this detector's own self-exclusion
/// (it carries `consts::data_dir()` in `PATTERNS` as data, not a call).
const ALLOWLISTED_FILES: &[&str] = &[
    "crates/speedwave-runtime/tests/apply_transaction_behaviour.rs",
    "crates/speedwave-runtime/tests/data_dir_integration.rs",
    "crates/speedwave-runtime/tests/no_raw_data_dir_in_tests.rs",
];

#[test]
fn no_raw_data_dir_in_test_regions() {
    let root = manifest_root();
    let crates_root = root.join("crates");
    let desktop_src = root.join("desktop").join("src-tauri").join("src");
    // Integration-test binaries for the Desktop crate: whole-file test code.
    let desktop_tests = root.join("desktop").join("src-tauri").join("tests");

    let mut files = Vec::new();
    walk_rs(&crates_root, &mut files);
    walk_rs(&desktop_src, &mut files);
    walk_rs(&desktop_tests, &mut files);

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
        let whole_file_is_test = is_integration_test_file(&rel_str);
        for (idx, line) in lines.iter().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") {
                continue;
            }
            let prev = if idx > 0 { lines.get(idx - 1) } else { None };
            if has_allow_marker(line, prev) {
                continue;
            }
            if let Some(pat) = PATTERNS.iter().find(|p| line.contains(**p)) {
                // Whole-file test binaries; in `src/` only genuine test regions.
                if whole_file_is_test || is_in_test_module(&lines, idx) {
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
        "found {} bare `data_dir()` call(s) inside test regions — pass an explicit \
         tempdir to the `_in` variant (or add a `// SSOT-allow: <reason>` marker):\n\n{}",
        violations.len(),
        violations.join("\n\n")
    );
}
