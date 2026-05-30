//! Drift detector: test code must never resolve the production data dir via
//! `consts::data_dir()`. Tests pass an explicit tempdir to the `_in` variants
//! (or set `SPEEDWAVE_DATA_DIR` to a tempdir in a dedicated integration binary).
//! Bypass an individual line with `// SSOT-allow: <reason>`.
//!
//! KNOWN LIMITATION (cannot be fixed statically): this scanner only catches a
//! *literal* `consts::data_dir()` token inside test code. It cannot catch
//! TRANSITIVE resolution — a test that calls a no-arg production fn (e.g.
//! `compose::init_secrets_dir(project)`) which internally resolves
//! `consts::data_dir()`. The runtime guard `prod_data_dir_untouched.rs` is the
//! backstop for those cases: it env-isolates the data dir and asserts the real
//! `~/.speedwave` is untouched after a representative smoke, catching transitive
//! leaks this static scan is blind to.

#![allow(clippy::unwrap_used, clippy::expect_used)]

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

/// The bare-`data_dir()` resolutions forbidden inside test regions. Each is the
/// production OnceLock-backed singleton that maps to the real `~/.speedwave`.
/// Ordered longest-first so a qualified form (`crate::consts::…`) is reported
/// once, not also as the `consts::…` substring it contains.
const PATTERNS: &[&str] = &[
    "speedwave_runtime::consts::data_dir()",
    "crate::consts::data_dir()",
    "consts::data_dir()",
];

/// True when `#[cfg(test)]` / `#[cfg(any(test...` guards a test *module*
/// (the next item is `mod`), not a test-only production helper (`fn`/`pub fn`).
/// A `data_dir()` call in a `#[cfg(test)]`-gated *helper* runs in
/// production-shaped code and is legitimate; one inside `mod tests` is not.
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
    // Walk backwards for the nearest enclosing test marker: `mod tests {`,
    // `#[test]`, or a `#[cfg(test)]` that guards a `mod` (not a helper fn).
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

/// A file living under a `tests/` directory is a cargo *integration-test
/// binary*: the WHOLE file is test code (there is no production codepath in an
/// integration binary). A bare `data_dir()` in a free helper fn there — not
/// only under `#[test]`/`mod tests` — still runs in the test process and can
/// touch the real `~/.speedwave`. So for these files we treat any line as a
/// test region and rely solely on the comment / `// SSOT-allow:` filters.
fn is_integration_test_file(rel_str: &str) -> bool {
    rel_str.contains("/tests/")
}

fn has_allow_marker(line: &str, prev: Option<&&str>) -> bool {
    line.contains("// SSOT-allow:") || prev.is_some_and(|p| p.contains("// SSOT-allow:"))
}

/// Integration-test binaries that legitimately set `SPEEDWAVE_DATA_DIR` to a
/// tempdir and then resolve the OnceLock once, to exercise the env-var wiring
/// itself. These are the only sanctioned bare-`data_dir()` call sites in tests.
///
/// This drift detector's own source is self-excluded: it carries the literal
/// `consts::data_dir()` token in `PATTERNS` as *data*, not as a call.
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
    // Integration-test binaries for the Desktop crate: whole-file test code,
    // same as the runtime crate's own `tests/` binaries.
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
            // Longest-first; report each line once (a qualified form contains
            // the shorter `consts::data_dir()` substring).
            if let Some(pat) = PATTERNS.iter().find(|p| line.contains(**p)) {
                // In an integration-test binary the whole file is test code; in
                // a `src/` file only genuine test regions (`#[test]`/`mod tests`)
                // are forbidden — a `#[cfg(test)]` helper is production-shaped.
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
