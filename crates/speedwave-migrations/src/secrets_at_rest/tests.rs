use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use speedwave_runtime::secret_store::{SecretName, SecretStore};

use super::migrate;

const GITLAB_TOKEN: &str = "SENTINEL-gitlab-token-4411";
const SLACK_ACCESS: &str = "SENTINEL-slack-access-4412";
const SLACK_REFRESH: &str = "SENTINEL-slack-refresh-4413";
const PII_KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn write(path: &Path, content: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

fn tokens(data_dir: &Path, project: &str, service: &str, field: &str) -> PathBuf {
    data_dir
        .join("tokens")
        .join(project)
        .join(service)
        .join(field)
}

fn name(project: &str, service: &str, field: &str) -> SecretName {
    SecretName::integration(project, service, field).unwrap()
}

fn stored(data_dir: &Path, name: &SecretName) -> Option<String> {
    SecretStore::open(data_dir)
        .unwrap()
        .read(name)
        .unwrap()
        .map(|value| (*value).clone())
}

fn enc_exists(data_dir: &Path, name: &SecretName) -> bool {
    data_dir
        .join("secrets")
        .join(name.project())
        .join(name.file_name())
        .is_file()
}

fn files_under(dir: &Path, found: &mut Vec<PathBuf>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files_under(&path, found);
        } else {
            found.push(path);
        }
    }
}

fn tree_contains(data_dir: &Path, needle: &str) -> bool {
    let mut files = Vec::new();
    files_under(data_dir, &mut files);
    files.iter().any(|path| {
        std::fs::read(path)
            .unwrap()
            .windows(needle.len())
            .any(|window| window == needle.as_bytes())
    })
}

fn snapshot(data_dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = Vec::new();
    files_under(data_dir, &mut files);
    files
        .into_iter()
        .map(|path| {
            let bytes = std::fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect()
}

fn install_plugin(data_dir: &Path, manifest: &Value) {
    let slug = manifest["slug"].as_str().unwrap();
    write(
        &data_dir.join("plugins").join(slug).join("plugin.json"),
        &manifest.to_string(),
    );
}

fn acme_manifest() -> Value {
    json!({
        "name": "Acme",
        "service_id": "acme",
        "slug": "acme",
        "version": "1.0.0",
        "description": "test plugin",
        "auth_fields": [
            {"key": "base_url", "label": "URL", "field_type": "text", "placeholder": "", "is_secret": false},
            {"key": "api_secret", "label": "Secret", "field_type": "password", "placeholder": "", "is_secret": true},
            {"key": "client_id", "label": "Id", "field_type": "text", "placeholder": "", "is_secret": false, "oauth_flow": true},
            {"key": "client_secret", "label": "Client secret", "field_type": "password", "placeholder": "", "is_secret": true, "oauth_flow": true}
        ],
        "oauth": {"grant_type": "authorization_code", "client_id_field": "client_id", "client_secret_field": "client_secret"}
    })
}

#[test]
fn built_in_secret_fields_move_into_the_store_and_other_files_stay() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(&tokens(dir, "alpha", "slack", "access_token"), SLACK_ACCESS);
    write(
        &tokens(dir, "alpha", "slack", "refresh_token"),
        SLACK_REFRESH,
    );
    write(&tokens(dir, "alpha", "slack", "features.json"), "{}");
    write(&tokens(dir, "alpha", "gitlab", "token"), GITLAB_TOKEN);
    write(
        &tokens(dir, "alpha", "gitlab", "host_url"),
        "https://gitlab.example",
    );

    migrate(dir).unwrap();

    assert_eq!(
        stored(dir, &name("alpha", "slack", "access_token")).as_deref(),
        Some(SLACK_ACCESS)
    );
    assert_eq!(
        stored(
            dir,
            &SecretName::oauth_refresh_token("alpha", "slack").unwrap()
        )
        .as_deref(),
        Some(SLACK_REFRESH)
    );
    assert_eq!(
        stored(dir, &name("alpha", "gitlab", "token")).as_deref(),
        Some(GITLAB_TOKEN)
    );
    assert!(!tokens(dir, "alpha", "slack", "access_token").exists());
    assert!(!tokens(dir, "alpha", "slack", "refresh_token").exists());
    assert!(!tokens(dir, "alpha", "gitlab", "token").exists());
    assert!(tokens(dir, "alpha", "slack", "features.json").is_file());
    assert!(tokens(dir, "alpha", "gitlab", "host_url").is_file());
    assert!(dir.join("secret-store.key").is_file());
    for secret in [GITLAB_TOKEN, SLACK_ACCESS, SLACK_REFRESH] {
        assert!(!tree_contains(dir, secret));
    }
}

#[test]
fn plugin_secret_fields_and_the_oauth_access_token_move_by_manifest() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    install_plugin(dir, &acme_manifest());
    write(
        &tokens(dir, "alpha", "acme", "api_secret"),
        "SENTINEL-acme-secret",
    );
    write(
        &tokens(dir, "alpha", "acme", "access_token"),
        "SENTINEL-acme-access",
    );
    write(
        &tokens(dir, "alpha", "acme", "base_url"),
        "https://acme.example",
    );
    write(&tokens(dir, "alpha", "acme", "_settings.json"), "{}");

    migrate(dir).unwrap();

    assert_eq!(
        stored(dir, &name("alpha", "acme", "api_secret")).as_deref(),
        Some("SENTINEL-acme-secret")
    );
    assert_eq!(
        stored(dir, &name("alpha", "acme", "access_token")).as_deref(),
        Some("SENTINEL-acme-access")
    );
    assert!(tokens(dir, "alpha", "acme", "base_url").is_file());
    assert!(tokens(dir, "alpha", "acme", "_settings.json").is_file());
    assert!(!tree_contains(dir, "SENTINEL-acme"));
}

