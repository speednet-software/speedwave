use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Deserialize;
use zeroize::Zeroizing;

use super::provider::{ErrorCode, GrantType, RefreshResponse};
use crate::oauth_persist::{write_oauth_state, OAuthStateParams};
use crate::secret_store::{SecretName, SecretStore};
use crate::{consts, fs_perms, plugin};

pub(super) const ACCESS_TOKEN_FILE: &str = "access_token";
const CLIENT_SECRET_KEY: &str = "clientSecret";

pub(super) struct Paths {
    pub(super) state: PathBuf,
    pub(super) audit: PathBuf,
    data_dir: PathBuf,
    project: String,
    service: String,
}

impl Paths {
    pub(super) fn new(data_dir: &Path, project: &str, service: &str) -> Self {
        Self {
            state: plugin::oauth_state_file_in(data_dir, project, service),
            audit: project_dir(data_dir, project).join(consts::OAUTH_LOG_FILE),
            data_dir: data_dir.to_path_buf(),
            project: project.to_string(),
            service: service.to_string(),
        }
    }
}

pub(super) struct Secrets {
    store: SecretStore,
    refresh: SecretName,
    client: SecretName,
}

impl Secrets {
    pub(super) fn open(paths: &Paths) -> Result<Self, ErrorCode> {
        let store = SecretStore::open(&paths.data_dir).map_err(|_| {
            log::warn!("cannot open the secret store for service {}", paths.service);
            ErrorCode::MalformedState
        })?;
        let refresh = SecretName::oauth_refresh_token(&paths.project, &paths.service)
            .map_err(|_| ErrorCode::MalformedState)?;
        let client = SecretName::oauth_client_secret(&paths.project, &paths.service)
            .map_err(|_| ErrorCode::MalformedState)?;
        Ok(Self {
            store,
            refresh,
            client,
        })
    }

    pub(super) fn lock_path(&self) -> PathBuf {
        self.store.lock_path(&self.refresh)
    }

    pub(super) fn refresh_file(&self) -> PathBuf {
        self.store.file_path(&self.refresh)
    }

    fn read(&self, name: &SecretName) -> Result<Option<Zeroizing<String>>, ErrorCode> {
        self.store.read(name).map_err(|_| {
            log::warn!("cannot read an OAuth secret of service {}", name.service());
            ErrorCode::MalformedState
        })
    }
}

pub(super) fn read_access_token(
    data_dir: &Path,
    project: &str,
    service: &str,
) -> anyhow::Result<Zeroizing<String>> {
    let store = SecretStore::open(data_dir)?;
    let name = SecretName::integration(project, service, ACCESS_TOKEN_FILE)?;
    store
        .read(&name)?
        .ok_or_else(|| anyhow::anyhow!("no access token stored for service {service}"))
}

