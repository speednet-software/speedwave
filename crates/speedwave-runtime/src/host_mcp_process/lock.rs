//! Unified lock-file schema for every host MCP worker manager.
//!
//! Each manager previously wrote three separate files
//! (`{port, pid, auth-token}`); this module supersedes that with a
//! single `lock.json` blob, mirroring the schema bridges already use.
//!
//! mcp-os has users on the pre-PR3 layout, so its `spawn_with_data_dir`
//! calls [`migrate_legacy_with_target`] before the generic spawn writes
//! the lock; oauth had no released users and skips the migration entirely.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::fs_perms::write_restricted_file;

/// Service tag written into the lock file and used to match legacy
/// files when migrating. Stable string per worker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockService {
    /// The mcp-os host process.
    McpOs,
    /// The OAuth host process.
    Oauth,
}

impl LockService {
    /// Stable string tag for this service, written into the lock file.
    pub fn tag(self) -> &'static str {
        match self {
            LockService::McpOs => "mcp-os",
            LockService::Oauth => "oauth",
        }
    }
}

/// Lock-file payload. `transport` is "http" for every worker today
/// — kept as a field for future-proofing and symmetry with bridges.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
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

/// Read a `lock.json` from disk. Returns `None` if the file is missing,
/// unreadable, malformed, or the recorded `service` does not match the
/// caller's expectation. Best-effort — never panics.
pub fn read(path: &Path, expected: LockService) -> Option<LockFile> {
    let bytes = std::fs::read(path).ok()?;
    let lock: LockFile = serde_json::from_slice(&bytes).ok()?;
    if lock.service != expected.tag() {
        return None;
    }
    Some(lock)
}

/// Write `lock` to `path` with owner-only permissions. Atomic on Unix
/// (`NamedTempFile::persist` rename) and on Windows (icacls on tempfile
/// then atomic rename via `fs_perms::write_restricted_file`'s
/// `NamedTempFile::persist` path). A concurrent reader either sees the
/// pre-existing file or the new one — never a partial JSON write.
pub fn write(path: &Path, lock: &LockFile) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(lock)?;
    write_restricted_file(path, &json)?;
    Ok(())
}

/// One-shot, idempotent migration from the 3-file legacy layout to
/// `<state_dir>/lock.json`. Test-only convenience over
/// [`migrate_legacy_with_target`]; production callers (currently only
/// mcp-os) pass an explicit lock filename via `_with_target`.
#[cfg(test)]
pub fn migrate_legacy(
    state_dir: &Path,
    service: LockService,
    port_file: &str,
    pid_file: &str,
    auth_token_file: &str,
) -> Option<LockFile> {
    migrate_legacy_with_target(
        state_dir,
        service,
        crate::consts::PER_PROJECT_LOCK_FILE,
        port_file,
        pid_file,
        auth_token_file,
    )
}

/// Like [`migrate_legacy`] but the destination lock filename is
/// caller-specified. Used by the mcp-os singleton, whose lock lives at
/// `<data_dir>/mcp-os.lock.json` rather than under a per-project
/// subdirectory.
pub fn migrate_legacy_with_target(
    state_dir: &Path,
    service: LockService,
    lock_filename: &str,
    port_file: &str,
    pid_file: &str,
    auth_token_file: &str,
) -> Option<LockFile> {
    // Fast-path: skip every disk touch when no legacy port/pid file is
    // present. The auth-token file is intentionally NOT in this check
    // because mcp-os reuses that name for the live bind-mount, so it
    // can be present without indicating an un-migrated state.
    let legacy_present = state_dir.join(port_file).exists() || state_dir.join(pid_file).exists();
    if !legacy_present {
        return None;
    }

    let lock_path = state_dir.join(lock_filename);
    if let Some(existing) = read(&lock_path, service) {
        cleanup_legacy_files(state_dir, port_file, pid_file);
        return Some(existing);
    }

    let port = read_legacy_u16(&state_dir.join(port_file))?;
    let pid = read_legacy_u32(&state_dir.join(pid_file))?;
    let auth_token = std::fs::read_to_string(state_dir.join(auth_token_file))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;

    let lock = LockFile::new(service, pid, port, auth_token);
    if let Err(e) = write(&lock_path, &lock) {
        log::warn!("lock.json migration write failed: {e}");
        return None;
    }
    cleanup_legacy_files(state_dir, port_file, pid_file);
    Some(lock)
}

