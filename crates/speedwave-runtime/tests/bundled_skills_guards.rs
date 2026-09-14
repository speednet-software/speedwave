//! Guards for the bundled skills tree: no model pin, name equals directory, review
//! workers aligned, no upstream leftovers, refs resolve, ADR-087 table, license pin.

#![expect(
    clippy::expect_used,
    reason = "test assertions on setup/mock calls that must not silently fail"
)]

use regex::Regex;
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

/// Every regular file under the skills root, any extension; hidden dirs skipped.
fn collect_all_files() -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).expect("read_dir").flatten() {
            let path = entry.path();
            if path.is_dir() {
                if entry.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                walk(&path, out);
            } else {
                out.push(path);
            }
        }
    }

    let mut out = Vec::new();
    walk(&skills_root(), &mut out);
    out.sort();
    out
}

fn top_level_dirs() -> Vec<String> {
    let mut dirs: Vec<String> = fs::read_dir(skills_root())
        .expect("read_dir skills root")
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            (entry.path().is_dir() && !name.starts_with('.')).then_some(name)
        })
        .collect();
    dirs.sort();
    dirs
}

/// Repo-relative, forward-slash path so failure messages read the same on both platforms.
fn rel(path: &Path) -> String {
    path.strip_prefix(repo_root())
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn read_lossy(path: &Path) -> String {
    String::from_utf8_lossy(&fs::read(path).expect("read skills-root file")).into_owned()
}

fn frontmatter_value(fm: &str, key: &str) -> String {
    fm.lines()
        .find_map(|l| l.strip_prefix(key))
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn contains_word(haystack: &str, word: &str) -> bool {
    let bytes = haystack.as_bytes();
    haystack.match_indices(word).any(|(start, _)| {
        let before = start.checked_sub(1).map(|i| bytes[i]);
        let after = bytes.get(start + word.len()).copied();
        !before.is_some_and(is_word_byte) && !after.is_some_and(is_word_byte)
    })
}

/// The 23 vendored skills (ADR-087) with their upstream visibility: true = user-invoked.
const VENDORED_SKILLS: &[(&str, bool)] = &[
    ("speedwave-ask", true),
    ("speedwave-codebase-design", false),
    ("speedwave-diagnosing-bugs", false),
    ("speedwave-domain-modeling", false),
    ("speedwave-grill-me", true),
    ("speedwave-grill-with-docs", true),
    ("speedwave-grilling", false),
    ("speedwave-handoff", true),
    ("speedwave-implement", true),
    ("speedwave-improve-codebase-architecture", true),
    ("speedwave-prototype", false),
    ("speedwave-research", false),
    ("speedwave-resolving-merge-conflicts", false),
    ("speedwave-setup", true),
    ("speedwave-tdd", false),
    ("speedwave-teach", true),
    ("speedwave-to-questionnaire", true),
    ("speedwave-to-spec", true),
    ("speedwave-to-tickets", true),
    ("speedwave-triage", true),
    ("speedwave-wait-what", true),
    ("speedwave-wayfinder", true),
    ("speedwave-writing-for-agents", false),
];

const NATIVE_CORE_SKILLS: &[&str] = &[
    "speedwave-code-review",
    "speedwave-product-showcase",
    "speedwave-site-audit",
    "speedwave-sitemap",
];

/// Upstream identifiers a vendored copy must not keep (bare slash names are checked separately).
const UPSTREAM_LEFTOVERS: &[&str] = &[
    "setup-matt-pocock-skills",
    "CONTEXT.md",
    "CONTEXT-MAP.md",
    "CONTEXT-FORMAT.md",
    ".scratch/",
];

/// Host CLIs a bundled skill must never reach for; whole-word so `github` is fine.
const FORBIDDEN_HOST_CLIS: &[&str] = &["gh", "glab"];

/// Every upstream slash name; a bare `/<name>` is a leftover (`/speedwave-<name>` never matches).
const UPSTREAM_SLASH_NAMES: &[&str] = &[
    "ask-matt",
    "code-review",
    "codebase-design",
    "diagnosing-bugs",
    "domain-modeling",
    "grill-me",
    "grill-with-docs",
    "grilling",
    "handoff",
    "implement",
    "improve-codebase-architecture",
    "prototype",
    "research",
    "resolving-merge-conflicts",
    "setup-matt-pocock-skills",
    "tdd",
    "teach",
    "to-questionnaire",
    "to-spec",
    "to-tickets",
    "triage",
    "wait-what",
    "wayfinder",
    "wizard",
    "writing-for-agents",
];

/// Upstream pin (ADR-087): the license note and the bundled-skills rule must agree.
const UPSTREAM_VERSION: &str = "1.2.3";
const UPSTREAM_COMMIT: &str = "84fdeff";

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

#[test]
fn every_skill_name_matches_its_directory() {
    let mut violations = Vec::new();
    for file in collect_skill_files() {
        let content = fs::read_to_string(&file).expect("read SKILL.md");
        let dir = file
            .parent()
            .and_then(Path::file_name)
            .expect("SKILL.md parent dir")
            .to_string_lossy()
            .into_owned();
        let name = frontmatter_value(frontmatter(&content), "name:");
        if name != dir {
            violations.push(format!("{}: name '{name}' != dir '{dir}'", rel(&file)));
        }
    }
    assert!(
        violations.is_empty(),
        "a skill's frontmatter name is its slash command and must equal its directory name; rename the directory or the frontmatter name:\n{}",
        violations.join("\n")
    );
}

#[test]
fn bundled_skills_carry_no_upstream_leftovers() {
    let bare_slash =
        Regex::new(&format!(r"/(?:{})\b", UPSTREAM_SLASH_NAMES.join("|"))).expect("valid regex");
    let mut violations = Vec::new();
    for file in collect_all_files() {
        let content = read_lossy(&file);
        for (idx, line) in content.lines().enumerate() {
            let hits = UPSTREAM_LEFTOVERS
                .iter()
                .filter(|p| line.contains(**p))
                .chain(
                    FORBIDDEN_HOST_CLIS
                        .iter()
                        .filter(|c| contains_word(line, c)),
                );
            for hit in hits {
                violations.push(format!("{}:{}: {hit}", rel(&file), idx + 1));
            }
            for found in bare_slash.find_iter(line) {
                // `\b` treats `-` as a boundary, so skip path-like hits such as `/triage-labels.md`.
                if line.as_bytes().get(found.end()) == Some(&b'-') {
                    continue;
                }
                violations.push(format!("{}:{}: {}", rel(&file), idx + 1, found.as_str()));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "a bundled skill must carry no upstream identifier and no host CLI; rewrite the line to the Speedwave name or a tracker-neutral phrasing:\n{}",
        violations.join("\n")
    );
}

#[test]
fn skill_references_resolve_to_core_skill_directories() {
    let reference = Regex::new(r"/speedwave-[a-z0-9]+(-[a-z0-9]+)*").expect("valid regex");
    let dirs = top_level_dirs();

    let mut violations = Vec::new();
    for file in collect_all_files() {
        let content = read_lossy(&file);
        for (idx, line) in content.lines().enumerate() {
            for found in reference.find_iter(line) {
                let name = found.as_str().trim_start_matches('/');
                if !dirs.iter().any(|d| d == name) {
                    violations.push(format!("{}:{}: {}", rel(&file), idx + 1, found.as_str()));
                }
            }
        }
    }
    assert!(
        violations.is_empty(),
        "every /speedwave-<name> reference must resolve to a core skill directory under containers/claude-resources/skills; fix the reference or add the skill:\n{}",
        violations.join("\n")
    );
}

#[test]
fn vendored_skill_visibility_matches_adr_table() {
    assert_eq!(
        VENDORED_SKILLS.len(),
        23,
        "ADR-087 vendors 23 skills; changing the set needs an ADR amendment, not a table edit"
    );
    let names: Vec<&str> = VENDORED_SKILLS.iter().map(|(name, _)| *name).collect();
    let mut canonical = names.clone();
    canonical.sort_unstable();
    canonical.dedup();
    assert_eq!(
        names, canonical,
        "VENDORED_SKILLS must stay alphabetically sorted with unique names"
    );

    let mut violations = Vec::new();
    for (name, user_invoked) in VENDORED_SKILLS {
        let file = skills_root().join(name).join("SKILL.md");
        if !file.exists() {
            violations.push(format!(
                "{}: missing, ADR-087 lists this vendored skill",
                rel(&file)
            ));
            continue;
        }
        let content = fs::read_to_string(&file).expect("read SKILL.md");
        let fm = frontmatter(&content);

        let disabled = fm
            .lines()
            .any(|l| l.trim() == "disable-model-invocation: true");
        if disabled != *user_invoked {
            violations.push(format!(
                "{}: disable-model-invocation present = {disabled}, ADR-087 user-invoked = {user_invoked}",
                rel(&file)
            ));
        }
        for key in ["user-invocable:", "model:"] {
            if fm.lines().any(|l| l.trim_start().starts_with(key)) {
                violations.push(format!(
                    "{}: frontmatter must not carry `{key}`",
                    rel(&file)
                ));
            }
        }
    }

    for dir in top_level_dirs() {
        if !dir.starts_with("speedwave-") {
            continue;
        }
        let known = VENDORED_SKILLS.iter().any(|(name, _)| *name == dir)
            || NATIVE_CORE_SKILLS.contains(&dir.as_str());
        if !known {
            violations.push(format!(
                "{dir}: register the new core skill in VENDORED_SKILLS or NATIVE_CORE_SKILLS and in ADR-087"
            ));
        }
    }

    assert!(
        violations.is_empty(),
        "vendored skill visibility has drifted from the ADR-087 table:\n{}",
        violations.join("\n")
    );
}

#[test]
fn mattpocock_license_note_is_present_and_pinned() {
    let note = repo_root().join("desktop/src-tauri/licenses-static/mattpocock-skills-LICENSE");
    let mut violations = Vec::new();

    match fs::read_to_string(&note) {
        Err(_) => violations.push(format!(
            "{}: missing, add the upstream license note",
            rel(&note)
        )),
        Ok(content) => {
            let required = [
                "https://github.com/mattpocock/skills".to_string(),
                format!("mattpocock-skills {UPSTREAM_VERSION}"),
                UPSTREAM_COMMIT.to_string(),
                "MIT License".to_string(),
                "Permission is hereby granted, free of charge, to any person obtaining a copy"
                    .to_string(),
            ];
            for needle in required {
                if !content.contains(&needle) {
                    violations.push(format!("{}: missing `{needle}`", rel(&note)));
                }
            }
        }
    }

    let rule = repo_root().join(".claude/rules/bundled-skills.md");
    let rule_text = fs::read_to_string(&rule).unwrap_or_default();
    for pin in [UPSTREAM_VERSION, UPSTREAM_COMMIT] {
        if !rule_text.contains(pin) {
            violations.push(format!("{}: missing pin `{pin}`", rel(&rule)));
        }
    }

    assert!(
        violations.is_empty(),
        "the vendored set needs a license note and one pin shared by the note and the rule; add the file or align the pin:\n{}",
        violations.join("\n")
    );
}
