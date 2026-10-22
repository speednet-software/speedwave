use crate::oauth_flow;
use crate::types::check_project;
use serde::Serialize;
use speedwave_runtime::consts::{self, SlackFeature};
use std::path::Path;

/// One row of the Slack card's feature list; mirrored by `SlackFeatureStatus` in `models/integration.ts`.
#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct SlackFeatureStatus {
    pub id: String,
    pub label: String,
    pub enabled: bool,
}

/// Features of the signed-in Slack grant; empty while Slack is not signed in.
#[tauri::command]
pub fn get_slack_features(project: String) -> Result<Vec<SlackFeatureStatus>, String> {
    check_project(&project)?;
    Ok(feature_statuses_in(consts::data_dir(), &project))
}

/// User scopes to request: base scopes, the features the current grant already has, and the feature being enabled.
pub(crate) fn requested_scopes(granted: &[String], enabling: Option<&SlackFeature>) -> Vec<String> {
    let mut scopes: Vec<String> = consts::SLACK_OAUTH_BASE_SCOPES
        .iter()
        .map(|s| s.to_string())
        .collect();
    for feature in consts::SLACK_FEATURES {
        let wanted = is_enabled(feature, granted) || enabling.is_some_and(|f| f.id == feature.id);
        if wanted {
            scopes.extend(feature.scopes.iter().map(|s| s.to_string()));
        }
    }
    scopes
}

/// Scopes of the stored Slack grant, lowercased; `None` without a readable state file.
pub(crate) fn granted_scopes_in(data_dir: &Path, project: &str) -> Option<Vec<String>> {
    let path = speedwave_runtime::plugin::oauth_state_file_in(data_dir, project, "slack");
    let raw = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let granted = json.get("grantedScopes")?.as_array()?;
    Some(
        granted
            .iter()
            .filter_map(|s| s.as_str().map(str::to_lowercase))
            .collect(),
    )
}

/// Features whose scopes are all in `scopes`.
pub(crate) fn features_in(scopes: &[String]) -> Vec<&'static SlackFeature> {
    consts::SLACK_FEATURES
        .iter()
        .filter(|feature| is_enabled(feature, scopes))
        .collect()
}

/// Message for a sign-in that requested `features` and that Slack refused or that never completed;
/// the existing grant is untouched.
pub(crate) fn refusal_message(features: &[&SlackFeature]) -> String {
    let names: Vec<String> = features.iter().map(|f| f.label.to_lowercase()).collect();
    format!(
        "Slack did not allow enabling {}. The rest of the Slack integration keeps working.",
        names.join(", ")
    )
}

/// Writes `features.json` next to `access_token`, derived from the scopes Slack granted.
pub(crate) fn write_features_file_in(svc_dir: &Path, granted: &[String]) -> Result<(), String> {
    let lowercased: Vec<String> = granted.iter().map(|s| s.to_lowercase()).collect();
    let body = serde_json::json!({ "enabled": enabled_feature_ids(&lowercased) }).to_string();
    oauth_flow::save_credential_file(svc_dir, consts::SLACK_FEATURES_FILE, &body)
}

fn feature_statuses_in(data_dir: &Path, project: &str) -> Vec<SlackFeatureStatus> {
    let Some(granted) = granted_scopes_in(data_dir, project) else {
        return Vec::new();
    };
    consts::SLACK_FEATURES
        .iter()
        .map(|feature| SlackFeatureStatus {
            id: feature.id.to_string(),
            label: feature.label.to_string(),
            enabled: is_enabled(feature, &granted),
        })
        .collect()
}

fn enabled_feature_ids(granted: &[String]) -> Vec<&'static str> {
    features_in(granted)
        .into_iter()
        .map(|feature| feature.id)
        .collect()
}