#[test]
fn a_plugin_directory_without_a_manifest_is_left_alone_without_an_error() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(
        &tokens(dir, "alpha", "ghost", "api_secret"),
        "SENTINEL-ghost",
    );

    migrate(dir).unwrap();

    assert!(tokens(dir, "alpha", "ghost", "api_secret").is_file());
    assert!(!dir.join("secret-store.key").exists());
}

#[test]
fn llm_keys_the_local_llm_files_and_the_anthropic_key_move() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(
        &tokens(dir, "alpha", "llm", "openrouter_api_key"),
        "SENTINEL-openrouter",
    );
    write(&tokens(dir, "alpha", "llm", "local"), "not-a-key");
    write(
        &tokens(dir, "alpha", "local-llm", "api_key"),
        "SENTINEL-local-key",
    );
    write(
        &tokens(dir, "alpha", "local-llm", "custom_headers"),
        "X-Org: SENTINEL-header",
    );
    write(
        &dir.join("secrets/alpha/anthropic_api_key"),
        "SENTINEL-anthropic",
    );

    migrate(dir).unwrap();

    let read = |secret: SecretName| stored(dir, &secret);
    assert_eq!(
        read(SecretName::llm_provider_key("alpha", "openrouter").unwrap()).as_deref(),
        Some("SENTINEL-openrouter")
    );
    assert_eq!(
        read(SecretName::local_llm_api_key("alpha").unwrap()).as_deref(),
        Some("SENTINEL-local-key")
    );
    assert_eq!(
        read(SecretName::local_llm_custom_headers("alpha").unwrap()).as_deref(),
        Some("X-Org: SENTINEL-header")
    );
    assert_eq!(
        read(SecretName::anthropic_api_key("alpha").unwrap()).as_deref(),
        Some("SENTINEL-anthropic")
    );
    assert!(tokens(dir, "alpha", "llm", "local").is_file());
    assert!(!dir.join("secrets/alpha/anthropic_api_key").exists());
    assert!(!tree_contains(dir, "SENTINEL"));
}

#[test]
fn the_pii_key_moves_trimmed() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(&dir.join("policies/alpha/key"), &format!("{PII_KEY}\n"));
    write(&dir.join("policies/alpha/policy.json"), "{}");

    migrate(dir).unwrap();

    assert_eq!(
        stored(dir, &SecretName::pii_key("alpha").unwrap()).as_deref(),
        Some(PII_KEY)
    );
    assert!(!dir.join("policies/alpha/key").exists());
    assert!(dir.join("policies/alpha/policy.json").is_file());
    assert!(!tree_contains(dir, PII_KEY));
}

