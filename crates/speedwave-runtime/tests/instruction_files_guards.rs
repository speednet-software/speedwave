//! Guards for the bundled instruction files (CLAUDE.md + output style):
//! tell-free characters, line budget, required section anchors.

#![expect(
    clippy::expect_used,
    reason = "test assertions on setup/mock calls that must not silently fail"
)]

use std::fs;
use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates dir")
        .parent()
        .expect("repo root")
        .to_path_buf()
}

fn instruction_files() -> Vec<(&'static str, String)> {
    [
        "containers/claude-resources/CLAUDE.md",
        "containers/claude-resources/output-styles/Speedwave.md",
    ]
    .into_iter()
    .map(|rel| {
        let path = repo_root().join(rel);
        let content =
            fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        (rel, content)
    })
    .collect()
}

#[test]
fn instruction_files_are_free_of_ai_tell_characters() {
    const BANNED: [(char, &str); 5] = [
        ('\u{2014}', "em dash"),
        ('\u{201C}', "left curly double quote"),
        ('\u{201D}', "right curly double quote"),
        ('\u{2018}', "left curly single quote"),
        ('\u{2019}', "right curly single quote"),
    ];
    for (rel, content) in instruction_files() {
        for (idx, line) in content.lines().enumerate() {
            for (ch, name) in BANNED {
                assert!(
                    !line.contains(ch),
                    "{rel}:{}: contains {name} ({ch:?}); reference the codepoint instead",
                    idx + 1
                );
            }
        }
    }
}

#[test]
fn instruction_files_stay_within_line_budget() {
    for (rel, content) in instruction_files() {
        let lines = content.lines().count();
        assert!(
            lines <= 200,
            "{rel}: {lines} lines exceeds the 200-line adherence budget; cut before adding"
        );
    }
}

#[test]
fn instruction_files_keep_required_sections() {
    let files = instruction_files();
    let claude_md = &files[0].1;
    let style = &files[1].1;
    for anchor in [
        "## Writing contract",
        "## Delegation and model tiering",
        "## Platform capabilities",
    ] {
        assert!(
            claude_md.contains(anchor),
            "CLAUDE.md lost required section {anchor:?}"
        );
    }
    for anchor in [
        "Self-check",
        "Claim evaluation",
        "keep-coding-instructions: true",
    ] {
        assert!(
            style.contains(anchor),
            "Speedwave.md lost required anchor {anchor:?}"
        );
    }
}
