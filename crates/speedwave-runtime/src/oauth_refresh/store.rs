use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Deserialize;

use super::provider::{ErrorCode, GrantType, RefreshResponse};
use crate::oauth_persist::{write_oauth_state, OAuthStateParams};
use crate::{consts, fs_perms, plugin};

pub(super) const ACCESS_TOKEN_FILE: &str = "access_token";

pub(super) struct Paths {
    pub(super) state: PathBuf,
    pub(super) lock: PathBuf,
    pub(super) audit: PathBuf,
    pub(super) token_dir: PathBuf,
    access_token: PathBuf,
}

impl Paths {
    pub(super) fn new(data_dir: &Path, project: &str, service: &str) -> Self {
        let project_dir = project_dir(data_dir, project);
        let token_dir = plugin::token_dir_in(data_dir, project, service);
        Self {
            state: plugin::oauth_state_file_in(data_dir, project, service),
            lock: project_dir.join(format!("{service}.lock")),
            audit: project_dir.join(consts::OAUTH_LOG_FILE),
            access_token: token_dir.join(ACCESS_TOKEN_FILE),
            token_dir,
        }
    }
}

pub(super) struct OAuthState {
    pub(super) provider: String,
    pub(super) grant_type: Option<GrantType>,
    pub(super) provider_data: BTreeMap<String, String>,
    pub(super) scopes: Vec<String>,
    pub(super) refresh_token: String,
    pub(super) expires_at: DateTime<Utc>,
    pub(super) last_refresh_at: DateTime<Utc>,
}

impl OAuthState {
    pub(super) fn grant(&self) -> GrantType {
        self.grant_type.unwrap_or(GrantType::RefreshToken)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredState {
    provider: String,
    #[serde(default)]
    grant_type: Option<String>,
    provider_data: BTreeMap<String, String>,
    scopes: Vec<String>,
    #[serde(rename = "grantedScopes")]
    _granted_scopes: Vec<String>,
    refresh_token: String,
    expires_at: String,
    last_refresh_at: String,
}

pub(super) fn services(data_dir: &Path, project: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(project_dir(data_dir, project)) else {
        return Vec::new();
    };
    let mut services: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            name.strip_suffix(".json").map(str::to_string)
        })
        .filter(|service| plugin::is_valid_slug(service))
        .filter(|service| {
            is_state_file(&project_dir(data_dir, project).join(format!("{service}.json")))
        })
        .collect();
    services.sort();
    services
}

fn is_state_file(path: &Path) -> bool {
    if path.file_name().and_then(|n| n.to_str()) == Some(consts::PER_PROJECT_LOCK_FILE) {
        return false;
    }
    let Ok(Some(text)) = fs_perms::read_regular_file_no_follow(path) else {
        return true;
    };
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(value) => value.get("provider").is_some(),
        Err(_) => true,
    }
}

pub(super) fn load(path: &Path) -> Result<Option<OAuthState>, ErrorCode> {
    let Some(text) =
        fs_perms::read_regular_file_no_follow(path).map_err(|_| ErrorCode::MalformedState)?
    else {
        return Ok(None);
    };
    let stored: StoredState = serde_json::from_str(&text).map_err(|_| ErrorCode::MalformedState)?;
    let grant_type = match stored.grant_type.as_deref() {
        None => None,
        Some(raw) => Some(GrantType::parse(raw).ok_or(ErrorCode::MalformedState)?),
    };
    let refresh_grant = grant_type.unwrap_or(GrantType::RefreshToken) == GrantType::RefreshToken;
    if stored.provider.is_empty() || (refresh_grant && stored.refresh_token.is_empty()) {
        return Err(ErrorCode::MalformedState);
    }
    Ok(Some(OAuthState {
        provider: stored.provider,
        grant_type,
        provider_data: stored.provider_data,
        scopes: stored.scopes,
        refresh_token: stored.refresh_token,
        expires_at: parse_time(&stored.expires_at)?,
        last_refresh_at: parse_time(&stored.last_refresh_at)?,
    }))
}

fn parse_time(raw: &str) -> Result<DateTime<Utc>, ErrorCode> {
    DateTime::parse_from_rfc3339(raw)
        .map(|t| t.with_timezone(&Utc))
        .map_err(|_| ErrorCode::MalformedState)
}

pub(super) fn persist(
    paths: &Paths,
    state: &OAuthState,
    response: &RefreshResponse,
) -> Result<(), ErrorCode> {
    let params = OAuthStateParams {
        provider: &state.provider,
        grant_type: state.grant_type.map(GrantType::as_str),
        provider_data: state.provider_data.clone(),
        scopes: state.scopes.clone(),
        granted_scopes: response.granted_scopes.clone(),
        refresh_token: response
            .refresh_token
            .as_deref()
            .unwrap_or(&state.refresh_token),
        expires_in: response.expires_in,
    };
    write_oauth_state(&paths.state, &params).map_err(|_| ErrorCode::PersistFailed)?;
    fs_perms::ensure_owner_only_dir(&paths.token_dir).map_err(|_| ErrorCode::PersistFailed)?;
    fs_perms::write_restricted_file(&paths.access_token, &response.access_token)
        .map_err(|_| ErrorCode::PersistFailed)
}