#[test]
fn a_malformed_pii_key_fails_the_run_and_stays_in_place() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(&dir.join("policies/alpha/key"), "SENTINEL-not-hex");
    write(&tokens(dir, "alpha", "gitlab", "token"), GITLAB_TOKEN);

    let error = migrate(dir).unwrap_err();

    assert!(error.contains("project alpha: the PII key could not be migrated"));
    assert!(!error.contains("SENTINEL"));
    assert_eq!(
        std::fs::read_to_string(dir.join("policies/alpha/key")).unwrap(),
        "SENTINEL-not-hex"
    );
    assert!(!enc_exists(dir, &SecretName::pii_key("alpha").unwrap()));
    assert_eq!(
        stored(dir, &name("alpha", "gitlab", "token")).as_deref(),
        Some(GITLAB_TOKEN)
    );
}

#[test]
fn oauth_state_loses_its_secrets_and_keeps_every_other_key() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let state = json!({
        "provider": "generic",
        "grantType": "authorization_code",
        "providerData": {"clientId": "cid", "clientSecret": "SENTINEL-client-secret", "tenant": "t"},
        "scopes": ["a", "b"],
        "grantedScopes": ["a"],
        "refreshToken": "SENTINEL-refresh",
        "expiresAt": "2026-11-18T10:00:00.000Z",
        "lastRefreshAt": "2026-11-17T22:00:00.000Z"
    });
    let path = dir.join("oauth/alpha/acme.json");
    write(&path, &state.to_string());

    migrate(dir).unwrap();

    let rewritten: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let mut expected = state.clone();
    expected.as_object_mut().unwrap().remove("refreshToken");
    expected["providerData"]
        .as_object_mut()
        .unwrap()
        .remove("clientSecret");
    assert_eq!(rewritten, expected);
    assert_eq!(
        stored(
            dir,
            &SecretName::oauth_refresh_token("alpha", "acme").unwrap()
        )
        .as_deref(),
        Some("SENTINEL-refresh")
    );
    assert_eq!(
        stored(
            dir,
            &SecretName::oauth_client_secret("alpha", "acme").unwrap()
        )
        .as_deref(),
        Some("SENTINEL-client-secret")
    );
    assert!(!tree_contains(dir, "SENTINEL"));
}

#[test]
fn an_empty_oauth_refresh_token_is_dropped_without_creating_the_key() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let path = dir.join("oauth/alpha/acme.json");
    write(
        &path,
        &json!({"provider": "generic", "refreshToken": "", "providerData": {}}).to_string(),
    );

    migrate(dir).unwrap();

    let rewritten: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        rewritten,
        json!({"provider": "generic", "providerData": {}})
    );
    assert!(!dir.join("secret-store.key").exists());
    assert!(!dir.join("secrets").exists());
}

#[test]
fn oauth_files_that_are_not_state_are_skipped_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(&dir.join("oauth/alpha/broken.json"), "{not json");
    write(
        &dir.join("oauth/alpha/lock.json"),
        r#"{"pid":1,"refreshToken":"SENTINEL-not-state"}"#,
    );
    let before = snapshot(dir);

    migrate(dir).unwrap();

    assert_eq!(snapshot(dir), before);
}

#[test]
fn the_seed_loses_its_secret_values_and_keeps_the_rest() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    install_plugin(dir, &acme_manifest());
    let path = dir.join("oauth/alpha/acme.seed.json");
    write(
        &path,
        &json!({
            "client_id": "cid",
            "client_secret": "SENTINEL-seed-secret",
            "base_url": "https://acme.example"
        })
        .to_string(),
    );

    migrate(dir).unwrap();

    let seed: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        seed,
        json!({"client_id": "cid", "base_url": "https://acme.example"})
    );
    assert_eq!(
        stored(dir, &name("alpha", "acme", "client_secret")).as_deref(),
        Some("SENTINEL-seed-secret")
    );
    assert!(!tree_contains(dir, "SENTINEL"));
}

#[test]
fn a_seed_without_a_manifest_is_skipped() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(
        &dir.join("oauth/alpha/ghost.seed.json"),
        r#"{"client_secret":"SENTINEL-ghost"}"#,
    );

    migrate(dir).unwrap();

    assert!(tree_contains(dir, "SENTINEL-ghost"));
    assert!(!dir.join("secret-store.key").exists());
}