fn is_enabled(feature: &SlackFeature, granted: &[String]) -> bool {
    feature
        .scopes
        .iter()
        .all(|scope| granted.iter().any(|g| g == scope))
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions use unwrap")]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn scopes(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn file_upload() -> &'static SlackFeature {
        consts::find_slack_feature("file_upload").unwrap()
    }

    fn write_state(data_dir: &Path, project: &str, body: &str) {
        let path = speedwave_runtime::plugin::oauth_state_file_in(data_dir, project, "slack");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn plain_sign_in_requests_base_scopes_only() {
        let requested = requested_scopes(&[], None);
        assert_eq!(requested, scopes(consts::SLACK_OAUTH_BASE_SCOPES));
        assert!(!requested.contains(&"files:write".to_string()));
    }

    #[test]
    fn enabling_a_feature_adds_its_scopes_to_the_base() {
        let requested = requested_scopes(
            &scopes(consts::SLACK_OAUTH_BASE_SCOPES),
            Some(file_upload()),
        );
        assert_eq!(requested.len(), consts::SLACK_OAUTH_BASE_SCOPES.len() + 1);
        assert!(requested.contains(&"files:write".to_string()));
    }

    #[test]
    fn reconnect_keeps_a_feature_the_grant_already_has() {
        let mut granted = scopes(consts::SLACK_OAUTH_BASE_SCOPES);
        granted.push("files:write".to_string());
        let requested = requested_scopes(&granted, None);
        assert!(requested.contains(&"files:write".to_string()));
        assert_eq!(requested.len(), consts::SLACK_OAUTH_BASE_SCOPES.len() + 1);
    }

    #[test]
    fn enabling_an_already_enabled_feature_does_not_duplicate_scopes() {
        let granted = scopes(&["files:write"]);
        let requested = requested_scopes(&granted, Some(file_upload()));
        assert_eq!(requested.iter().filter(|s| *s == "files:write").count(), 1);
    }

    #[test]
    fn refusal_message_names_the_feature_and_keeps_the_integration() {
        let msg = refusal_message(&[file_upload()]);
        assert_eq!(
            msg,
            "Slack did not allow enabling file sending. The rest of the Slack integration keeps working."
        );
    }

    #[test]
    fn features_in_lists_features_whose_scopes_are_all_present() {
        assert!(features_in(&scopes(&["chat:write"])).is_empty());
        let found = features_in(&scopes(&["chat:write", "files:write"]));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "file_upload");
    }

    #[test]
    fn granted_scopes_are_read_lowercased_from_the_state_file() {
        let tmp = tempfile::tempdir().unwrap();
        write_state(
            tmp.path(),
            "proj",
            r#"{"grantedScopes":["Chat:Write","files:write"]}"#,
        );
        assert_eq!(
            granted_scopes_in(tmp.path(), "proj"),
            Some(scopes(&["chat:write", "files:write"]))
        );
    }

    #[test]
    fn granted_scopes_are_none_without_a_usable_state_file() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(granted_scopes_in(tmp.path(), "proj"), None);
        write_state(tmp.path(), "proj", "{not json");
        assert_eq!(granted_scopes_in(tmp.path(), "proj"), None);
        write_state(tmp.path(), "proj", r#"{"provider":"slack"}"#);
        assert_eq!(granted_scopes_in(tmp.path(), "proj"), None);
    }

    #[test]
    fn statuses_are_empty_when_slack_is_not_signed_in() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(feature_statuses_in(tmp.path(), "proj").is_empty());
    }

    #[test]
    fn statuses_reflect_the_granted_scopes() {
        let tmp = tempfile::tempdir().unwrap();
        write_state(tmp.path(), "proj", r#"{"grantedScopes":["chat:write"]}"#);
        assert_eq!(
            feature_statuses_in(tmp.path(), "proj"),
            vec![SlackFeatureStatus {
                id: "file_upload".to_string(),
                label: "File sending".to_string(),
                enabled: false,
            }]
        );
        write_state(
            tmp.path(),
            "proj",
            r#"{"grantedScopes":["chat:write","files:write"]}"#,
        );
        assert!(feature_statuses_in(tmp.path(), "proj")[0].enabled);
    }

    #[test]
    fn features_file_lists_enabled_features_only() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("slack");
        write_features_file_in(&dir, &scopes(&["chat:write"])).unwrap();
        let none = std::fs::read_to_string(dir.join(consts::SLACK_FEATURES_FILE)).unwrap();
        assert_eq!(none, r#"{"enabled":[]}"#);

        write_features_file_in(&dir, &scopes(&["chat:write", "files:write"])).unwrap();
        let some = std::fs::read_to_string(dir.join(consts::SLACK_FEATURES_FILE)).unwrap();
        assert_eq!(some, r#"{"enabled":["file_upload"]}"#);
    }

    #[test]
    fn features_file_derivation_lowercases_granted_scopes() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("slack");
        write_features_file_in(&dir, &scopes(&["Chat:Write", "Files:Write"])).unwrap();
        let body = std::fs::read_to_string(dir.join(consts::SLACK_FEATURES_FILE)).unwrap();
        assert_eq!(body, r#"{"enabled":["file_upload"]}"#);
    }

    #[test]
    fn slack_feature_status_fields_match_ts_mirror() {
        let ts = include_str!("../../src/src/app/models/integration.ts");
        let body = ts
            .split("export interface SlackFeatureStatus {")
            .nth(1)
            .and_then(|rest| rest.split('}').next())
            .unwrap();
        let ts_fields: BTreeSet<&str> = body
            .lines()
            .filter_map(|line| line.trim().split(':').next())
            .map(|name| name.trim_end_matches('?'))
            .filter(|name| !name.is_empty() && !name.starts_with("/**") && !name.starts_with('*'))
            .collect();
        let status = SlackFeatureStatus {
            id: "x".to_string(),
            label: "X".to_string(),
            enabled: false,
        };
        let json = serde_json::to_value(&status).unwrap();
        let rust_fields: BTreeSet<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(ts_fields, rust_fields);
    }
}
