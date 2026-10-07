//! Shared update-channel model for `update-settings.json`: the channel enum
//! and the pure GitHub release URL/tag helpers both the desktop updater and
//! the CLI self-updater build on.

use serde::{Deserialize, Serialize};

/// Which GitHub release stream an installation follows.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum UpdateChannel {
    /// Published stable releases only.
    #[default]
    Stable,
    /// Every published release, including betas.
    Beta,
}

impl std::fmt::Display for UpdateChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        })
    }
}

/// `serde(deserialize_with)` for an optional `channel` field: anything other
/// than the strings `"beta"`/`"stable"` deserializes as `None`.
pub fn deserialize_channel<'de, D>(deserializer: D) -> Result<Option<UpdateChannel>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value.as_str() {
        Some("beta") => Some(UpdateChannel::Beta),
        Some("stable") => Some(UpdateChannel::Stable),
        _ => None,
    })
}

/// File name of the shared update-settings file under [`crate::consts::data_dir`].
pub const SETTINGS_FILE_NAME: &str = "update-settings.json";

/// Path to the shared update-settings file read by both the desktop app and the CLI.
pub fn settings_path() -> std::path::PathBuf {
    crate::consts::data_dir().join(SETTINGS_FILE_NAME)
}

const REPO_OWNER: &str = "speednet-software";
const REPO_NAME: &str = "speedwave";

/// GitHub API URL for the release to check on `channel`: `/releases/latest`
/// for stable, the newest-first releases page for beta.
pub fn release_list_url(channel: UpdateChannel) -> String {
    match channel {
        UpdateChannel::Stable => {
            format!("https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/releases/latest")
        }
        UpdateChannel::Beta => {
            format!("https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/releases?per_page=1")
        }
    }
}

/// Extracts `tag_name` from a GitHub releases API response: a single release
/// object (`/releases/latest`) or a list (`/releases?per_page=1`, newest first).
pub fn parse_release_tag(body: &[u8]) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| format!("GitHub API response is not valid JSON: {e}"))?;
    let entry = value
        .as_array()
        .and_then(|list| list.first())
        .unwrap_or(&value);
    entry
        .get("tag_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "GitHub API response has no tag_name".to_string())
}

/// Builds the GitHub release-download manifest URL for a tag; a literal `+`
/// in the tag is a valid path segment and stays unescaped.
pub fn release_manifest_url(tag: &str) -> String {
    format!("https://github.com/{REPO_OWNER}/{REPO_NAME}/releases/download/{tag}/latest.json")
}

#[derive(Deserialize)]
struct ChannelOnly {
    #[serde(default, deserialize_with = "deserialize_channel")]
    channel: Option<UpdateChannel>,
}

fn read_update_channel_at(path: &std::path::Path) -> UpdateChannel {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return UpdateChannel::default();
    };
    serde_json::from_str::<ChannelOnly>(&contents)
        .ok()
        .and_then(|c| c.channel)
        .unwrap_or_default()
}

