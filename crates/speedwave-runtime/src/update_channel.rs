//! Shared update-channel model for `update-settings.json`: the channel enum,
//! the pure GitHub release URL/tag helpers, and (behind `update-check`) the
//! one hardened HTTP fetch both the desktop updater and the CLI build on.

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

#[cfg(feature = "update-check")]
const MAX_RELEASE_RESPONSE_BYTES: u64 = crate::consts::HTTP_MAX_RESPONSE_BODY_BYTES as u64;

/// Builds a blocking client hardened per ADR-041: no redirects, bounded
/// timeout, Speedwave UA.
#[cfg(feature = "update-check")]
fn build_release_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(crate::consts::HTTP_REQUEST_TIMEOUT)
        .user_agent(format!("Speedwave/{}", env!("SPEEDWAVE_VERSION")))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

/// Reads `resp`'s body, aborting past [`MAX_RELEASE_RESPONSE_BYTES`].
#[cfg(feature = "update-check")]
fn read_release_body_limited(resp: reqwest::blocking::Response) -> Result<Vec<u8>, String> {
    use std::io::Read;

    if let Some(len) = resp.content_length() {
        if len > MAX_RELEASE_RESPONSE_BYTES {
            return Err(format!(
                "GitHub releases list response too large ({len} bytes, limit {MAX_RELEASE_RESPONSE_BYTES})"
            ));
        }
    }

    let mut limited = resp.take(MAX_RELEASE_RESPONSE_BYTES + 1);
    let mut buf = Vec::new();
    limited
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read GitHub releases list response: {e}"))?;
    if buf.len() as u64 > MAX_RELEASE_RESPONSE_BYTES {
        return Err(format!(
            "GitHub releases list response too large (exceeded {MAX_RELEASE_RESPONSE_BYTES} byte limit)"
        ));
    }
    Ok(buf)
}

/// Fetches and parses the release tag at `list_url`: no redirects followed,
/// a non-success status or an oversized body errors before parsing.
#[cfg(feature = "update-check")]
fn fetch_release_tag_from(list_url: &str) -> Result<String, String> {
    let client = build_release_client()?;
    let resp = client
        .get(list_url)
        .send()
        .map_err(|e| format!("Failed to list GitHub releases: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("GitHub releases list returned HTTP {status}"));
    }
    let body = read_release_body_limited(resp)?;
    parse_release_tag(&body)
}

/// Fetches the GitHub release tag for `channel`: the single HTTP implementation
/// the desktop updater and the CLI self-updater both call (ADR-041 hardening).
#[cfg(feature = "update-check")]
pub fn fetch_release_tag(channel: UpdateChannel) -> Result<String, String> {
    fetch_release_tag_from(&release_list_url(channel))
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

#[cfg(all(test, feature = "update-check"))]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test-only assertions"
)]
mod fetch_tests {
    use super::*;

    #[test]
    fn fetch_release_tag_from_parses_first_entry_from_mocked_api() {
        let mut server = mockito::Server::new();
        let mock = server
            .mock("GET", "/releases")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"[{"tag_name":"v0.22.0+41"}]"#)
            .create();

        let url = format!("{}/releases", server.url());
        let tag = fetch_release_tag_from(&url).expect("fetch tag");

        assert_eq!(tag, "v0.22.0+41");
        mock.assert();
    }

    #[test]
    fn fetch_release_tag_from_empty_list_errors() {
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("GET", "/releases")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body("[]")
            .create();

        let url = format!("{}/releases", server.url());
        let err = fetch_release_tag_from(&url).unwrap_err();

        assert!(err.contains("tag_name"), "{err}");
    }

    #[test]
    fn fetch_release_tag_from_http_error_status_errors() {
        let mut server = mockito::Server::new();
        let _mock = server.mock("GET", "/releases").with_status(500).create();

        let url = format!("{}/releases", server.url());
        let err = fetch_release_tag_from(&url).unwrap_err();

        assert!(err.contains("500"), "{err}");
    }

    #[test]
    fn fetch_release_tag_from_does_not_follow_redirects() {
        let mut server = mockito::Server::new();
        let target = server
            .mock("GET", "/moved-target")
            .with_status(200)
            .with_body(r#"{"tag_name":"v9.9.9"}"#)
            .expect(0)
            .create();
        let _redirect = server
            .mock("GET", "/releases")
            .with_status(301)
            .with_header("Location", "/moved-target")
            .create();

        let url = format!("{}/releases", server.url());
        let err = fetch_release_tag_from(&url).unwrap_err();

        assert!(err.contains("301"), "{err}");
        target.assert();
    }

    #[test]
    fn fetch_release_tag_from_oversized_body_errors() {
        let mut server = mockito::Server::new();
        let oversized = vec![b' '; (MAX_RELEASE_RESPONSE_BYTES + 1) as usize];
        let _mock = server
            .mock("GET", "/releases")
            .with_status(200)
            .with_body(oversized)
            .create();

        let url = format!("{}/releases", server.url());
        let err = fetch_release_tag_from(&url).unwrap_err();

        assert!(err.contains("too large"), "{err}");
    }
}
