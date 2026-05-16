//! One-shot migration from the v1 SharePoint credential layout to the
//! ADR-060 split layout. Shared by Desktop (Tauri startup) and CLI
//! (`speedwave run`) so both surfaces see the same on-disk shape.
//!
//! v1 (pre-PR3):
//!   ~/.speedwave/tokens/<project>/sharepoint/
//!     access_token, refresh_token, client_id, tenant_id, site_id, base_path
//!
//! v2 (post-PR3):
//!   ~/.speedwave/tokens/<project>/sharepoint/
//!     access_token, site_id, base_path
//!   ~/.speedwave/oauth/<project>/sharepoint.json
//!     { provider, clientId, tenantId, scopes, grantedScopes, refreshToken,
//!       expiresAt, lastRefreshAt }
//!
//! `grantedScopes` is intentionally `[]` so the first refresh returns
//! `scope_mismatch` and the UI triggers re-consent — required because we
//! cannot know what scopes the legacy token was issued for, and PR3 bumps
//! the requested scope to `Sites.Manage.All` for PR5 (`createList`).

use std::path::Path;

use crate::consts;
use crate::fs_perms::write_restricted_file;
use crate::plugin;

/// Run the migration once at startup. Best-effort: per-project failures are
/// logged and do not abort the rest. Idempotent — projects already migrated
/// (i.e. with an existing `oauth.json`) are skipped.
///
/// Returns the number of projects migrated this run.
pub fn run_oauth_migration_at_startup() -> usize {
    run_with_data_dir(consts::data_dir())
}

/// Inner entry point parameterised by the data dir. Production callers go
/// through `run_oauth_migration_at_startup`; tests pass an explicit tmp dir
/// to avoid the `consts::data_dir()` `OnceLock` cache shared across the
/// `cargo test` binary.
fn run_with_data_dir(data_dir: &Path) -> usize {
    let tokens_root = data_dir.join("tokens");
    if !tokens_root.exists() {
        return 0;
    }
    let entries = match std::fs::read_dir(&tokens_root) {
        Ok(e) => e,
        Err(e) => {
            log::warn!(
                "migration_oauth: cannot read {}: {e}",
                tokens_root.display()
            );
            return 0;
        }
    };
    let mut migrated = 0usize;
    for entry in entries.flatten() {
        let project_path = entry.path();
        if !project_path.is_dir() {
            continue;
        }
        let project = match project_path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        match migrate_sharepoint_for_project(data_dir, &project, &project_path) {
            Ok(true) => {
                migrated += 1;
                log::info!("migration_oauth[{project}]: SharePoint credentials migrated");
            }
            Ok(false) => {}
            Err(e) => log::warn!("migration_oauth[{project}]: {e}"),
        }
    }
    migrated
}

fn migrate_sharepoint_for_project(
    data_dir: &Path,
    project: &str,
    project_dir: &Path,
) -> Result<bool, String> {
    let sp_dir = project_dir.join("sharepoint");
    if !sp_dir.is_dir() {
        return Ok(false);
    }
    let old_rt = sp_dir.join("refresh_token");
    let old_cid = sp_dir.join("client_id");
    let old_tid = sp_dir.join("tenant_id");

    // Already migrated?
    let oauth_path = plugin::oauth_state_file_in(data_dir, project, "sharepoint");
    if oauth_path.exists() {
        let _ = std::fs::remove_file(&old_rt);
        let _ = std::fs::remove_file(&old_cid);
        let _ = std::fs::remove_file(&old_tid);
        return Ok(false);
    }

    if !old_rt.exists() && !old_cid.exists() && !old_tid.exists() {
        return Ok(false);
    }
    let refresh_token =
        std::fs::read_to_string(&old_rt).map_err(|e| format!("read refresh_token: {e}"))?;
    let client_id =
        std::fs::read_to_string(&old_cid).map_err(|e| format!("read client_id: {e}"))?;
    let tenant_id =
        std::fs::read_to_string(&old_tid).map_err(|e| format!("read tenant_id: {e}"))?;
    if refresh_token.trim().is_empty() || client_id.trim().is_empty() || tenant_id.trim().is_empty()
    {
        return Err("partial old layout: refresh_token/client_id/tenant_id is empty".into());
    }

    write_oauth_json(
        data_dir,
        project,
        client_id.trim(),
        tenant_id.trim(),
        refresh_token.trim(),
    )
    .map_err(|e| e.to_string())?;

    if let Err(e) = std::fs::remove_file(&old_rt) {
        log::warn!("migration_oauth[{project}]: failed to remove old refresh_token: {e}");
    }
    if let Err(e) = std::fs::remove_file(&old_cid) {
        log::warn!("migration_oauth[{project}]: failed to remove old client_id: {e}");
    }
    if let Err(e) = std::fs::remove_file(&old_tid) {
        log::warn!("migration_oauth[{project}]: failed to remove old tenant_id: {e}");
    }
    Ok(true)
}

