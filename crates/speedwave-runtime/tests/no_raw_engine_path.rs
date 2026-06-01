//! Drift detector: every host→engine path must be produced by the SSOT in
//! `engine_path` (`to_engine_path` / `str_to_engine_path` / `vm_path_join`).
//! No hand-rolled WSL translation, no `PathBuf::join` on an engine-side path,
//! no second `wslpath` mechanism, no `windows_to_wsl_path` outside the runtime
//! crate. Bypass a false positive with `// SSOT-allow: <reason>`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};

fn walk_rs(root: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(root).expect("read_dir").flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if name == "target" || name.starts_with('.') {
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

/// `.join(` invoked on a binding whose name signals it already holds an
/// engine-side path — the exact shape of the `presaleContainerfile` bug. Use
/// `vm_path_join` instead. (A chained `prepare_build_context(...).join(...)` is
/// caught by the `CHAINED_JOIN` rule below, not here.)
const JOIN_ON_ENGINE_PATTERNS: &[&str] = &[
    "vm_root.join(",
    "wsl_path.join(",
    "engine_path.join(",
    "wsl_root.join(",
];

/// A `prepare_build_context(...)` result joined inline on the SAME line — the
/// literal original bug (`prepare_build_context(dir).join("Containerfile")`).
/// Requires BOTH substrings so trait defs / plain calls don't trip it.
const CHAINED_JOIN_BOTH: &[&str] = &["prepare_build_context(", ".join("];

/// Hand-rolled WSL translation: only `engine_path.rs` and `wsl.rs` may mint a
/// `/mnt/...` literal. Anywhere else is a second translation mechanism.
const RAW_MNT_PATTERNS: &[&str] = &["\"/mnt/", "format!(\"/mnt"];

/// A second path-translation mechanism. There must be exactly one (the SSOT).
const WSLPATH_PATTERNS: &[&str] = &["\"wslpath\""];

/// `windows_to_wsl_path` is a `pub(crate)` primitive of `to_engine_path`. No
/// downstream crate (desktop/cli) may call it — they go through the SSOT.
const PRIMITIVE_PATTERNS: &[&str] = &["windows_to_wsl_path"];

// Heuristic: scan backward for a test marker, stopping at the first column-0
// `}` (a top-level item close). Limitation: a column-0 `}` between the
// violation and its enclosing `mod tests` (e.g. a nested `impl` close at column
// 0 inside the module) could end the scan early and mis-classify a test-module
// line as production — a possible false negative. Acceptable: the worst case is
// the detector flagging real test code, which a `// SSOT-allow:` clears.
fn is_in_test_module(lines: &[&str], idx: usize) -> bool {
    for i in (0..idx).rev() {
        let l = lines[i].trim_start();
        if l.starts_with("mod tests")
            || l.starts_with("#[cfg(test)]")
            || l.starts_with("#[test]")
            || l.starts_with("#[cfg(any(test")
        {
            return true;
        }
        if lines[i] == "}" {
            return false;
        }
    }
    false
}

fn has_allow_marker(line: &str, prev: Option<&&str>) -> bool {
    line.contains("// SSOT-allow:") || prev.is_some_and(|p| p.contains("// SSOT-allow:"))
}

/// The SSOT implementation files: they legitimately mint `/mnt/` literals,
/// call `windows_to_wsl_path`, and are the home of the join/translate logic.
const SSOT_FILES: &[&str] = &[
    "crates/speedwave-runtime/src/engine_path.rs",
    "crates/speedwave-runtime/src/runtime/wsl.rs",
];

struct Rule {
    patterns: &'static [&'static str],
    /// When true, a line matches only if it contains ALL `patterns` (AND);
    /// otherwise ANY single pattern matches (OR).
    require_all: bool,
    msg: &'static str,
}

const RULES: &[Rule] = &[
    Rule {
        patterns: JOIN_ON_ENGINE_PATTERNS,
        require_all: false,
        msg: "PathBuf::join on an engine-side path — use engine_path::vm_path_join",
    },
    Rule {
        patterns: CHAINED_JOIN_BOTH,
        require_all: true,
        msg: "prepare_build_context(...).join(...) — use engine_path::vm_path_join",
    },
    Rule {
        patterns: RAW_MNT_PATTERNS,
        require_all: false,
        msg: "hand-rolled /mnt/ literal — translate via engine_path::to_engine_path",
    },
    Rule {
        patterns: WSLPATH_PATTERNS,
        require_all: false,
        msg: "second path-translation mechanism (wslpath) — use engine_path::to_engine_path",
    },
    Rule {
        patterns: PRIMITIVE_PATTERNS,
        require_all: false,
        msg:
            "windows_to_wsl_path is a runtime-internal primitive — call engine_path::to_engine_path",
    },
];

/// Index into `RULES` of the `windows_to_wsl_path` rule — it only applies
/// OUTSIDE the runtime crate (inside, it's the legitimate pub(crate) primitive).
const PRIMITIVE_RULE_IDX: usize = 4;

fn line_matches(rule: &Rule, line: &str) -> bool {
    if rule.require_all {
        rule.patterns.iter().all(|p| line.contains(p))
    } else {
        rule.patterns.iter().any(|p| line.contains(p))
    }
}

#[test]
fn engine_paths_go_through_ssot() {
    // Self-verify the hard-coded index: if a rule is inserted before it, the
    // primitive-rule exemption would silently apply to the wrong rule.
    assert_eq!(
        RULES[PRIMITIVE_RULE_IDX].patterns, PRIMITIVE_PATTERNS,
        "PRIMITIVE_RULE_IDX no longer points at the PRIMITIVE_PATTERNS rule — update it"
    );

    let root = manifest_root();
    let mut files = Vec::new();
    walk_rs(&root.join("crates/speedwave-runtime/src"), &mut files);
    walk_rs(&root.join("crates/speedwave-cli/src"), &mut files);
    walk_rs(&root.join("desktop/src-tauri/src"), &mut files);

    let mut violations: Vec<String> = Vec::new();
    for file in &files {
        let rel = file.strip_prefix(&root).unwrap_or(file);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let is_ssot = SSOT_FILES.iter().any(|f| rel_str == *f);

        let content = match std::fs::read_to_string(file) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let lines: Vec<&str> = content.lines().collect();
        for (idx, line) in lines.iter().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") {
                continue;
            }
            let prev = if idx > 0 { lines.get(idx - 1) } else { None };
            if has_allow_marker(line, prev) || is_in_test_module(&lines, idx) {
                continue;
            }
            for (ri, rule) in RULES.iter().enumerate() {
                // SSOT files (engine_path.rs, wsl.rs) own the join/translate/mnt
                // logic, so rules 0-3 don't apply to them. The primitive rule
                // never fires inside the runtime crate at all.
                if is_ssot {
                    continue;
                }
                if ri == PRIMITIVE_RULE_IDX && rel_str.starts_with("crates/speedwave-runtime/") {
                    continue;
                }
                if line_matches(rule, line) {
                    violations.push(format!(
                        "{}:{}: {}\n  > {}",
                        rel.display(),
                        idx + 1,
                        rule.msg,
                        line.trim()
                    ));
                }
            }
        }
    }

    assert!(
        violations.is_empty(),
        "found {} engine-path SSOT violation(s) — route through crate::engine_path \
         or add a `// SSOT-allow: <reason>` marker:\n\n{}",
        violations.len(),
        violations.join("\n\n")
    );
}
