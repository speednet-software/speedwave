//! Startup self-heal of legacy `oauth/<project>/<service>.json` whose IdP
//! identity sits at top level instead of nested under `providerData`
//! (ADR-060 §addendum). Shape-only, best-effort, idempotent.

use std::path::Path;

use crate::consts;

/// Top-level keys lifted into `providerData` — SSOT for the IdP identity keys,
/// pinned to the descriptor SSOT by
/// `identity_keys_match_oauth_state_provider_data_descriptors`.
pub const IDENTITY_KEYS: &[&str] = &["clientId", "tenantId"];

/// Run migration once at startup; returns the count of files rewritten.
/// Callers must NOT log this return value (CodeQL cleartext-logging).
pub fn run_oauth_state_migration_at_startup() -> usize {
    run_with_data_dir(consts::data_dir())
}

/// Inner entry point parameterised by the data dir. Tests pass an explicit tmp
/// dir to avoid the `consts::data_dir()` `OnceLock` cache shared across the
/// `cargo test` binary.
fn run_with_data_dir(data_dir: &Path) -> usize {
    let oauth_root = data_dir.join(consts::OAUTH_SUBDIR);
    if !oauth_root.exists() {
        return 0;
    }
    let projects = match std::fs::read_dir(&oauth_root) {
        Ok(e) => e,
        Err(e) => {
            log::warn!(
                "cannot read oauth state directory {}: {e}",
                oauth_root.display()
            );
            return 0;
        }
    };
    let mut migrated = 0usize;
    for project in projects {
        let project = match project {
            Ok(e) => e,
            Err(e) => {
                log::warn!("skipping unreadable oauth state entry: {e}");
                continue;
            }
        };
        let project_path = project.path();
        if !project_path.is_dir() {
            continue;
        }
        migrated += migrate_project_dir(&project_path);
    }
    migrated
}

/// Migrate every `<service>.json` in one project dir. Returns how many files
/// were rewritten.
fn migrate_project_dir(project_dir: &Path) -> usize {
    let entries = match std::fs::read_dir(project_dir) {
        Ok(e) => e,
        Err(e) => {
            log::warn!(
                "cannot read oauth project directory {}: {e}",
                project_dir.display()
            );
            return 0;
        }
    };
    let mut migrated = 0usize;
    for entry in entries {
        let path = match entry {
            Ok(e) => e.path(),
            Err(e) => {
                log::warn!("skipping unreadable oauth state entry: {e}");
                continue;
            }
        };
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if migrate_file(&path) {
            migrated += 1;
            log::info!("healed legacy oauth state layout in {}", path.display());
        }
    }
    migrated
}

/// Migrate one file. Returns `true` if it was rewritten; never destroys data.
fn migrate_file(path: &Path) -> bool {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("cannot read oauth state file {}: {e}", path.display());
            return false;
        }
    };
    let mut value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let Some(obj) = value.as_object_mut() else {
        return false;
    };
    if !needs_migration(obj) {
        return false;
    }
    if !nest_identity(obj) {
        return false;
    }
    let body = match serde_json::to_string_pretty(&value) {
        Ok(s) => s + "\n",
        Err(e) => {
            log::warn!(
                "cannot serialise migrated oauth state {}: {e}",
                path.display()
            );
            return false;
        }
    };
    match crate::fs_perms::write_restricted_file(path, &body) {
        Ok(()) => true,
        Err(e) => {
            log::warn!("cannot write migrated oauth state {}: {e}", path.display());
            false
        }
    }
}

/// A file needs migration when `providerData` is not already a plain object AND
/// at least one identity key sits at top level as a string.
fn needs_migration(obj: &serde_json::Map<String, serde_json::Value>) -> bool {
    let already_nested = obj.get("providerData").is_some_and(|v| v.is_object());
    if already_nested {
        return false;
    }
    IDENTITY_KEYS
        .iter()
        .any(|k| obj.get(*k).is_some_and(|v| v.is_string()))
}

/// Move top-level identity strings under a fresh `providerData` object and drop
/// the top-level copies. Returns `true` if at least one key was moved. Does not
/// touch an existing `providerData` — callers gate on [`needs_migration`].
fn nest_identity(obj: &mut serde_json::Map<String, serde_json::Value>) -> bool {
    let mut provider_data = serde_json::Map::new();
    for &key in IDENTITY_KEYS {
        if let Some(serde_json::Value::String(s)) = obj.remove(key) {
            provider_data.insert(key.to_string(), serde_json::Value::String(s));
        }
    }
    if provider_data.is_empty() {
        return false;
    }
    obj.insert(
        "providerData".to_string(),
        serde_json::Value::Object(provider_data),
    );
    true
}

/// snake_case descriptor key → camelCase property name in `oauth.json`.
/// SSOT for the mapping; the Desktop oauth-state paths delegate here.
pub fn oauth_json_key_for(key: &str) -> &str {
    match key {
        "client_id" => "clientId",
        "tenant_id" => "tenantId",
        "refresh_token" => "refreshToken",
        // Never interpolate `other` — may carry caller-supplied values (CodeQL false positive).
        other => {
            debug_assert!(
                !other.contains('_'),
                "oauth_json_key_for: unknown snake_case key — add an arm",
            );
            #[cfg(not(debug_assertions))]
            if other.contains('_') {
                log::warn!("unknown snake_case oauth state key — add a mapping arm");
            }
            other
        }
    }
}

