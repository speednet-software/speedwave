//! Drift detector: `std::process::Command` is constructed only in `binary.rs`,
//! the spawn SSOT. Bypass a line with `// SSOT-allow: <reason>`.

#![expect(
    clippy::expect_used,
    reason = "test drift-detector reads sources from disk"
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

/// The sanctioned module — the only place `Command::new` may appear.
const SPAWN_SSOT: &str = "crates/speedwave-runtime/src/binary.rs";

/// Files that still spawn raw for legitimate reasons (interactive TTY, system probes, test-support
/// runtimes) pending the spawn-SSOT migration; new entries need PR justification.
const ALLOWLISTED_FILES: &[&str] = &[
    // CLI self re-exec (`speedwave update`) — interactive, inherits the terminal.
    "crates/speedwave-cli/src/main.rs",
    // macOS `sysctl hw.memsize` RAM probe (avoids an `unsafe` sysinfo call).
    "crates/speedwave-runtime/src/resources.rs",
    // Unix `ps`/`kill` stale-process detection for host MCP workers.
    "crates/speedwave-runtime/src/host_mcp_process/stale.rs",
    // Unix `kill -0` liveness probe for host MCP workers.
    "crates/speedwave-runtime/src/host_mcp_process/probe.rs",
    // Interactive `wsl.exe` TTY session — needs a Windows console window.
    "crates/speedwave-runtime/src/runtime/wsl.rs",
    // Interactive `ssh -t` into the Lima VM — needs a PTY.
    "crates/speedwave-runtime/src/runtime/lima.rs",
    // Mock runtime (test-support): fabricates exec Commands for assertions.
    "crates/speedwave-runtime/src/runtime/mock_runtime.rs",
    // macOS `open` to reveal a settings pane.
    "desktop/src-tauri/src/system_settings_cmd.rs",
    // Launches the bundled CLI for an integration login flow.
    "desktop/src-tauri/src/integrations_cmd.rs",
    // Interactive OAuth login: osascript / Windows Terminal / PowerShell.
    "desktop/src-tauri/src/oauth_login_cmd.rs",
];

const PATTERN: &str = "Command::new";

fn is_in_test_module(lines: &[&str], idx: usize) -> bool {
    for i in (0..idx).rev() {
        let l = lines[i].trim_start();
        if l.starts_with("mod tests")
            || l.starts_with("mod test_support")
            || l.starts_with("#[cfg(test)]")
            || l.starts_with("#[test]")
            || l.starts_with("#[cfg(any(test")
        {
            return true;
        }
        if l == "}" && lines[i].starts_with('}') {
            return false;
        }
    }
    false
}

fn has_allow_marker(line: &str, prev: Option<&&str>) -> bool {
    line.contains("// SSOT-allow:") || prev.is_some_and(|p| p.contains("// SSOT-allow:"))
}

#[test]
fn no_raw_command_spawn_outside_binary_rs() {
    let root = manifest_root();

    let mut files = Vec::new();
    let crates_dir = root.join("crates");
    if let Ok(entries) = std::fs::read_dir(&crates_dir) {
        for entry in entries.flatten() {
            let src = entry.path().join("src");
            if src.is_dir() {
                walk_rs(&src, &mut files);
            }
        }
    }
    walk_rs(
        &root.join("desktop").join("src-tauri").join("src"),
        &mut files,
    );

    let mut violations: Vec<String> = Vec::new();
    for file in &files {
        let rel = file.strip_prefix(&root).unwrap_or(file);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str == SPAWN_SSOT || ALLOWLISTED_FILES.contains(&rel_str.as_str()) {
            continue;
        }
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
            if !line.contains(PATTERN) {
                continue;
            }
            let prev = if idx > 0 { lines.get(idx - 1) } else { None };
            if has_allow_marker(line, prev) || is_in_test_module(&lines, idx) {
                continue;
            }
            violations.push(format!(
                "{}:{}: constructs a raw Command\n  > {}",
                rel.display(),
                idx + 1,
                line.trim_end()
            ));
        }
    }

    assert!(
        violations.is_empty(),
        "found {} raw Command::new sites outside binary.rs — route through a \
         binary:: helper (command / system_command / interactive_command / \
         run_powershell) or add a `// SSOT-allow: <reason>` marker:\n\n{}",
        violations.len(),
        violations.join("\n\n")
    );
}
