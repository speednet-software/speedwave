//! SSOT for writing the host-side OAuth state file (ADR-060). Shared by every
//! OAuth flow (SharePoint, GitHub, plugins) so the on-disk shape stays identical.

use std::collections::BTreeMap;
use std::path::Path;

/// RFC 3339 UTC timestamp (millis) from unix epoch millis.
pub fn iso8601_from_unix_ms(unix_ms: u64) -> String {
    let secs = (unix_ms / 1000) as i64;
    let ms = (unix_ms % 1000) as u32;
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, ms * 1_000_000)
        .unwrap_or_else(chrono::Utc::now)
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// Inputs for [`write_oauth_state`]. Mirrors the `oauth-state.ts` schema.
pub struct OAuthStateParams<'a> {
    /// Registry id: `microsoft` | `generic`.
    pub provider: &'a str,
    /// `refresh_token` | `client_credentials`. `None` omits the field
    /// (read back as `refresh_token` by the worker migration path).
    pub grant_type: Option<&'a str>,
    /// IdP-specific fields (clientId, tenantId, tokenUrl, …).
    pub provider_data: BTreeMap<String, String>,
    pub scopes: Vec<String>,
    pub granted_scopes: Vec<String>,
    pub refresh_token: &'a str,
    /// Access-token lifetime in seconds.
    pub expires_in: u64,
}

/// Writes the OAuth state JSON to `path` (0o600, parent 0o700). The caller
/// supplies an off-mount path from `plugin::oauth_state_file`.
pub fn write_oauth_state(path: &Path, params: &OAuthStateParams) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "oauth state: no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let mut obj = serde_json::Map::new();
    obj.insert("provider".into(), params.provider.into());
    if let Some(gt) = params.grant_type {
        obj.insert("grantType".into(), gt.into());
    }
    obj.insert(
        "providerData".into(),
        serde_json::to_value(&params.provider_data).map_err(|e| e.to_string())?,
    );
    obj.insert(
        "scopes".into(),
        serde_json::to_value(&params.scopes).map_err(|e| e.to_string())?,
    );
    obj.insert(
        "grantedScopes".into(),
        serde_json::to_value(&params.granted_scopes).map_err(|e| e.to_string())?,
    );
    obj.insert("refreshToken".into(), params.refresh_token.into());
    obj.insert(
        "expiresAt".into(),
        iso8601_from_unix_ms(now_ms + params.expires_in.saturating_mul(1000)).into(),
    );
    obj.insert("lastRefreshAt".into(), iso8601_from_unix_ms(now_ms).into());

    let body = serde_json::to_string_pretty(&serde_json::Value::Object(obj))
        .map_err(|e| e.to_string())?
        + "\n";
    crate::fs_perms::write_restricted_file(path, &body).map_err(|e| e.to_string())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_formats_epoch() {
        assert_eq!(iso8601_from_unix_ms(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn iso8601_has_millis_and_z() {
        let s = iso8601_from_unix_ms(1_700_000_000_123);
        assert!(s.ends_with('Z'));
        assert!(s.contains('.'));
    }

    fn read_json(path: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn writes_microsoft_shape_without_grant_type() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("p").join("sharepoint.json");
        let mut pd = BTreeMap::new();
        pd.insert("clientId".to_string(), "cid".to_string());
        pd.insert("tenantId".to_string(), "common".to_string());
        write_oauth_state(
            &path,
            &OAuthStateParams {
                provider: "microsoft",
                grant_type: None,
                provider_data: pd,
                scopes: vec!["Sites.Manage.All".to_string()],
                granted_scopes: vec!["Sites.Manage.All".to_string()],
                refresh_token: "r",
                expires_in: 3600,
            },
        )
        .unwrap();
        let json = read_json(&path);
        assert_eq!(json["provider"], "microsoft");
        assert!(
            json.get("grantType").is_none(),
            "grantType omitted when None"
        );
        assert_eq!(json["providerData"]["tenantId"], "common");
        assert_eq!(json["refreshToken"], "r");
        assert!(json["expiresAt"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn writes_generic_shape_with_grant_type() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("g.json");
        let mut pd = BTreeMap::new();
        pd.insert("tokenUrl".to_string(), "https://idp/token".to_string());
        write_oauth_state(
            &path,
            &OAuthStateParams {
                provider: "generic",
                grant_type: Some("refresh_token"),
                provider_data: pd,
                scopes: vec![],
                granted_scopes: vec![],
                refresh_token: "rt",
                expires_in: 60,
            },
        )
        .unwrap();
        let json = read_json(&path);
        assert_eq!(json["provider"], "generic");
        assert_eq!(json["grantType"], "refresh_token");
        assert_eq!(json["providerData"]["tokenUrl"], "https://idp/token");
    }

    #[cfg(unix)]
    #[test]
    fn writes_file_mode_0o600() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("m.json");
        write_oauth_state(
            &path,
            &OAuthStateParams {
                provider: "generic",
                grant_type: Some("refresh_token"),
                provider_data: BTreeMap::new(),
                scopes: vec![],
                granted_scopes: vec![],
                refresh_token: "r",
                expires_in: 1,
            },
        )
        .unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