/// Heal legacy ADR-060 layout in place: ensure `providerData` is a plain object,
/// lifting [`IDENTITY_KEYS`] strings into it. SSOT for startup + Desktop save.
pub fn ensure_provider_data_object(obj: &mut serde_json::Map<String, serde_json::Value>) {
    if obj.get("providerData").is_some_and(|v| v.is_object()) {
        return;
    }
    let mut provider_data = serde_json::Map::new();
    for &key in IDENTITY_KEYS {
        if let Some(serde_json::Value::String(s)) = obj.remove(key) {
            provider_data.insert(key.to_string(), serde_json::Value::String(s));
        }
    }
    obj.insert(
        "providerData".to_string(),
        serde_json::Value::Object(provider_data),
    );
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    fn sp_path(data_dir: &Path, project: &str) -> std::path::PathBuf {
        data_dir
            .join(consts::OAUTH_SUBDIR)
            .join(project)
            .join("sharepoint.json")
    }

    fn read_json(path: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// Drift guard: `IDENTITY_KEYS` must match the camelCase JSON keys of every
    /// `OAuthStateProviderData`-tagged descriptor field, mapped through
    /// `oauth_json_key_for`.
    #[test]
    fn identity_keys_match_oauth_state_provider_data_descriptors() {
        let mut expected: Vec<String> = consts::TOGGLEABLE_MCP_SERVICES
            .iter()
            .flat_map(|svc| svc.auth_fields.iter())
            .filter(|f| f.storage == consts::FieldStorage::OAuthStateProviderData)
            .map(|f| oauth_json_key_for(f.key).to_string())
            .collect();
        expected.sort();
        expected.dedup();

        let mut got: Vec<String> = IDENTITY_KEYS.iter().map(|s| s.to_string()).collect();
        got.sort();

        assert_eq!(
            got, expected,
            "IDENTITY_KEYS drifted from the OAuthStateProviderData descriptors in consts.rs — \
             update IDENTITY_KEYS here AND OAUTH_IDENTITY_KEYS in desktop integrations_cmd.rs"
        );
    }

    #[test]
    fn migrates_legacy_complete_top_level_identity() {
        // The `.speedwave-dev/speedwave` shape: full state, identity top-level.
        let tmp = tempfile::tempdir().unwrap();
        let path = sp_path(tmp.path(), "speedwave");
        write(
            &path,
            r#"{
                "clientId": "cid-1",
                "tenantId": "tid-1",
                "provider": "microsoft",
                "refreshToken": "rt-secret",
                "scopes": ["a", "b"],
                "grantedScopes": ["a"],
                "expiresAt": "2026-01-01T00:00:00.000Z",
                "lastRefreshAt": "2026-01-01T00:00:00.000Z"
            }"#,
        );

        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 1);

        let j = read_json(&path);
        assert_eq!(j["providerData"]["clientId"], "cid-1");
        assert_eq!(j["providerData"]["tenantId"], "tid-1");
        // Top-level identity removed.
        assert!(j.get("clientId").is_none());
        assert!(j.get("tenantId").is_none());
        // Everything else preserved verbatim.
        assert_eq!(j["provider"], "microsoft");
        assert_eq!(j["refreshToken"], "rt-secret");
        assert_eq!(j["scopes"], serde_json::json!(["a", "b"]));
        assert_eq!(j["grantedScopes"], serde_json::json!(["a"]));
        assert_eq!(j["expiresAt"], "2026-01-01T00:00:00.000Z");
        assert_eq!(j["lastRefreshAt"], "2026-01-01T00:00:00.000Z");
    }

    #[test]
    fn migrates_partial_identity_without_refresh_token() {
        // The `presales` shape: only identity, no refreshToken (fabricate nothing).
        let tmp = tempfile::tempdir().unwrap();
        let path = sp_path(tmp.path(), "presales");
        write(
            &path,
            r#"{"clientId": "cid", "provider": "microsoft", "tenantId": "tid"}"#,
        );

        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 1);

        let j = read_json(&path);
        assert_eq!(j["providerData"]["clientId"], "cid");
        assert_eq!(j["providerData"]["tenantId"], "tid");
        assert!(j.get("refreshToken").is_none());
        assert!(j.get("clientId").is_none());
        assert!(j.get("tenantId").is_none());
    }

    #[test]
    fn is_noop_when_already_nested() {
        let tmp = tempfile::tempdir().unwrap();
        let path = sp_path(tmp.path(), "ok");
        let original = r#"{
  "provider": "microsoft",
  "providerData": {
    "clientId": "cid",
    "tenantId": "tid"
  },
  "refreshToken": "rt"
}
"#;
        write(&path, original);

        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 0);
        // Byte-identical — not rewritten.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn migrates_when_provider_data_is_null_but_top_level_identity_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let path = sp_path(tmp.path(), "p");
        write(
            &path,
            r#"{"provider": "microsoft", "providerData": null, "clientId": "cid", "tenantId": "tid"}"#,
        );

        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 1);
        let j = read_json(&path);
        assert_eq!(j["providerData"]["clientId"], "cid");
        assert_eq!(j["providerData"]["tenantId"], "tid");
    }

    #[test]
    fn migrates_when_provider_data_is_array_but_top_level_identity_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let path = sp_path(tmp.path(), "p");
        write(
            &path,
            r#"{"provider": "microsoft", "providerData": [], "clientId": "cid"}"#,
        );

        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 1);
        let j = read_json(&path);
        assert_eq!(j["providerData"]["clientId"], "cid");
    }

    #[test]
    fn migrates_only_client_id_when_tenant_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let path = sp_path(tmp.path(), "p");
        write(&path, r#"{"provider": "microsoft", "clientId": "cid"}"#);

        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 1);
        let j = read_json(&path);
        assert_eq!(j["providerData"]["clientId"], "cid");
        assert!(j["providerData"].get("tenantId").is_none());
        assert!(j.get("clientId").is_none());
    }

    #[test]
    fn leaves_corrupt_json_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let path = sp_path(tmp.path(), "p");
        write(&path, "{not valid json");

        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 0);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not valid json");
    }

    #[test]
    fn leaves_non_object_root_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let path = sp_path(tmp.path(), "p");
        write(&path, r#"["array", "root"]"#);

        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 0);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"["array", "root"]"#
        );
    }

    #[test]
    fn leaves_file_with_no_recoverable_identity_untouched() {
        // providerData absent and no top-level identity: must not touch it.
        let tmp = tempfile::tempdir().unwrap();
        let path = sp_path(tmp.path(), "p");
        let original = r#"{"provider": "microsoft", "refreshToken": "rt"}"#;
        write(&path, original);

        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 0);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn ignores_non_string_top_level_identity() {
        // A numeric clientId is not a recoverable identity string.
        let tmp = tempfile::tempdir().unwrap();
        let path = sp_path(tmp.path(), "p");
        let original = r#"{"provider": "microsoft", "clientId": 123}"#;
        write(&path, original);

        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 0);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn migrates_multiple_projects_in_one_pass() {
        let tmp = tempfile::tempdir().unwrap();
        // legacy → migrated
        write(
            &sp_path(tmp.path(), "a"),
            r#"{"provider": "microsoft", "clientId": "c", "tenantId": "t"}"#,
        );
        // already good → no-op
        write(
            &sp_path(tmp.path(), "b"),
            r#"{"provider": "microsoft", "providerData": {"clientId": "c"}}"#,
        );
        // corrupt → no-op
        write(&sp_path(tmp.path(), "c"), "garbage");

        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 1);
    }

    #[test]
    fn migrates_non_sharepoint_service_json() {
        // The shape rule is provider-agnostic, not SharePoint-specific.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp
            .path()
            .join(consts::OAUTH_SUBDIR)
            .join("p")
            .join("future.json");
        write(
            &path,
            r#"{"provider": "microsoft", "clientId": "c", "tenantId": "t"}"#,
        );

        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 1);
        assert_eq!(read_json(&path)["providerData"]["clientId"], "c");
    }

    #[test]
    fn ignores_non_json_files() {
        let tmp = tempfile::tempdir().unwrap();
        let bm = tmp
            .path()
            .join(consts::OAUTH_SUBDIR)
            .join("p")
            .join(".bearer-map.json");
        // .bearer-map.json IS .json but has no identity keys → untouched.
        write(&bm, r#"{"bearer-abc": "sharepoint"}"#);
        let audit = tmp
            .path()
            .join(consts::OAUTH_SUBDIR)
            .join("p")
            .join("audit.log");
        write(&audit, "not json at all");

        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 0);
        assert_eq!(std::fs::read_to_string(&audit).unwrap(), "not json at all");
    }

    #[test]
    fn is_noop_when_oauth_root_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let n = run_with_data_dir(tmp.path());
        assert_eq!(n, 0);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_0o600_file_and_0o700_parent_after_rewrite() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let path = sp_path(tmp.path(), "p");
        write(
            &path,
            r#"{"provider": "microsoft", "clientId": "c", "tenantId": "t"}"#,
        );
        let parent = path.parent().unwrap();
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        run_with_data_dir(tmp.path());

        let file_mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(file_mode, 0o600, "rewritten oauth.json must stay 0o600");
        let parent_mode = std::fs::metadata(parent).unwrap().permissions().mode() & 0o777;
        assert_eq!(parent_mode, 0o700, "oauth/<project> dir must stay 0o700");
    }

    #[cfg(unix)]
    #[test]
    fn does_not_crash_on_read_only_project_dir() {
        // A read-only project dir blocks the rewrite: migration must log + skip, not panic.
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let path = sp_path(tmp.path(), "ro");
        write(
            &path,
            r#"{"provider": "microsoft", "clientId": "c", "tenantId": "t"}"#,
        );
        let parent = path.parent().unwrap();
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o500)).unwrap();

        // Must not panic.
        let _ = run_with_data_dir(tmp.path());

        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
}
