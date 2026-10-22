//! SSOT registry of diagnostic sources. The `/logs` view and the diagnostics ZIP both derive their
//! content from `DIAGNOSTIC_SOURCES`. Allowed divergence: a non-`displayable` source is ZIP-only.

use std::path::{Path, PathBuf};

use crate::consts;

/// Platforms a source exists on. `lima/serial.log` is macOS-only.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Platforms {
    /// Available on every supported platform.
    All,
    /// macOS only.
    MacOnly,
    /// Windows only.
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
    /// Every regular file named `<prefix>*<suffix>` in one directory resolved from
    /// `(data_dir, project)`; each is ZIP entry `<zip_entry><file name>`.
    DirFiles {
        /// The directory.
        dir: fn(&Path, &str) -> Option<PathBuf>,
        /// File name prefix.
        prefix: &'static str,
        /// File name suffix.
        suffix: &'static str,
    },
}

/// One diagnostic source. `key` is the `/logs` token (frontend `COMPOSE_RE`
/// `[\w.-]+`); `zip_entry` is its ZIP path (a `logs/` prefix for `DesktopLogDir`).
pub struct DiagnosticSource {
    /// `/logs` token identifying the source.
    pub key: &'static str,
    /// Path of this source inside the diagnostics ZIP.
    pub zip_entry: &'static str,
    /// `false` = ZIP-only (not renderable in the line-oriented `/logs` view).
    pub displayable: bool,
    /// Platforms the source exists on.
    pub platforms: Platforms,
    /// How the source's raw text is obtained.
    pub kind: SourceKind,
}

fn mcp_os_path(data_dir: &Path, _project: &str) -> Option<PathBuf> {
    Some(data_dir.join(consts::MCP_OS_LOG_FILE))
}

fn claude_session_path(data_dir: &Path, project: &str) -> Option<PathBuf> {
    Some(consts::claude_session_log_path_under(data_dir, project))
}

