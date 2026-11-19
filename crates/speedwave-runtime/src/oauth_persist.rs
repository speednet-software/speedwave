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
    /// Scopes requested at authorize time.
    pub scopes: Vec<String>,
    /// Scopes the IdP actually granted.
    pub granted_scopes: Vec<String>,
    /// Long-lived secret persisted off-mount (empty for `client_credentials`).
    pub refresh_token: &'a str,
    /// Access-token lifetime in seconds.
    pub expires_in: u64,
}

/// Upper bound on a token lifetime (10 years in seconds) — anything larger is a
/// malformed/hostile response; clamping keeps `now_ms + expires_in*1000` in range.
const MAX_EXPIRES_IN_SECS: u64 = 10 * 365 * 24 * 60 * 60;

/// Writes OAuth state JSON to `path` (0o600, parent 0o700); caller supplies an off-mount path from
/// `plugin::oauth_state_file`. Rejects non-positive `expires_in` (SSOT guard); clamps a huge one.
pub fn write_oauth_state(path: &Path, params: &OAuthStateParams) -> Result<(), String> {
    if params.expires_in == 0 {
        return Err("oauth state: expires_in must be > 0".to_string());
    }
    let expires_in = params.expires_in.min(MAX_EXPIRES_IN_SECS);
    let parent = path
        .parent()
        .ok_or_else(|| "oauth state: no parent".to_string())?;
    crate::fs_perms::ensure_owner_only_dir(parent).map_err(|e| e.to_string())?;

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
        iso8601_from_unix_ms(now_ms.saturating_add(expires_in.saturating_mul(1000))).into(),
    );
    obj.insert("lastRefreshAt".into(), iso8601_from_unix_ms(now_ms).into());

    let body = serde_json::to_string_pretty(&serde_json::Value::Object(obj))
        .map_err(|e| e.to_string())?
        + "\n";
    crate::fs_perms::write_restricted_file(path, &body).map_err(|e| e.to_string())
}

/// Top-level keys lifted into `providerData` — SSOT for the IdP identity keys, pinned to the
/// descriptor SSOT by `identity_keys_match_oauth_state_provider_data_descriptors`.
pub const IDENTITY_KEYS: &[&str] = &["clientId", "tenantId"];

/// snake_case descriptor key → camelCase property name in `oauth.json`.
/// SSOT for the mapping; the Desktop oauth-state paths delegate here.
pub fn oauth_json_key_for(key: &str) -> &str {
    match key {
        "client_id" => "clientId",
        "tenant_id" => "tenantId",
        "refresh_token" => "refreshToken",
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
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
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

    fn params_with_expires(expires_in: u64) -> OAuthStateParams<'static> {
        OAuthStateParams {
            provider: "generic",
            grant_type: Some("refresh_token"),
            provider_data: BTreeMap::new(),
            scopes: vec![],
            granted_scopes: vec![],
            refresh_token: "r",
            expires_in,
        }
    }

    #[test]
    fn rejects_zero_expires_in() {
        let tmp = tempfile::tempdir().unwrap();
        let err =
            write_oauth_state(&tmp.path().join("z.json"), &params_with_expires(0)).unwrap_err();
        assert!(err.contains("expires_in"), "got: {err}");
    }

    #[test]
    fn clamps_absurd_expires_in_without_overflow() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("big.json");
        write_oauth_state(&path, &params_with_expires(u64::MAX)).unwrap();
        let json = read_json(&path);
        let exp = json["expiresAt"].as_str().unwrap();
        assert!(exp.ends_with('Z') && exp.starts_with("20"), "got: {exp}");
    }

    #[test]
    fn identity_keys_match_oauth_state_provider_data_descriptors() {
        let mut expected: Vec<String> = crate::consts::TOGGLEABLE_MCP_SERVICES
            .iter()
            .flat_map(|svc| svc.auth_fields.iter())
            .filter(|f| f.storage == crate::consts::FieldStorage::OAuthStateProviderData)
            .map(|f| oauth_json_key_for(f.key).to_string())
            .collect();
        expected.sort();
        expected.dedup();

        let mut got: Vec<String> = IDENTITY_KEYS.iter().map(|s| s.to_string()).collect();
        got.sort();

        assert_eq!(
            got, expected,
            "IDENTITY_KEYS drifted from the OAuthStateProviderData descriptors in consts.rs, \
             update IDENTITY_KEYS here AND OAUTH_IDENTITY_KEYS in desktop integrations_cmd.rs"
        );
    }

    #[test]
    fn oauth_json_key_for_maps_snake_case_and_passes_camel_case_through() {
        assert_eq!(oauth_json_key_for("client_id"), "clientId");
        assert_eq!(oauth_json_key_for("tenant_id"), "tenantId");
        assert_eq!(oauth_json_key_for("refresh_token"), "refreshToken");
        assert_eq!(oauth_json_key_for("tokenUrl"), "tokenUrl");
    }

    #[test]
    fn ensure_provider_data_object_lifts_top_level_identity() {
        let mut obj = serde_json::Map::new();
        obj.insert("clientId".into(), "cid".into());
        obj.insert("tenantId".into(), "tid".into());
        obj.insert("refreshToken".into(), "r".into());
        ensure_provider_data_object(&mut obj);
        assert_eq!(obj["providerData"]["clientId"], "cid");
        assert_eq!(obj["providerData"]["tenantId"], "tid");
        assert!(obj.get("clientId").is_none());
        assert!(obj.get("tenantId").is_none());
        assert_eq!(obj["refreshToken"], "r");
    }

    #[test]
    fn ensure_provider_data_object_keeps_an_existing_object() {
        let mut obj = serde_json::Map::new();
        obj.insert(
            "providerData".into(),
            serde_json::json!({"clientId": "kept"}),
        );
        obj.insert("tenantId".into(), "top".into());
        ensure_provider_data_object(&mut obj);
        assert_eq!(obj["providerData"]["clientId"], "kept");
        assert!(obj["providerData"].get("tenantId").is_none());
        assert_eq!(obj["tenantId"], "top");
    }

    #[test]
    fn ensure_provider_data_object_replaces_a_non_object_value() {
        let mut obj = serde_json::Map::new();
        obj.insert("providerData".into(), serde_json::Value::Null);
        obj.insert("clientId".into(), "cid".into());
        ensure_provider_data_object(&mut obj);
        assert_eq!(obj["providerData"]["clientId"], "cid");
    }

    #[test]
    fn ensure_provider_data_object_creates_an_empty_object_without_identity() {
        let mut obj = serde_json::Map::new();
        ensure_provider_data_object(&mut obj);
        assert!(obj["providerData"].as_object().unwrap().is_empty());
    }
}