/// Reads the effective `channel` from the shared settings file; missing,
/// unparsable, or unrecognized content all read as `stable`.
pub fn read_update_channel() -> UpdateChannel {
    read_update_channel_at(&settings_path())
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test-only assertions")]
mod tests {
    use super::*;

    #[test]
    fn default_channel_is_stable() {
        assert_eq!(UpdateChannel::default(), UpdateChannel::Stable);
    }

    #[test]
    fn display_uses_lowercase_names() {
        assert_eq!(UpdateChannel::Stable.to_string(), "stable");
        assert_eq!(UpdateChannel::Beta.to_string(), "beta");
    }

    #[test]
    fn deserialize_channel_missing_field_is_none() {
        let parsed: ChannelOnly = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed.channel, None);
    }

    #[test]
    fn deserialize_channel_stable_value() {
        let parsed: ChannelOnly = serde_json::from_str(r#"{"channel":"stable"}"#).unwrap();
        assert_eq!(parsed.channel, Some(UpdateChannel::Stable));
    }

    #[test]
    fn deserialize_channel_beta_value() {
        let parsed: ChannelOnly = serde_json::from_str(r#"{"channel":"beta"}"#).unwrap();
        assert_eq!(parsed.channel, Some(UpdateChannel::Beta));
    }

    #[test]
    fn deserialize_channel_unknown_value_is_none() {
        let parsed: ChannelOnly = serde_json::from_str(r#"{"channel":"nightly"}"#).unwrap();
        assert_eq!(parsed.channel, None);
    }

    #[test]
    fn deserialize_channel_wrong_type_is_none() {
        let parsed: ChannelOnly = serde_json::from_str(r#"{"channel":42}"#).unwrap();
        assert_eq!(parsed.channel, None);
    }

    #[test]
    fn deserialize_channel_null_is_none() {
        let parsed: ChannelOnly = serde_json::from_str(r#"{"channel":null}"#).unwrap();
        assert_eq!(parsed.channel, None);
    }

    #[test]
    fn read_update_channel_missing_file_is_stable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SETTINGS_FILE_NAME);
        assert_eq!(read_update_channel_at(&path), UpdateChannel::Stable);
    }

    #[test]
    fn read_update_channel_unparsable_file_is_stable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SETTINGS_FILE_NAME);
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(read_update_channel_at(&path), UpdateChannel::Stable);
    }

    #[test]
    fn read_update_channel_reads_beta() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SETTINGS_FILE_NAME);
        std::fs::write(
            &path,
            r#"{"auto_check":true,"check_interval_hours":24,"channel":"beta"}"#,
        )
        .unwrap();
        assert_eq!(read_update_channel_at(&path), UpdateChannel::Beta);
    }

    #[test]
    fn read_update_channel_unknown_value_reads_stable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SETTINGS_FILE_NAME);
        std::fs::write(
            &path,
            r#"{"auto_check":false,"check_interval_hours":6,"channel":"nightly"}"#,
        )
        .unwrap();
        assert_eq!(read_update_channel_at(&path), UpdateChannel::Stable);
    }

    #[test]
    fn release_list_url_stable_uses_releases_latest() {
        assert_eq!(
            release_list_url(UpdateChannel::Stable),
            "https://api.github.com/repos/speednet-software/speedwave/releases/latest"
        );
    }

    #[test]
    fn release_list_url_beta_uses_releases_list() {
        assert_eq!(
            release_list_url(UpdateChannel::Beta),
            "https://api.github.com/repos/speednet-software/speedwave/releases?per_page=1"
        );
    }

    #[test]
    fn parse_release_tag_single_release_object() {
        let body = br#"{"tag_name":"v0.20.1","assets":[]}"#;
        assert_eq!(parse_release_tag(body).unwrap(), "v0.20.1");
    }

    #[test]
    fn parse_release_tag_list_takes_first_entry() {
        let body = br#"[{"tag_name":"v0.22.0+41"},{"tag_name":"v0.21.0+37"}]"#;
        assert_eq!(parse_release_tag(body).unwrap(), "v0.22.0+41");
    }

    #[test]
    fn parse_release_tag_preserves_literal_plus() {
        let tag = parse_release_tag(br#"{"tag_name":"v0.21.0+110"}"#).unwrap();
        assert_eq!(tag, "v0.21.0+110");
        assert!(!tag.contains("%2B"));
    }

    #[test]
    fn parse_release_tag_empty_list_errors() {
        assert!(parse_release_tag(b"[]").is_err());
    }

    #[test]
    fn parse_release_tag_missing_tag_name_errors() {
        assert!(parse_release_tag(br#"{"name":"x"}"#).is_err());
    }

    #[test]
    fn parse_release_tag_invalid_json_errors() {
        assert!(parse_release_tag(b"not json").is_err());
    }

    #[test]
    fn release_manifest_url_builds_releases_download_path() {
        assert_eq!(
            release_manifest_url("v0.22.0+41"),
            "https://github.com/speednet-software/speedwave/releases/download/v0.22.0+41/latest.json"
        );
    }

    #[test]
    fn release_manifest_url_preserves_literal_plus() {
        let url = release_manifest_url("v0.21.0+110");
        assert!(url.contains("v0.21.0+110"));
        assert!(!url.contains("%2B"));
    }
}
