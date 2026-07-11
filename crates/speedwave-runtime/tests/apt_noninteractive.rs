//! Drift detector: every `apt-get install` in a container image file must run
//! with `DEBIAN_FRONTEND=noninteractive` — a debconf prompt (e.g. tzdata's
//! timezone dialog on upgrade) hangs buildkit forever, since builds have no TTY.

#![expect(
    clippy::expect_used,
    reason = "test assertions on setup/mock calls that must not silently fail"
)]

use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates dir")
        .parent()
        .expect("repo root")
        .to_path_buf()
}

fn collect_image_files(root: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(root).expect("read_dir").flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if name.starts_with('.') || name == "node_modules" || name == "dist" {
                continue;
            }
            collect_image_files(&path, out);
        } else if name == "Dockerfile" || name.starts_with("Containerfile") {
            out.push(path);
        }
    }
}

/// Join `\`-continued physical lines into (first_line_number, logical_line) pairs.
fn logical_lines(src: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut start = 0usize;
    for (idx, line) in src.lines().enumerate() {
        if current.is_empty() {
            start = idx + 1;
        }
        let trimmed = line.trim_end();
        if let Some(stripped) = trimmed.strip_suffix('\\') {
            current.push_str(stripped);
            current.push(' ');
        } else {
            current.push_str(trimmed);
            out.push((start, std::mem::take(&mut current)));
        }
    }
    if !current.is_empty() {
        out.push((start, current));
    }
    out
}

#[test]
fn apt_get_install_runs_noninteractive() {
    let root = repo_root();
    let mut files = Vec::new();
    for dir in ["containers", "mcp-servers"] {
        collect_image_files(&root.join(dir), &mut files);
    }
    assert!(
        !files.is_empty(),
        "no image files found — repo layout changed?"
    );

    let mut violations = Vec::new();
    for file in &files {
        let src = std::fs::read_to_string(file).expect("read image file");
        for (lineno, logical) in logical_lines(&src) {
            if logical.contains("apt-get install")
                && !logical.contains("DEBIAN_FRONTEND=noninteractive")
            {
                violations.push(format!("{}:{lineno}", file.display()));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "apt-get install without DEBIAN_FRONTEND=noninteractive (debconf can hang the build):\n{}",
        violations.join("\n")
    );
}

#[test]
fn logical_lines_joins_continuations() {
    let src = "RUN a \\\n    && b\nNEXT\n";
    let lines = logical_lines(src);
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].0, 1);
    assert!(lines[0].1.contains("RUN a") && lines[0].1.contains("&& b"));
    assert_eq!(lines[1], (3, "NEXT".to_string()));
}

#[test]
fn logical_lines_handles_empty_and_trailing_continuation() {
    assert!(logical_lines("").is_empty());
    // Trailing `\` on the last line must not drop the buffered content.
    let lines = logical_lines("RUN a \\");
    assert_eq!(lines.len(), 1);
    assert!(lines[0].1.contains("RUN a"));
}
