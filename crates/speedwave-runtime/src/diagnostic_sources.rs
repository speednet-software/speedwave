//! SSOT registry of diagnostic sources. The `/logs` view and the diagnostics
//! ZIP both derive their content from `DIAGNOSTIC_SOURCES`, so they cannot drift
//! (see the parity tests). The only allowed divergence: a non-`displayable`
//! source (an artifact the line-oriented `/logs` view can't render, e.g.
//! `compose.yml`) is ZIP-only.

use std::path::{Path, PathBuf};

use crate::consts;

/// Platforms a source exists on. `lima/serial.log` is macOS-only.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Platforms {
    All,
    MacOnly,
    WindowsOnly,
}

impl Platforms {
    /// True if the source exists on the current target.
    pub fn available_here(self) -> bool {
        match self {
            Platforms::All => true,
            Platforms::MacOnly => cfg!(target_os = "macos"),
            Platforms::WindowsOnly => cfg!(target_os = "windows"),
        }
    }
}

/// How a source's raw text is obtained. Models the 1:N cardinality the two
/// consumers handle differently.
#[derive(Clone, Copy)]
pub enum SourceKind {
    /// One file resolved from `(data_dir, project)`. `None` = not applicable.
    File(fn(&Path, &str) -> Option<PathBuf>),
    /// Compose stream fetched from the runtime (`/logs` token `compose`; ZIP
    /// entry `containers/compose.log`). Splits per-container in `/logs`.
    ComposeLogs,
    /// The tauri-plugin-log directory: one `/logs` source, N `logs/<file>` ZIP
    /// entries. Each consumer applies its own directory routine.
    DesktopLogDir,
}

/// One diagnostic source. `key` is the `/logs` token (frontend `COMPOSE_RE`
/// `[\w.-]+`); `zip_entry` is its ZIP path (a `logs/` prefix for `DesktopLogDir`).
pub struct DiagnosticSource {
    pub key: &'static str,
    pub zip_entry: &'static str,
    /// `false` = ZIP-only (not renderable in the line-oriented `/logs` view).
    pub displayable: bool,
    pub platforms: Platforms,
    pub kind: SourceKind,
}

fn mcp_os_path(data_dir: &Path, _project: &str) -> Option<PathBuf> {
    Some(data_dir.join(consts::MCP_OS_LOG_FILE))
}

fn host_exec_path(data_dir: &Path, project: &str) -> Option<PathBuf> {
    Some(
        crate::host_exec::host_exec_project_dir(data_dir, project).join(consts::HOST_EXEC_LOG_FILE),
    )
}

fn claude_session_path(data_dir: &Path, project: &str) -> Option<PathBuf> {
    Some(consts::claude_session_log_path_under(data_dir, project))
}

fn lima_serial_path(data_dir: &Path, _project: &str) -> Option<PathBuf> {
    Some(
        data_dir
            .join(consts::LIMA_SUBDIR)
            .join(consts::lima_vm_name())
            .join("serial.log"),
    )
}

fn compose_yml_path(data_dir: &Path, project: &str) -> Option<PathBuf> {
    crate::compose::compose_output_path_in(data_dir, project).ok()
}

/// The SSOT list. Adding a source = one row here; both consumers pick it up.
pub const DIAGNOSTIC_SOURCES: &[DiagnosticSource] = &[
    DiagnosticSource {
        key: "compose",
        zip_entry: "containers/compose.log",
        displayable: true,
        platforms: Platforms::All,
        kind: SourceKind::ComposeLogs,
    },
    DiagnosticSource {
        key: "desktop",
        zip_entry: "logs/",
        displayable: true,
        platforms: Platforms::All,
        kind: SourceKind::DesktopLogDir,
    },
    DiagnosticSource {
        key: "mcp-os",
        zip_entry: "mcp-os/mcp-os.log",
        displayable: true,
        platforms: Platforms::All,
        kind: SourceKind::File(mcp_os_path),
    },
    DiagnosticSource {
        key: "host-exec",
        zip_entry: "host-exec/log",
        displayable: true,
        platforms: Platforms::All,
        kind: SourceKind::File(host_exec_path),
    },
    DiagnosticSource {
        key: "claude",
        zip_entry: "claude/claude-session.log",
        displayable: true,
        platforms: Platforms::All,
        kind: SourceKind::File(claude_session_path),
    },
    DiagnosticSource {
        key: "lima",
        zip_entry: "lima/serial.log",
        displayable: true,
        platforms: Platforms::MacOnly,
        kind: SourceKind::File(lima_serial_path),
    },
    DiagnosticSource {
        key: "compose-yml",
        zip_entry: "containers/compose.yml",
        displayable: false,
        platforms: Platforms::All,
        kind: SourceKind::File(compose_yml_path),
    },
];