fn write_oauth_json(
    data_dir: &Path,
    project: &str,
    client_id: &str,
    tenant_id: &str,
    refresh_token: &str,
) -> anyhow::Result<()> {
    let path = plugin::oauth_state_file_in(data_dir, project, "sharepoint");
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("oauth state file has no parent"))?;
    std::fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
    }
    let scopes: Vec<&str> = consts::SHAREPOINT_OAUTH_SCOPES.split_whitespace().collect();
    let granted_empty: Vec<&str> = Vec::new();
    let body = serde_json::to_string_pretty(&serde_json::json!({
        "provider": "microsoft",
        "clientId": client_id,
        "tenantId": tenant_id,
        "scopes": scopes,
        "grantedScopes": granted_empty,
        "refreshToken": refresh_token,
        "expiresAt": iso8601_now_plus_hours(1),
        "lastRefreshAt": "1970-01-01T00:00:00.000Z",
    }))? + "\n";
    write_restricted_file(&path, &body)
}

fn iso8601_now_plus_hours(h: i64) -> String {
    let dt = chrono::Utc::now() + chrono::Duration::hours(h);
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(path: &Path, content: &str) {
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    /// Each test gets its own tmp data dir; we call `run_with_data_dir` directly
    /// so the migration uses *this* dir instead of the `consts::data_dir()`
    /// `OnceLock` cache shared across the `cargo test` binary.
    fn make_tmp_data_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn migrates_old_layout_to_oauth_json() {
        let tmp = make_tmp_data_dir();
        let data_dir = tmp.path();
        let project = "proj-a";
        let sp_dir = data_dir.join("tokens").join(project).join("sharepoint");
        std::fs::create_dir_all(&sp_dir).unwrap();
        write(&sp_dir.join("refresh_token"), "rt-old");
        write(
            &sp_dir.join("client_id"),
            "11111111-1111-1111-1111-111111111111",
        );
        write(&sp_dir.join("tenant_id"), "common");
        write(&sp_dir.join("access_token"), "at-old");
        write(&sp_dir.join("site_id"), "site-x");

        let n = run_with_data_dir(data_dir);
        assert_eq!(n, 1);

        let oauth_path = plugin::oauth_state_file_in(data_dir, project, "sharepoint");
        assert!(oauth_path.exists());
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&oauth_path).unwrap()).unwrap();
        assert_eq!(json["refreshToken"], "rt-old");
        assert_eq!(json["clientId"], "11111111-1111-1111-1111-111111111111");
        assert_eq!(json["tenantId"], "common");
        assert_eq!(json["grantedScopes"], serde_json::json!([]));

        assert!(!sp_dir.join("refresh_token").exists());
        assert!(!sp_dir.join("client_id").exists());
        assert!(!sp_dir.join("tenant_id").exists());

        assert!(sp_dir.join("access_token").exists());
        assert!(sp_dir.join("site_id").exists());
    }

    #[test]
    fn idempotent_when_already_migrated() {
        let tmp = make_tmp_data_dir();
        let data_dir = tmp.path();
        let project = "proj-b";
        std::fs::create_dir_all(data_dir.join("tokens").join(project).join("sharepoint")).unwrap();
        let oauth_path = plugin::oauth_state_file_in(data_dir, project, "sharepoint");
        std::fs::create_dir_all(oauth_path.parent().unwrap()).unwrap();
        write(&oauth_path, r#"{"provider":"microsoft"}"#);

        let n = run_with_data_dir(data_dir);
        assert_eq!(n, 0);
    }

    #[test]
    fn no_op_when_no_sharepoint_config() {
        let tmp = make_tmp_data_dir();
        let data_dir = tmp.path();
        std::fs::create_dir_all(data_dir.join("tokens").join("proj-c").join("slack")).unwrap();
        let n = run_with_data_dir(data_dir);
        assert_eq!(n, 0);
    }

    #[test]
    fn fails_loudly_on_partial_old_layout() {
        let tmp = make_tmp_data_dir();
        let data_dir = tmp.path();
        let project = "proj-d";
        let sp_dir = data_dir.join("tokens").join(project).join("sharepoint");
        std::fs::create_dir_all(&sp_dir).unwrap();
        write(&sp_dir.join("refresh_token"), "");
        write(&sp_dir.join("tenant_id"), "common");

        let n = run_with_data_dir(data_dir);
        assert_eq!(n, 0);
        let oauth_path = plugin::oauth_state_file_in(data_dir, project, "sharepoint");
        assert!(!oauth_path.exists());
    }
}
