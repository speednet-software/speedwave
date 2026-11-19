//! Unified lock-file schema for every host MCP worker manager: a single `lock.json` blob.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::fs_perms::write_restricted_file;

/// Service tag written into the lock file. Stable string per worker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockService {
    /// The mcp-os host process.
    McpOs,
    /// The in-process PII NER detector service of the Desktop app (ADR-096).
    PiiNer,
}

impl LockService {
    /// Stable string tag for this service, written into the lock file.
    pub fn tag(self) -> &'static str {
        match self {
            LockService::McpOs => "mcp-os",
            LockService::PiiNer => "pii-ner",
        }
    }
}

/// Lock-file payload. `transport` is "http" for every worker today
/// — kept as a field for future-proofing and symmetry with bridges.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct LockFile {
    /// Service tag that owns this lock.
    pub service: String,
    /// PID of the running worker process.
    pub pid: u32,
    /// TCP port the worker listens on.
    pub port: u16,
    /// Auth token clients must present.
    #[serde(rename = "authToken")]
    pub auth_token: String,
    /// Transport protocol (currently always `http`).
    pub transport: String,
}

impl std::fmt::Debug for LockFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LockFile")
            .field("service", &self.service)
            .field("pid", &self.pid)
            .field("port", &self.port)
            .field("auth_token", &"***REDACTED***")
            .field("transport", &self.transport)
            .finish()
    }
}

impl LockFile {
    /// Builds a lock-file payload for a worker.
    pub fn new(service: LockService, pid: u32, port: u16, auth_token: String) -> Self {
        Self {
            service: service.tag().to_string(),
            pid,
            port,
            auth_token,
            transport: "http".to_string(),
        }
    }
}

/// Read a `lock.json` from disk. Returns `None` if missing, unreadable, malformed, or the recorded
/// `service` doesn't match the caller's expectation. Best-effort — never panics.
pub fn read(path: &Path, expected: LockService) -> Option<LockFile> {
    let bytes = std::fs::read(path).ok()?;
    let lock: LockFile = serde_json::from_slice(&bytes).ok()?;
    if lock.service != expected.tag() {
        return None;
    }
    Some(lock)
}

/// Write `lock` to `path` with owner-only permissions, atomically via
/// `fs_perms::write_restricted_file`. A reader never sees a partial write.
pub fn write(path: &Path, lock: &LockFile) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(lock)?;
    write_restricted_file(path, &json)?;
    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test-only module: unwraps assert setup succeeded"
)]
mod tests {
    use super::*;
    fn fixture() -> LockFile {
        LockFile::new(LockService::McpOs, 12345, 60123, "uuid-token".into())
    }

    #[test]
    fn lockservice_tags_are_stable() {
        assert_eq!(LockService::McpOs.tag(), "mcp-os");
        assert_eq!(LockService::PiiNer.tag(), "pii-ner");
    }

    #[test]
    fn read_rejects_a_lock_of_another_service() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("pii-ner.lock.json");
        let lock = LockFile::new(LockService::PiiNer, 4242, 50123, "tok".into());
        write(&path, &lock).unwrap();
        assert_eq!(read(&path, LockService::PiiNer), Some(lock));
        assert!(read(&path, LockService::McpOs).is_none());
    }

    #[test]
    fn write_and_read_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lock.json");
        let lock = fixture();
        write(&path, &lock).unwrap();
        let read_back = read(&path, LockService::McpOs).unwrap();
        assert_eq!(read_back, lock);
    }

    #[test]
    fn read_returns_none_for_service_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lock.json");
        write(&path, &fixture()).unwrap();
        assert!(read(&path, LockService::PiiNer).is_none());
    }

    #[test]
    fn read_returns_none_for_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read(&dir.path().join("absent"), LockService::McpOs).is_none());
    }

    #[test]
    fn read_returns_none_for_malformed_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lock.json");
        std::fs::write(&path, b"not json").unwrap();
        assert!(read(&path, LockService::McpOs).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn write_sets_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lock.json");
        write(&path, &fixture()).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "lock.json must be owner-only");
    }

    #[test]
    fn lock_file_debug_redacts_auth_token() {
        let lock = LockFile::new(
            LockService::McpOs,
            42,
            8080,
            "top-secret-bearer".to_string(),
        );
        let dbg = format!("{lock:?}");
        assert!(!dbg.contains("top-secret-bearer"), "leaked: {dbg}");
        assert!(dbg.contains("***REDACTED***"));
    }
}