/// Explicit allow-list of ZIP-only keys. A new non-`displayable` source must be
/// added here too, or `nondisplayable_sources_match_zip_only_allowlist` fails.
pub const ZIP_ONLY_KEYS: &[&str] = &["compose-yml"];

/// Resolves a `SourceKind::File` source's path by key, gated to the current
/// platform. Shared by both consumers (/logs + ZIP) so neither hand-rolls the
/// find + platform-gate + File-extraction chain. Returns `None` for unknown
/// keys, unavailable platforms, or non-File kinds.
pub fn resolve_file_path(key: &str, data_dir: &Path, project: &str) -> Option<PathBuf> {
    DIAGNOSTIC_SOURCES
        .iter()
        .find(|s| s.key == key && s.platforms.available_here())
        .and_then(|s| match s.kind {
            SourceKind::File(f) => f(data_dir, project),
            _ => None,
        })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn nondisplayable_sources_match_zip_only_allowlist() {
        let non_displayable: Vec<&str> = DIAGNOSTIC_SOURCES
            .iter()
            .filter(|s| !s.displayable)
            .map(|s| s.key)
            .collect();
        assert_eq!(
            non_displayable, ZIP_ONLY_KEYS,
            "every non-displayable (ZIP-only) source must be justified in ZIP_ONLY_KEYS — \
             the only allowed /logs↔ZIP divergence is a non-renderable artifact"
        );
    }

    #[test]
    fn keys_and_zip_entries_are_unique_and_nonempty() {
        let mut keys: Vec<&str> = DIAGNOSTIC_SOURCES.iter().map(|s| s.key).collect();
        keys.sort_unstable();
        let before = keys.len();
        keys.dedup();
        assert_eq!(before, keys.len(), "duplicate source key");
        for s in DIAGNOSTIC_SOURCES {
            assert!(!s.key.is_empty(), "empty key");
            assert!(!s.zip_entry.is_empty(), "empty zip_entry for {}", s.key);
        }
    }

    #[test]
    fn file_resolvers_build_paths_under_data_dir() {
        let data_dir = Path::new("/fake/.speedwave");
        for s in DIAGNOSTIC_SOURCES {
            if let SourceKind::File(resolve) = s.kind {
                let p = resolve(data_dir, "proj").expect("file resolver returned None");
                assert!(
                    p.starts_with(data_dir),
                    "{} resolver escaped data_dir: {p:?}",
                    s.key
                );
            }
        }
    }

    #[test]
    fn platform_availability_is_consistent() {
        // `lima` is the only MacOnly source today.
        let mac_only: Vec<&str> = DIAGNOSTIC_SOURCES
            .iter()
            .filter(|s| s.platforms == Platforms::MacOnly)
            .map(|s| s.key)
            .collect();
        assert_eq!(mac_only, vec!["lima"]);
    }

    /// `zip_entry` literals embed const-owned filenames (the slice needs
    /// `&'static str`, so they can't be `format!`-ed). Guard against drift if a
    /// const filename changes.
    #[test]
    fn zip_entries_match_owning_consts() {
        let entry = |key: &str| {
            DIAGNOSTIC_SOURCES
                .iter()
                .find(|s| s.key == key)
                .map(|s| s.zip_entry)
                .unwrap_or_default()
        };
        assert!(entry("mcp-os").ends_with(consts::MCP_OS_LOG_FILE));
        assert!(entry("claude").ends_with(consts::CLAUDE_SESSION_LOG_FILE));
        assert!(entry("host-exec").ends_with(consts::HOST_EXEC_LOG_FILE));
        // `lima`/`compose-yml` filenames are Lima's / compose's own conventions,
        // not Speedwave consts, so there's nothing to drift against.
    }
}