fn entrypoint_path(data_dir: &Path, project: &str) -> Option<PathBuf> {
    Some(consts::entrypoint_log_path_under(data_dir, project))
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

fn audit_proxy_path(data_dir: &Path, project: &str) -> Option<PathBuf> {
    Some(crate::audit::audit_dir_in(data_dir, project).join(consts::AUDIT_PROXY_FILE))
}

fn audit_hub_path(data_dir: &Path, project: &str) -> Option<PathBuf> {
    Some(crate::audit::audit_dir_in(data_dir, project).join(consts::AUDIT_HUB_FILE))
}

fn audit_dir_path(data_dir: &Path, project: &str) -> Option<PathBuf> {
    Some(crate::audit::audit_dir_in(data_dir, project))
}

fn proxy_usage_path(data_dir: &Path, project: &str) -> Option<PathBuf> {
    Some(crate::usage::usage_file_in(data_dir, project))
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
        key: "claude",
        zip_entry: "claude/claude-session.log",
        displayable: true,
        platforms: Platforms::All,
        kind: SourceKind::File(claude_session_path),
    },
    DiagnosticSource {
        key: "entrypoint",
        zip_entry: "claude/entrypoint.log",
        displayable: true,
        platforms: Platforms::All,
        kind: SourceKind::File(entrypoint_path),
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
    DiagnosticSource {
        key: "audit-proxy",
        zip_entry: "audit/audit-proxy.jsonl",
        displayable: true,
        platforms: Platforms::All,
        kind: SourceKind::File(audit_proxy_path),
    },
    DiagnosticSource {
        key: "audit-hub",
        zip_entry: "audit/audit-hub.jsonl",
        displayable: true,
        platforms: Platforms::All,
        kind: SourceKind::File(audit_hub_path),
    },
    DiagnosticSource {
        key: "proxy-usage",
        zip_entry: "proxy/usage.jsonl",
        displayable: false,
        platforms: Platforms::All,
        kind: SourceKind::File(proxy_usage_path),
    },
    DiagnosticSource {
        key: "tool-catalogs",
        zip_entry: "audit/tool-catalogs/",
        displayable: false,
        platforms: Platforms::All,
        kind: SourceKind::DirFiles {
            dir: audit_dir_path,
            prefix: crate::custom_mcp::catalog::TOOL_CATALOG_FILE_PREFIX,
            suffix: ".json",
        },
    },
];

/// Explicit allow-list of ZIP-only keys. A new non-`displayable` source must be
/// added here too, or `nondisplayable_sources_match_zip_only_allowlist` fails.
pub const ZIP_ONLY_KEYS: &[&str] = &["compose-yml", "proxy-usage", "tool-catalogs"];

/// Resolves a `SourceKind::File` source's path by key, gated to the current platform. `None` for
/// unknown keys, unavailable platforms, or non-File kinds.
pub fn resolve_file_path(key: &str, data_dir: &Path, project: &str) -> Option<PathBuf> {
    DIAGNOSTIC_SOURCES
        .iter()
        .find(|s| s.key == key && s.platforms.available_here())
        .and_then(|s| match s.kind {
            SourceKind::File(f) => f(data_dir, project),
            _ => None,
        })
}

/// The files of a `SourceKind::DirFiles` source by key, sorted; regular files only (a symlink
/// is skipped), empty for unknown keys, other kinds or a missing directory.
pub fn resolve_dir_files(key: &str, data_dir: &Path, project: &str) -> Vec<PathBuf> {
    let Some(SourceKind::DirFiles {
        dir,
        prefix,
        suffix,
    }) = DIAGNOSTIC_SOURCES
        .iter()
        .find(|s| s.key == key && s.platforms.available_here())
        .map(|s| s.kind)
    else {
        return Vec::new();
    };
    let Some(Ok(entries)) = dir(data_dir, project).map(std::fs::read_dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.starts_with(prefix) && n.ends_with(suffix))
        })
        .map(|e| e.path())
        .collect();
    files.sort();
    files
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test-only module: expects assert setup succeeded"
)]
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
    fn tool_catalogs_are_collected_from_the_audit_dir_only() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let audit = crate::audit::audit_dir_in(tmp.path(), "proj");
        std::fs::create_dir_all(&audit).expect("audit dir");
        for name in [
            "tool-catalog-custom-b.json",
            "tool-catalog-custom-a.json",
            "audit-hub.jsonl",
            "tool-catalog-custom-a.json.tmp",
        ] {
            std::fs::write(audit.join(name), "{}").expect("write");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            audit.join("audit-hub.jsonl"),
            audit.join("tool-catalog-custom-link.json"),
        )
        .expect("symlink");
        assert_eq!(
            resolve_dir_files("tool-catalogs", tmp.path(), "proj"),
            vec![
                audit.join("tool-catalog-custom-a.json"),
                audit.join("tool-catalog-custom-b.json")
            ]
        );
        assert!(resolve_dir_files("tool-catalogs", tmp.path(), "other").is_empty());
        assert!(resolve_dir_files("audit-hub", tmp.path(), "proj").is_empty());
        let s = DIAGNOSTIC_SOURCES
            .iter()
            .find(|s| s.key == "tool-catalogs")
            .expect("registered");
        assert!(!s.displayable && s.zip_entry.ends_with('/'));
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
    fn proxy_usage_source_resolves_via_usage_file_in() {
        let data_dir = Path::new("/fake/.speedwave");
        assert_eq!(
            resolve_file_path("proxy-usage", data_dir, "proj"),
            Some(crate::usage::usage_file_in(data_dir, "proj"))
        );
    }

    #[test]
    fn entrypoint_source_is_registered_and_displayable() {
        let s = DIAGNOSTIC_SOURCES
            .iter()
            .find(|s| s.key == "entrypoint")
            .expect("entrypoint source must be registered");
        assert!(s.displayable);
        assert_eq!(s.zip_entry, "claude/entrypoint.log");
    }

    #[test]
    fn platform_availability_is_consistent() {
        let mac_only: Vec<&str> = DIAGNOSTIC_SOURCES
            .iter()
            .filter(|s| s.platforms == Platforms::MacOnly)
            .map(|s| s.key)
            .collect();
        assert_eq!(mac_only, vec!["lima"]);
    }

    /// Guards against drift if a const filename embedded in a `zip_entry`
    /// changes.
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
        assert!(entry("audit-proxy").ends_with(consts::AUDIT_PROXY_FILE));
        assert!(entry("audit-hub").ends_with(consts::AUDIT_HUB_FILE));
    }
}
