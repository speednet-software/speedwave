//! Guards for bundled code-review skills: no model pin, worker list matches dirs,
//! shared blocks byte-identical, no repo-level dev copy.

#![expect(
    clippy::expect_used,
    reason = "test assertions on setup/mock calls that must not silently fail"
)]

use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates dir")
        .parent()
        .expect("repo root")
        .to_path_buf()
}

fn skills_root() -> PathBuf {
    repo_root().join("containers/claude-resources/skills")
}

fn collect_skill_files() -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).expect("read_dir").flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if path.is_dir() {
                if name.starts_with('.') {
                    continue;
                }
                walk(&path, out);
            } else if name == "SKILL.md" {
                out.push(path);
            }
        }
    }

    let mut out = Vec::new();
    walk(&skills_root(), &mut out);
    out
}

fn frontmatter(content: &str) -> &str {
    let Some(rest) = content.strip_prefix("---\n") else {
        return "";
    };
    match rest.find("\n---") {
        Some(end) => &rest[..end],
        None => "",
    }
}

fn worker_dirs() -> Vec<String> {
    let mut dirs: Vec<String> = fs::read_dir(skills_root())
        .expect("read_dir skills root")
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            (entry.path().is_dir() && name.starts_with("code-review-")).then_some(name)
        })
        .collect();
    dirs.sort();
    dirs
}

/// Section body from `heading` to the next markdown heading outside a code fence.
/// Shared blocks carry no sub-headings, so any `#` line bounds them exactly.
fn extract_section(content: &str, heading: &str) -> Option<String> {
    if !content.lines().any(|l| l == heading) {
        return None;
    }
    let mut lines = content.lines();
    for line in lines.by_ref() {
        if line == heading {
            break;
        }
    }

    let mut out = Vec::new();
    let mut in_fence = false;
    for line in lines {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
        } else if !in_fence && trimmed.starts_with('#') {
            break;
        }
        out.push(line);
    }

    Some(out.join("\n").trim_end().to_string())
}

#[test]
fn no_skill_pins_a_model() {
    let mut violations = Vec::new();
    for file in collect_skill_files() {
        let content = fs::read_to_string(&file).expect("read SKILL.md");
        let fm = frontmatter(&content);
        if fm.lines().any(|l| l.trim_start().starts_with("model:")) {
            violations.push(file.display().to_string());
        }
    }
    assert!(
        violations.is_empty(),
        "skills must not pin a model — they inherit the session model; remove the `model:` field:\n{}",
        violations.join("\n")
    );
}

#[test]
fn no_dev_copy_of_skills_or_scripts() {
    assert!(
        !repo_root().join(".claude/skills").exists(),
        "bundled skills under containers/claude-resources/skills are the single source; do not reintroduce a repo-level dev copy"
    );
    assert!(
        !repo_root().join(".claude/scripts").exists(),
        "bundled skills under containers/claude-resources/skills are the single source; do not reintroduce a repo-level dev copy"
    );
}

#[test]
fn orchestrator_worker_list_matches_directories() {
    let orchestrator = skills_root().join("speedwave-code-review/SKILL.md");
    let content = fs::read_to_string(&orchestrator).expect("read orchestrator SKILL.md");
    let section = extract_section(&content, "## Worker Skills")
        .expect("orchestrator has Worker Skills section");

    let mut listed: Vec<String> = section
        .lines()
        .filter_map(|l| l.strip_prefix("- ").map(str::to_string))
        .collect();
    listed.sort();

    let dirs = worker_dirs();
    assert_eq!(
        listed, dirs,
        "orchestrator '## Worker Skills' list has drifted from containers/claude-resources/skills/code-review-* directories (missing or extra entries)"
    );
}

#[test]
fn worker_shared_blocks_are_identical() {
    let dirs = worker_dirs();
    let headings = [
        "## Review Scope",
        "## Project Conventions",
        "## Output Contract",
    ];

    for heading in headings {
        let mut reference: Option<(String, String)> = None;
        for dir in &dirs {
            let file = skills_root().join(dir).join("SKILL.md");
            let content = fs::read_to_string(&file).expect("read worker SKILL.md");
            let section = extract_section(&content, heading).unwrap_or_else(|| {
                panic!("{} is missing required section '{heading}'", file.display())
            });

            match &reference {
                None => reference = Some((file.display().to_string(), section)),
                Some((ref_file, ref_section)) => {
                    assert_eq!(
                        &section,
                        ref_section,
                        "'{heading}' diverges between {} and {}",
                        ref_file,
                        file.display()
                    );
                }
            }
        }
    }
}