#[test]
fn an_existing_encrypted_secret_wins_over_the_plaintext() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let store = SecretStore::open(dir).unwrap();
    store
        .write(&name("alpha", "gitlab", "token"), "SENTINEL-new")
        .unwrap();
    write(&tokens(dir, "alpha", "gitlab", "token"), "SENTINEL-old");

    migrate(dir).unwrap();

    assert_eq!(
        stored(dir, &name("alpha", "gitlab", "token")).as_deref(),
        Some("SENTINEL-new")
    );
    assert!(!tokens(dir, "alpha", "gitlab", "token").exists());
    assert!(!tree_contains(dir, "SENTINEL-old"));
}

#[test]
fn empty_plaintext_files_are_deleted_and_no_key_appears() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(&tokens(dir, "alpha", "gitlab", "token"), "");
    write(&tokens(dir, "alpha", "slack", "access_token"), " \n");
    write(&dir.join("secrets/alpha/anthropic_api_key"), "");

    migrate(dir).unwrap();

    assert!(!tokens(dir, "alpha", "gitlab", "token").exists());
    assert!(!tokens(dir, "alpha", "slack", "access_token").exists());
    assert!(!dir.join("secrets/alpha/anthropic_api_key").exists());
    assert!(!dir.join("secret-store.key").exists());
    assert!(!dir.join("secrets/alpha").join("gitlab.token.enc").exists());
}

#[test]
fn nothing_to_migrate_leaves_the_data_dir_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(
        &tokens(dir, "alpha", "gitlab", "host_url"),
        "https://gitlab.example",
    );
    write(&dir.join("config.json"), "{}");
    let before = snapshot(dir);

    migrate(dir).unwrap();

    assert_eq!(snapshot(dir), before);
    assert!(!dir.join("secret-store.key").exists());
    assert!(!dir.join("secrets").exists());
}

#[test]
fn a_second_run_changes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(&tokens(dir, "alpha", "gitlab", "token"), GITLAB_TOKEN);
    write(&dir.join("policies/alpha/key"), PII_KEY);
    write(
        &dir.join("oauth/alpha/slack.json"),
        &json!({"provider": "slack", "refreshToken": "SENTINEL-refresh"}).to_string(),
    );
    migrate(dir).unwrap();
    let after_first = snapshot(dir);

    migrate(dir).unwrap();

    assert_eq!(snapshot(dir), after_first);
}

#[test]
fn a_secret_that_cannot_be_written_keeps_its_plaintext_and_the_rest_migrates() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    SecretStore::open(dir).unwrap().ensure_key().unwrap();
    std::fs::create_dir_all(dir.join("secrets/alpha/gitlab.token.enc")).unwrap();
    write(&tokens(dir, "alpha", "gitlab", "token"), GITLAB_TOKEN);
    write(&tokens(dir, "alpha", "slack", "access_token"), SLACK_ACCESS);

    let error = migrate(dir).unwrap_err();

    assert!(error.contains(
        "Integration gitlab (project alpha): could not encrypt the secret. Speedwave will try again on the next start."
    ));
    assert!(!error.contains("slack"));
    assert!(!error.contains(GITLAB_TOKEN));
    assert!(!error.contains(SLACK_ACCESS));
    assert_eq!(
        std::fs::read_to_string(tokens(dir, "alpha", "gitlab", "token")).unwrap(),
        GITLAB_TOKEN
    );
    assert_eq!(
        stored(dir, &name("alpha", "slack", "access_token")).as_deref(),
        Some(SLACK_ACCESS)
    );
    assert!(!tokens(dir, "alpha", "slack", "access_token").exists());
}

#[test]
fn a_missing_install_key_beside_ciphertexts_fails_every_secret_and_creates_no_key() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(&dir.join("secrets/alpha/slack.access_token.enc"), "x");
    write(&tokens(dir, "alpha", "gitlab", "token"), GITLAB_TOKEN);

    let error = migrate(dir).unwrap_err();

    assert!(error.contains("Integration gitlab (project alpha)"));
    assert!(tokens(dir, "alpha", "gitlab", "token").is_file());
    assert!(!dir.join("secret-store.key").exists());
}