pub(super) struct OAuthState {
    pub(super) provider: String,
    pub(super) grant_type: Option<GrantType>,
    pub(super) provider_data: BTreeMap<String, String>,
    pub(super) scopes: Vec<String>,
    pub(super) refresh_token: Zeroizing<String>,
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

pub(super) fn load(paths: &Paths) -> Result<Option<OAuthState>, ErrorCode> {
    let Some(text) = fs_perms::read_regular_file_no_follow(&paths.state)
        .map_err(|_| ErrorCode::MalformedState)?
    else {
        return Ok(None);
    };
    let stored: StoredState = serde_json::from_str(&text).map_err(|_| ErrorCode::MalformedState)?;
    let grant_type = match stored.grant_type.as_deref() {
        None => None,
        Some(raw) => Some(GrantType::parse(raw).ok_or(ErrorCode::MalformedState)?),
    };
    let refresh_grant = grant_type.unwrap_or(GrantType::RefreshToken) == GrantType::RefreshToken;
    if stored.provider.is_empty() {
        return Err(ErrorCode::MalformedState);
    }
    let secrets = Secrets::open(paths)?;
    let refresh_token = secrets
        .read(&secrets.refresh)?
        .unwrap_or_else(|| Zeroizing::new(String::new()));
    if refresh_grant && refresh_token.is_empty() {
        return Err(ErrorCode::MalformedState);
    }
    let mut provider_data = stored.provider_data;
    if let Some(client_secret) = secrets.read(&secrets.client)? {
        provider_data.insert(
            CLIENT_SECRET_KEY.to_string(),
            client_secret.as_str().to_string(),
        );
    }
    Ok(Some(OAuthState {
        provider: stored.provider,
        grant_type,
        provider_data,
        scopes: stored.scopes,
        refresh_token,
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
        access_token: Some(&response.access_token),
        expires_in: response.expires_in,
    };
    write_oauth_state(&paths.data_dir, &paths.project, &paths.service, &params)
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
    use crate::oauth_persist::test_support::files_containing;

    const SENTINEL_RT: &str = "SENTINEL-997-refresh";
    const SENTINEL_CS: &str = "SENTINEL-997-client";
    const SENTINEL_AT: &str = "SENTINEL-997-access";

    fn write_state(path: &Path, json: serde_json::Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, json.to_string()).unwrap();
    }

    fn put_secret(data_dir: &Path, name: &SecretName, value: &str) {
        SecretStore::open(data_dir)
            .unwrap()
            .write(name, value)
            .unwrap();
    }

    fn put_refresh(data_dir: &Path, service: &str, value: &str) {
        put_secret(
            data_dir,
            &SecretName::oauth_refresh_token("proj", service).unwrap(),
            value,
        );
    }

    fn valid_state() -> serde_json::Value {
        serde_json::json!({
            "provider": "slack",
            "providerData": {"clientId": "cid"},
            "scopes": ["chat:write"],
            "grantedScopes": ["chat:write"],
            "expiresAt": "2026-11-18T10:00:00.000Z",
            "lastRefreshAt": "2026-11-17T22:00:00.000Z",
        })
    }

    fn seeded(dir: &Path) -> Paths {
        let paths = Paths::new(dir, "proj", "slack");
        write_state(&paths.state, valid_state());
        put_refresh(dir, "slack", "rt");
        paths
    }

    #[test]
    fn loads_the_current_state_format() {
        let dir = tempfile::tempdir().unwrap();
        let paths = seeded(dir.path());
        let state = load(&paths).ok().flatten().unwrap();
        assert_eq!(state.provider, "slack");
        assert_eq!(state.grant_type, None);
        assert_eq!(state.grant(), GrantType::RefreshToken);
        assert_eq!(state.provider_data["clientId"], "cid");
        assert_eq!(state.refresh_token.as_str(), "rt");
        assert_eq!(
            state
                .expires_at
                .signed_duration_since(state.last_refresh_at)
                .num_hours(),
            12
        );
    }

    #[test]
    fn the_client_secret_comes_back_into_the_provider_data() {
        let dir = tempfile::tempdir().unwrap();
        let paths = seeded(dir.path());
        put_secret(
            dir.path(),
            &SecretName::oauth_client_secret("proj", "slack").unwrap(),
            SENTINEL_CS,
        );
        let state = load(&paths).ok().flatten().unwrap();
        assert_eq!(state.provider_data["clientSecret"], SENTINEL_CS);
        assert_eq!(state.provider_data["clientId"], "cid");
    }

    #[test]
    fn a_legacy_refresh_token_in_the_file_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        let mut legacy = valid_state();
        legacy["refreshToken"] = "legacy-rt".into();
        write_state(&paths.state, legacy);
        assert_eq!(load(&paths).err(), Some(ErrorCode::MalformedState));

        put_refresh(dir.path(), "slack", "stored-rt");
        let state = load(&paths).ok().flatten().unwrap();
        assert_eq!(state.refresh_token.as_str(), "stored-rt");
    }

    #[test]
    fn a_missing_file_is_none_and_a_broken_one_is_malformed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            load(&Paths::new(dir.path(), "proj", "none")),
            Ok(None)
        ));
        let paths = Paths::new(dir.path(), "proj", "bad");
        put_refresh(dir.path(), "bad", "rt");
        std::fs::create_dir_all(paths.state.parent().unwrap()).unwrap();
        std::fs::write(&paths.state, "{not json").unwrap();
        assert_eq!(load(&paths).err(), Some(ErrorCode::MalformedState));

        let mut state = valid_state();
        state["expiresAt"] = "tomorrow".into();
        write_state(&paths.state, state);
        assert_eq!(load(&paths).err(), Some(ErrorCode::MalformedState));

        let mut state = valid_state();
        state["grantType"] = "device_code".into();
        write_state(&paths.state, state);
        assert_eq!(load(&paths).err(), Some(ErrorCode::MalformedState));
    }

    #[test]
    fn a_refresh_grant_without_a_stored_refresh_token_asks_for_a_reconnect() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths.state, valid_state());
        assert_eq!(load(&paths).err(), Some(ErrorCode::MalformedState));

        put_refresh(dir.path(), "slack", "");
        assert_eq!(load(&paths).err(), Some(ErrorCode::MalformedState));
    }

    #[test]
    fn an_unreadable_secret_asks_for_a_reconnect() {
        let dir = tempfile::tempdir().unwrap();
        let paths = seeded(dir.path());
        let secret_file = Secrets::open(&paths).unwrap().refresh_file();
        std::fs::write(&secret_file, "not a sealed line").unwrap();
        assert_eq!(load(&paths).err(), Some(ErrorCode::MalformedState));
    }

    #[test]
    fn a_missing_install_key_asks_for_a_reconnect() {
        let dir = tempfile::tempdir().unwrap();
        let paths = seeded(dir.path());
        std::fs::remove_file(dir.path().join("secret-store.key")).unwrap();
        assert_eq!(load(&paths).err(), Some(ErrorCode::MalformedState));
    }

    #[test]
    fn client_credentials_state_may_have_no_refresh_token() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "p");
        let mut state = valid_state();
        state["grantType"] = "client_credentials".into();
        write_state(&paths.state, state);
        let loaded = load(&paths).ok().flatten().unwrap();
        assert_eq!(loaded.grant(), GrantType::ClientCredentials);
        assert!(loaded.refresh_token.is_empty());
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
    fn the_lock_lives_next_to_the_refresh_token_file() {
        let dir = tempfile::tempdir().unwrap();
        let paths = seeded(dir.path());
        let lock = Secrets::open(&paths).unwrap().lock_path();
        assert_eq!(
            lock,
            dir.path()
                .join("secrets")
                .join("proj")
                .join("slack.refresh_token.enc.lock")
        );
    }

    #[test]
    fn persist_rotates_the_refresh_token_and_writes_the_access_token() {
        let dir = tempfile::tempdir().unwrap();
        let paths = seeded(dir.path());
        put_secret(
            dir.path(),
            &SecretName::oauth_client_secret("proj", "slack").unwrap(),
            SENTINEL_CS,
        );
        let state = load(&paths).ok().flatten().unwrap();
        let response = RefreshResponse {
            access_token: SENTINEL_AT.to_string(),
            refresh_token: Some(SENTINEL_RT.to_string()),
            expires_in: 3600,
            granted_scopes: vec!["chat:write".to_string(), "search:read".to_string()],
        };
        persist(&paths, &state, &response).ok().unwrap();

        let saved = load(&paths).ok().flatten().unwrap();
        assert_eq!(saved.refresh_token.as_str(), SENTINEL_RT);
        assert_eq!(saved.provider_data["clientId"], "cid");
        assert_eq!(saved.provider_data["clientSecret"], SENTINEL_CS);
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
        assert!(raw.get("refreshToken").is_none());
        assert!(raw["providerData"].get("clientSecret").is_none());
        assert_eq!(
            read_access_token(dir.path(), "proj", "slack")
                .unwrap()
                .as_str(),
            SENTINEL_AT
        );
        for sentinel in [SENTINEL_RT, SENTINEL_CS, SENTINEL_AT] {
            assert!(files_containing(dir.path(), sentinel).is_empty());
        }
    }

    #[test]
    fn persist_keeps_the_old_refresh_token_when_the_provider_does_not_rotate() {
        let dir = tempfile::tempdir().unwrap();
        let paths = seeded(dir.path());
        let state = load(&paths).ok().flatten().unwrap();
        let response = RefreshResponse {
            access_token: "at".to_string(),
            refresh_token: None,
            expires_in: 60,
            granted_scopes: Vec::new(),
        };
        persist(&paths, &state, &response).ok().unwrap();
        assert_eq!(
            load(&paths).ok().flatten().unwrap().refresh_token.as_str(),
            "rt"
        );
    }

    #[test]
    fn a_failed_metadata_write_keeps_the_tokens_and_the_next_check_refreshes_again() {
        let dir = tempfile::tempdir().unwrap();
        let paths = seeded(dir.path());
        let state = load(&paths).ok().flatten().unwrap();
        std::fs::remove_file(&paths.state).unwrap();
        std::fs::create_dir(&paths.state).unwrap();
        let response = RefreshResponse {
            access_token: "new-at".to_string(),
            refresh_token: Some("new-rt".to_string()),
            expires_in: 3600,
            granted_scopes: Vec::new(),
        };

        assert_eq!(
            persist(&paths, &state, &response).err(),
            Some(ErrorCode::PersistFailed)
        );

        let secrets = Secrets::open(&paths).unwrap();
        assert_eq!(
            secrets
                .read(&secrets.refresh)
                .ok()
                .flatten()
                .unwrap()
                .as_str(),
            "new-rt"
        );
        assert_eq!(
            read_access_token(dir.path(), "proj", "slack")
                .unwrap()
                .as_str(),
            "new-at"
        );
    }
}