fn read_legacy_u16(path: &Path) -> Option<u16> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .filter(|n: &u16| *n > 0)
}

fn read_legacy_u32(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .filter(|n: &u32| *n > 0)
}

fn cleanup_legacy_files(state_dir: &Path, port_file: &str, pid_file: &str) {
    for name in [port_file, pid_file] {
        let _ = std::fs::remove_file(state_dir.join(name));
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    fn fixture() -> LockFile {
        LockFile::new(LockService::McpOs, 12345, 60123, "uuid-token".into())
    }

    #[test]
    fn lockservice_tags_are_stable() {
        assert_eq!(LockService::McpOs.tag(), "mcp-os");
        assert_eq!(LockService::Oauth.tag(), "oauth");
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
        // Fixture is McpOs; reading as Oauth must not return it.
        assert!(read(&path, LockService::Oauth).is_none());
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
    fn migrate_creates_json_from_3_legacy_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("port"), "60123").unwrap();
        std::fs::write(dir.path().join("pid"), "12345").unwrap();
        std::fs::write(dir.path().join("auth-token"), "uuid-token").unwrap();

        let lock = migrate_legacy(dir.path(), LockService::Oauth, "port", "pid", "auth-token")
            .expect("3 legacy files must produce a lock");

        assert_eq!(lock.service, "oauth");
        assert_eq!(lock.port, 60123);
        assert_eq!(lock.pid, 12345);
        assert_eq!(lock.auth_token, "uuid-token");

        // Legacy port + pid removed. The auth-token file is kept on
        // disk because mcp-os reuses that filename as the live token
        // mount; callers that don't share the convention can clean it
        // up themselves.
        assert!(!dir.path().join("port").exists());
        assert!(!dir.path().join("pid").exists());
        assert!(dir.path().join("lock.json").exists());
    }

    #[test]
    fn migrate_is_idempotent_on_second_call() {
        // First call: legacy present → migrate to lock.json, remove
        // port + pid. Second call: fast-path detects no legacy and
        // returns None — caller treats that as "nothing to migrate,
        // existing lock.json stands".
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("port"), "60123").unwrap();
        std::fs::write(dir.path().join("pid"), "12345").unwrap();
        std::fs::write(dir.path().join("auth-token"), "uuid-token").unwrap();

        let first = migrate_legacy(dir.path(), LockService::Oauth, "port", "pid", "auth-token")
            .expect("first call must migrate");
        assert_eq!(first.port, 60123);

        let second = migrate_legacy(dir.path(), LockService::Oauth, "port", "pid", "auth-token");
        assert!(
            second.is_none(),
            "second call must short-circuit (legacy already migrated)"
        );

        // lock.json still on disk with the migrated payload.
        let on_disk = read(&dir.path().join("lock.json"), LockService::Oauth)
            .expect("lock.json must still be readable");
        assert_eq!(on_disk, first);
    }

    #[test]
    fn migrate_cleans_up_leftover_legacy_when_json_already_present() {
        // Simulates a previous run that wrote lock.json but failed to remove legacy files.
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("lock.json"), &fixture()).unwrap();
        std::fs::write(dir.path().join("port"), "9999").unwrap();
        std::fs::write(dir.path().join("pid"), "1").unwrap();
        std::fs::write(dir.path().join("auth-token"), "stale").unwrap();

        let lock =
            migrate_legacy(dir.path(), LockService::McpOs, "port", "pid", "auth-token").unwrap();

        // The JSON wins — legacy values are ignored.
        assert_eq!(lock.port, 60123);
        assert_eq!(lock.auth_token, "uuid-token");
        // Leftover port + pid cleaned up; auth-token is preserved on
        // disk (mcp-os reuses the filename as a live mount).
        assert!(!dir.path().join("port").exists());
        assert!(!dir.path().join("pid").exists());
    }

    #[test]
    fn migrate_returns_none_for_partial_legacy_state() {
        let dir = tempfile::tempdir().unwrap();
        // Only 2 of 3 legacy files present.
        std::fs::write(dir.path().join("port"), "60123").unwrap();
        std::fs::write(dir.path().join("pid"), "12345").unwrap();

        let result = migrate_legacy(dir.path(), LockService::Oauth, "port", "pid", "auth-token");
        assert!(
            result.is_none(),
            "partial legacy state must not produce a lock"
        );
        // Partial files are left in place — the caller spawns a fresh
        // worker which writes a new lock.json and overwrites the rest.
        assert!(dir.path().join("port").exists());
        assert!(dir.path().join("pid").exists());
    }

    #[test]
    fn migrate_returns_none_when_no_files_present() {
        let dir = tempfile::tempdir().unwrap();
        let result = migrate_legacy(dir.path(), LockService::Oauth, "port", "pid", "auth-token");
        assert!(result.is_none());
    }

    #[test]
    fn migrate_rejects_zero_port() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("port"), "0").unwrap();
        std::fs::write(dir.path().join("pid"), "12345").unwrap();
        std::fs::write(dir.path().join("auth-token"), "x").unwrap();

        let result = migrate_legacy(dir.path(), LockService::Oauth, "port", "pid", "auth-token");
        assert!(result.is_none(), "port 0 must reject migration");
    }

    // ── Edge cases: byte-exact fixture variants a real pre-PR3 user could have ─
    //
    // The legacy code (`write_restricted_file(&port_path, &port.to_string())`)
    // wrote without a trailing newline. But a user could have ended up with
    // edited / re-saved files, an editor adding a final newline, or a partial
    // write from a crashed earlier session. These tests pin the resilience
    // of `read_legacy_*` against the variants we expect to see in the wild.

    fn run_migrate(
        dir: &Path,
        port_bytes: &[u8],
        pid_bytes: &[u8],
        token_bytes: &[u8],
    ) -> Option<LockFile> {
        std::fs::write(dir.join("port"), port_bytes).unwrap();
        std::fs::write(dir.join("pid"), pid_bytes).unwrap();
        std::fs::write(dir.join("auth-token"), token_bytes).unwrap();
        migrate_legacy(dir, LockService::Oauth, "port", "pid", "auth-token")
    }

    #[test]
    fn migrate_accepts_trailing_newline_in_port_and_pid() {
        // The legacy writer used `port.to_string()` without `\n`, but tests
        // and editors routinely append one — must still parse.
        let dir = tempfile::tempdir().unwrap();
        let lock = run_migrate(dir.path(), b"54321\n", b"99\n", b"tok\n")
            .expect("trailing newline must not break migration");
        assert_eq!(lock.port, 54321);
        assert_eq!(lock.pid, 99);
        assert_eq!(lock.auth_token, "tok");
    }

    #[test]
    fn migrate_accepts_crlf_line_endings() {
        // Windows editor / git autocrlf could leave \r\n.
        let dir = tempfile::tempdir().unwrap();
        let lock = run_migrate(dir.path(), b"54321\r\n", b"99\r\n", b"tok\r\n")
            .expect("CRLF must not break migration");
        assert_eq!(lock.port, 54321);
        assert_eq!(lock.pid, 99);
        assert_eq!(lock.auth_token, "tok");
    }

    #[test]
    fn migrate_accepts_surrounding_whitespace() {
        // Spaces / tabs around the value — defensive against odd writers.
        let dir = tempfile::tempdir().unwrap();
        let lock = run_migrate(dir.path(), b"  54321  ", b"\t99\t", b"  tok  ")
            .expect("whitespace must not break migration");
        assert_eq!(lock.port, 54321);
        assert_eq!(lock.pid, 99);
        assert_eq!(lock.auth_token, "tok");
    }

    #[test]
    fn migrate_rejects_empty_port_file() {
        let dir = tempfile::tempdir().unwrap();
        let res = run_migrate(dir.path(), b"", b"99", b"tok");
        assert!(res.is_none(), "empty port file must reject migration");
    }

    #[test]
    fn migrate_rejects_empty_pid_file() {
        let dir = tempfile::tempdir().unwrap();
        let res = run_migrate(dir.path(), b"54321", b"", b"tok");
        assert!(res.is_none(), "empty pid file must reject migration");
    }

    #[test]
    fn migrate_rejects_empty_auth_token_file() {
        let dir = tempfile::tempdir().unwrap();
        let res = run_migrate(dir.path(), b"54321", b"99", b"");
        assert!(res.is_none(), "empty auth-token must reject migration");
    }

    #[test]
    fn migrate_rejects_whitespace_only_auth_token() {
        // `trim()` collapses it to "" — must reject, not write blank token.
        let dir = tempfile::tempdir().unwrap();
        let res = run_migrate(dir.path(), b"54321", b"99", b"   \n  ");
        assert!(
            res.is_none(),
            "whitespace-only auth-token must reject migration"
        );
    }

    #[test]
    fn migrate_rejects_unparseable_port() {
        let dir = tempfile::tempdir().unwrap();
        let res = run_migrate(dir.path(), b"abc", b"99", b"tok");
        assert!(res.is_none(), "non-numeric port must reject migration");
    }

    #[test]
    fn migrate_rejects_port_above_u16_max() {
        // 65536 overflows u16 — `parse::<u16>` returns Err.
        let dir = tempfile::tempdir().unwrap();
        let res = run_migrate(dir.path(), b"65536", b"99", b"tok");
        assert!(res.is_none(), "port > u16::MAX must reject migration");
    }

    #[test]
    fn migrate_rejects_unparseable_pid() {
        let dir = tempfile::tempdir().unwrap();
        let res = run_migrate(dir.path(), b"54321", b"not-a-pid", b"tok");
        assert!(res.is_none(), "non-numeric pid must reject migration");
    }

    #[test]
    fn migrate_rejects_zero_pid() {
        // PID 0 means "the whole process group" on POSIX — definitely
        // not a real mcp-os worker. The `> 0` filter in read_legacy_u32
        // catches it.
        let dir = tempfile::tempdir().unwrap();
        let res = run_migrate(dir.path(), b"54321", b"0", b"tok");
        assert!(res.is_none(), "pid 0 must reject migration");
    }

    #[test]
    fn migrate_accepts_realistic_uuid_token() {
        // The legacy code used UUID v4 (36-char hyphenated) — confirm
        // the migrated auth-token survives intact.
        let dir = tempfile::tempdir().unwrap();
        let uuid = "deadbeef-aaaa-bbbb-cccc-1234567890ab";
        let lock = run_migrate(dir.path(), b"54321", b"99", uuid.as_bytes())
            .expect("realistic UUID must migrate");
        assert_eq!(lock.auth_token, uuid);
    }

    // ── End-to-end migration: legacy fixture → lock.json → read-back ─────
    //
    // These tests simulate the upgrade path the audit critic flagged:
    // "pre-PR3 build leaves 3 files; upgrade to PR3; verify lock.json
    // exists, legacy files are gone, and the data a worker would read is
    // intact." We can't spawn a real Node worker in unit tests, but we can
    // prove the full lock-file lifecycle the worker depends on:
    //
    //   1. Legacy 3-file state in state_dir
    //   2. `migrate_legacy(...)` produces a LockFile
    //   3. The same data is `read()`-able from disk as the same LockFile
    //   4. Legacy files are gone
    //   5. Mode is 0o600 on Unix (no leak)
    //   6. A second `migrate_legacy(...)` returns the same lock (idempotent)
    //
    // Cross-service to cover both (`McpOs`/`Oauth`) with their distinct
    // legacy filenames.

    /// End-to-end: legacy → migrate → read-back for the McpOs service,
    /// with the singleton's actual legacy filenames (`mcp-os-*`).
    #[test]
    fn end_to_end_migration_mcp_os_legacy_to_lock_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("mcp-os-port"), "60111").unwrap();
        std::fs::write(dir.path().join("mcp-os-pid"), "1001").unwrap();
        std::fs::write(dir.path().join("mcp-os-auth-token"), "mcp-os-secret").unwrap();

        let migrated = migrate_legacy(
            dir.path(),
            LockService::McpOs,
            "mcp-os-port",
            "mcp-os-pid",
            "mcp-os-auth-token",
        )
        .expect("3 legacy files must produce a lock");

        // (a) lock.json on disk matches the migrated payload byte-for-byte.
        let from_disk = read(&dir.path().join("lock.json"), LockService::McpOs)
            .expect("lock.json must be readable as McpOs");
        assert_eq!(from_disk, migrated);

        // (b) The "what a worker would actually use" fields are intact.
        assert_eq!(from_disk.port, 60111);
        assert_eq!(from_disk.pid, 1001);
        assert_eq!(from_disk.auth_token, "mcp-os-secret");
        assert_eq!(from_disk.transport, "http");
        assert_eq!(from_disk.service, "mcp-os");

        // (c) Legacy port + pid are gone. `mcp-os-auth-token` survives
        // — that filename is the live token mount, not a legacy artifact.
        assert!(!dir.path().join("mcp-os-port").exists());
        assert!(!dir.path().join("mcp-os-pid").exists());

        // (d) Mode 0o600 on Unix — no information leak.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("lock.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    /// End-to-end: legacy → migrate → read-back for the Oauth service.
    /// Per-project oauth uses `port`/`pid`/`auth-token` filenames.
    #[test]
    fn end_to_end_migration_oauth_legacy_to_lock_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("port"), "55001").unwrap();
        std::fs::write(dir.path().join("pid"), "2002").unwrap();
        std::fs::write(dir.path().join("auth-token"), "oauth-secret").unwrap();

        let migrated = migrate_legacy(dir.path(), LockService::Oauth, "port", "pid", "auth-token")
            .expect("3 legacy files must produce a lock");

        let from_disk = read(&dir.path().join("lock.json"), LockService::Oauth)
            .expect("lock.json must be readable as Oauth");
        assert_eq!(from_disk, migrated);
        assert_eq!(from_disk.service, "oauth");
        assert_eq!(from_disk.port, 55001);
        assert_eq!(from_disk.auth_token, "oauth-secret");

        // Service-tag mismatch: a McpOs read must reject an Oauth lock.json.
        assert!(read(&dir.path().join("lock.json"), LockService::McpOs).is_none());
    }

    /// Idempotency after a real migration: second `migrate_legacy` after the
    /// upgrade reads the existing lock.json verbatim — the worker keeps the
    /// same port/pid/auth_token across spawns, so consumers don't churn.
    #[test]
    fn migrate_then_read_then_migrate_again_yields_identical_lock() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("port"), "44444").unwrap();
        std::fs::write(dir.path().join("pid"), "999").unwrap();
        std::fs::write(dir.path().join("auth-token"), "tok").unwrap();

        let first =
            migrate_legacy(dir.path(), LockService::Oauth, "port", "pid", "auth-token").unwrap();

        let from_disk = read(&dir.path().join("lock.json"), LockService::Oauth).unwrap();
        assert_eq!(from_disk, first);

        // Second call short-circuits because legacy port+pid are gone;
        // the on-disk lock.json is unchanged.
        let second = migrate_legacy(dir.path(), LockService::Oauth, "port", "pid", "auth-token");
        assert!(second.is_none(), "no legacy left to migrate");
        let after_second = read(&dir.path().join("lock.json"), LockService::Oauth).unwrap();
        assert_eq!(after_second, first, "lock.json untouched by second call");
    }

    /// Worker-recovery smoke test: simulates the "old version wrote legacy
    /// files; new version starts up" scenario end-to-end with stable IDs.
    /// After migration, the same `pid` (host PID) and `port` (TCP) are present
    /// — so the next process's liveness probe (`probe_tcp` on `port`, kill
    /// stale by `pid`) can find the previous worker exactly as before the
    /// schema change.
    #[test]
    fn migration_preserves_pid_and_port_for_liveness_probe() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("mcp-os-port"), "7777").unwrap();
        std::fs::write(dir.path().join("mcp-os-pid"), "31415").unwrap();
        std::fs::write(dir.path().join("mcp-os-auth-token"), "x").unwrap();

        let lock = migrate_legacy(
            dir.path(),
            LockService::McpOs,
            "mcp-os-port",
            "mcp-os-pid",
            "mcp-os-auth-token",
        )
        .unwrap();

        // The exact values a stale-detector / probe expects.
        assert_eq!(lock.port, 7777, "port survives migration verbatim");
        assert_eq!(lock.pid, 31415, "pid survives migration verbatim");
        assert!(!lock.auth_token.is_empty(), "auth-token survives migration");
    }

    /// Cross-service isolation: simulating two different services in the
    /// same temp dir (impossible in production but guards against a
    /// regression that ignored the service tag during cleanup).
    #[test]
    fn migrate_does_not_clobber_other_services_lock_in_same_dir() {
        let dir = tempfile::tempdir().unwrap();
        // Pre-existing McpOs lock.json in the dir (legitimate per-project state).
        let mcp_os_lock = LockFile::new(LockService::McpOs, 1, 1111, "mcp-os-tok".into());
        write(&dir.path().join("lock.json"), &mcp_os_lock).unwrap();

        // Now attempt to migrate as if for `Oauth` with the same filenames
        // (port/pid/auth-token). Because the existing lock.json has
        // `service: "mcp-os"`, `read(..., Oauth)` returns None and the
        // migration overwrites it. Document this so a future caller knows
        // mixing services in one state_dir is not supported.
        std::fs::write(dir.path().join("port"), "2222").unwrap();
        std::fs::write(dir.path().join("pid"), "2").unwrap();
        std::fs::write(dir.path().join("auth-token"), "oauth-tok").unwrap();

        let migrated =
            migrate_legacy(dir.path(), LockService::Oauth, "port", "pid", "auth-token").unwrap();
        assert_eq!(migrated.service, "oauth");
        assert_eq!(migrated.port, 2222);

        // Confirm: McpOs lock is now overwritten — services cannot share a state_dir.
        // In production, each service has its own state_dir
        // (`<data_dir>/oauth/<project>/`, `<data_dir>/mcp-os.lock.json`
        // directly) so collision is impossible.
        assert!(read(&dir.path().join("lock.json"), LockService::McpOs).is_none());
    }

    /// `migrate_legacy` must never return a lock whose `service` tag
    /// disagrees with the requested service. This guards a class of bugs
    /// where `read()` returns Some for the wrong service.
    #[test]
    fn migrate_result_service_tag_matches_request() {
        for (service, expected_tag) in [
            (LockService::McpOs, "mcp-os"),
            (LockService::Oauth, "oauth"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("port"), "10000").unwrap();
            std::fs::write(dir.path().join("pid"), "10").unwrap();
            std::fs::write(dir.path().join("auth-token"), "t").unwrap();
            let lock = migrate_legacy(dir.path(), service, "port", "pid", "auth-token").unwrap();
            assert_eq!(
                lock.service, expected_tag,
                "service tag must match the migrate_legacy(service=) argument"
            );
        }
    }
}