#[test]
fn generated_files_with_plaintext_secrets_are_removed_and_clean_ones_stay() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(
        &dir.join("compose/alpha/compose.yml"),
        "environment:\n  ANTHROPIC_API_KEY: SENTINEL-compose\n",
    );
    write(
        &dir.join("snapshots/alpha/snapshot.json"),
        &json!({"compose_yml": "ANTHROPIC_AUTH_TOKEN=SENTINEL-snapshot"}).to_string(),
    );
    write(&dir.join("compose/beta/compose.yml"), "services: {}\n");
    write(
        &dir.join("snapshots/beta/snapshot.json"),
        r#"{"compose_yml":"services: {}"}"#,
    );

    migrate(dir).unwrap();

    assert!(!dir.join("compose/alpha/compose.yml").exists());
    assert!(!dir.join("snapshots/alpha/snapshot.json").exists());
    assert!(dir.join("compose/beta/compose.yml").is_file());
    assert!(dir.join("snapshots/beta/snapshot.json").is_file());
    assert!(!dir.join("secret-store.key").exists());
}

#[cfg(unix)]
#[test]
fn a_symlinked_project_directory_is_never_followed() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("data");
    let outside = tmp.path().join("outside");
    write(&outside.join("gitlab/token"), "SENTINEL-outside");
    write(
        &outside.join("compose.yml"),
        "ANTHROPIC_API_KEY: SENTINEL-outside",
    );
    std::fs::create_dir_all(dir.join("tokens")).unwrap();
    std::fs::create_dir_all(dir.join("compose")).unwrap();
    std::os::unix::fs::symlink(&outside, dir.join("tokens/alpha")).unwrap();
    std::os::unix::fs::symlink(&outside, dir.join("compose/alpha")).unwrap();

    migrate(&dir).unwrap();

    assert!(outside.join("gitlab/token").is_file());
    assert!(outside.join("compose.yml").is_file());
    assert!(!dir.join("secret-store.key").exists());
}

#[test]
fn directories_that_are_not_valid_project_names_are_skipped() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(&tokens(dir, "Bad Name", "gitlab", "token"), GITLAB_TOKEN);

    migrate(dir).unwrap();

    assert!(tokens(dir, "Bad Name", "gitlab", "token").is_file());
}

#[test]
fn run_all_runs_this_migration_before_legacy_files() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(&tokens(dir, "alpha", "gitlab", "token"), GITLAB_TOKEN);
    write(
        &dir.join("secrets/alpha/worker-auth-token"),
        "SENTINEL-bearer",
    );
    write(&dir.join("proxy/alpha/caller-token"), "SENTINEL-caller");
    write(&dir.join("oauth/alpha/slack.lock"), "");

    let report = crate::run_all(dir).unwrap();

    assert_eq!(report.executed, vec!["secrets_at_rest", "legacy_files"]);
    assert!(report.failed.is_empty());
    assert_eq!(
        stored(dir, &name("alpha", "gitlab", "token")).as_deref(),
        Some(GITLAB_TOKEN)
    );
    assert!(!dir.join("secrets/alpha/worker-auth-token").exists());
    assert!(!dir.join("proxy/alpha/caller-token").exists());
    assert!(!dir.join("oauth/alpha/slack.lock").exists());
    assert!(enc_exists(dir, &name("alpha", "gitlab", "token")));
    assert!(!tree_contains(dir, "SENTINEL"));
}

#[test]
fn run_all_reports_a_failed_migration_by_name_and_still_runs_legacy_files() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(&dir.join("policies/alpha/key"), "not-hex");
    write(&dir.join("mcp-os-port"), "1");

    let report = crate::run_all(dir).unwrap();

    assert_eq!(report.failed, vec!["secrets_at_rest"]);
    assert_eq!(report.executed, vec!["legacy_files"]);
    assert!(!dir.join("mcp-os-port").exists());
    assert!(dir.join("policies/alpha/key").is_file());
}

#[test]
fn the_superseded_sharepoint_refresh_token_file_is_not_carried_into_the_store() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(
        &tokens(dir, "alpha", "sharepoint", "refresh_token"),
        "SENTINEL-v1",
    );
    write(
        &tokens(dir, "alpha", "sharepoint", "access_token"),
        "SENTINEL-v2",
    );

    migrate(dir).unwrap();

    assert!(tokens(dir, "alpha", "sharepoint", "refresh_token").is_file());
    assert!(!enc_exists(
        dir,
        &name("alpha", "sharepoint", "refresh_token")
    ));
    assert!(enc_exists(
        dir,
        &name("alpha", "sharepoint", "access_token")
    ));
}