fn project_dir(data_dir: &Path, project: &str) -> PathBuf {
    data_dir.join(consts::OAUTH_SUBDIR).join(project)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use super::*;

    fn write_state(path: &Path, json: serde_json::Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, json.to_string()).unwrap();
    }

    fn valid_state() -> serde_json::Value {
        serde_json::json!({
            "provider": "slack",
            "providerData": {"clientId": "cid"},
            "scopes": ["chat:write"],
            "grantedScopes": ["chat:write"],
            "refreshToken": "rt",
            "expiresAt": "2026-11-18T10:00:00.000Z",
            "lastRefreshAt": "2026-11-17T22:00:00.000Z",
        })
    }

    #[test]
    fn loads_the_current_state_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("slack.json");
        write_state(&path, valid_state());
        let state = load(&path).ok().flatten().unwrap();
        assert_eq!(state.provider, "slack");
        assert_eq!(state.grant_type, None);
        assert_eq!(state.grant(), GrantType::RefreshToken);
        assert_eq!(state.provider_data["clientId"], "cid");
        assert_eq!(state.refresh_token, "rt");
        assert_eq!(
            state
                .expires_at
                .signed_duration_since(state.last_refresh_at)
                .num_hours(),
            12
        );
    }

    #[test]
    fn a_missing_file_is_none_and_a_broken_one_is_malformed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(load(&dir.path().join("none.json")), Ok(None)));
        let path = dir.path().join("bad.json");
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(load(&path).err(), Some(ErrorCode::MalformedState));

        let mut state = valid_state();
        state["expiresAt"] = "tomorrow".into();
        write_state(&path, state);
        assert_eq!(load(&path).err(), Some(ErrorCode::MalformedState));

        let mut state = valid_state();
        state["refreshToken"] = "".into();
        write_state(&path, state);
        assert_eq!(load(&path).err(), Some(ErrorCode::MalformedState));

        let mut state = valid_state();
        state["grantType"] = "device_code".into();
        write_state(&path, state);
        assert_eq!(load(&path).err(), Some(ErrorCode::MalformedState));
    }

    #[test]
    fn client_credentials_state_may_have_an_empty_refresh_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.json");
        let mut state = valid_state();
        state["grantType"] = "client_credentials".into();
        state["refreshToken"] = "".into();
        write_state(&path, state);
        let loaded = load(&path).ok().flatten().unwrap();
        assert_eq!(loaded.grant(), GrantType::ClientCredentials);
    }

    #[test]
    fn lists_only_service_state_files() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join(consts::OAUTH_SUBDIR).join("proj");
        std::fs::create_dir_all(&project).unwrap();
        for name in [
            "slack.json",
            "sharepoint.json",
            "glpi.seed.json",
            "slack.lock",
            "audit.log",
            ".bearer-map.json",
            "Bad_Name.json",
        ] {
            std::fs::write(project.join(name), valid_state().to_string()).unwrap();
        }
        assert_eq!(services(dir.path(), "proj"), vec!["sharepoint", "slack"]);
        assert!(services(dir.path(), "other").is_empty());
    }

    #[test]
    fn a_stray_lock_file_or_non_state_json_is_not_a_service() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join(consts::OAUTH_SUBDIR).join("proj");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join(consts::PER_PROJECT_LOCK_FILE),
            valid_state().to_string(),
        )
        .unwrap();
        std::fs::write(project.join("other.json"), r#"{"pid":1,"port":2}"#).unwrap();
        assert!(services(dir.path(), "proj").is_empty());
    }

    #[test]
    fn a_broken_state_file_still_counts_as_a_service() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join(consts::OAUTH_SUBDIR).join("proj");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("slack.json"), "{not json").unwrap();
        assert_eq!(services(dir.path(), "proj"), vec!["slack"]);
    }

    #[test]
    fn persist_rotates_the_refresh_token_and_writes_the_access_token() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths.state, valid_state());
        let state = load(&paths.state).ok().flatten().unwrap();
        let response = RefreshResponse {
            access_token: "new-at".to_string(),
            refresh_token: Some("new-rt".to_string()),
            expires_in: 3600,
            granted_scopes: vec!["chat:write".to_string(), "search:read".to_string()],
        };
        persist(&paths, &state, &response).ok().unwrap();

        let saved = load(&paths.state).ok().flatten().unwrap();
        assert_eq!(saved.refresh_token, "new-rt");
        assert_eq!(saved.provider_data["clientId"], "cid");
        assert_eq!(
            saved
                .expires_at
                .signed_duration_since(saved.last_refresh_at)
                .num_seconds(),
            3600
        );
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&paths.state).unwrap()).unwrap();
        assert_eq!(raw["grantedScopes"][1], "search:read");
        assert_eq!(
            std::fs::read_to_string(paths.token_dir.join("access_token")).unwrap(),
            "new-at"
        );
    }

    #[test]
    fn persist_keeps_the_old_refresh_token_when_the_provider_does_not_rotate() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths.state, valid_state());
        let state = load(&paths.state).ok().flatten().unwrap();
        let response = RefreshResponse {
            access_token: "at".to_string(),
            refresh_token: None,
            expires_in: 60,
            granted_scopes: Vec::new(),
        };
        persist(&paths, &state, &response).ok().unwrap();
        assert_eq!(
            load(&paths.state).ok().flatten().unwrap().refresh_token,
            "rt"
        );
    }
}
