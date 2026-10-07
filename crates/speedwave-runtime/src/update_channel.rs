//! Shared update-channel model for `update-settings.json`. The desktop app
//! and the CLI self-updater read the same file and must apply the same
//! stable-by-default tolerance to the `channel` field.

use serde::{Deserialize, Serialize};

/// Which GitHub release stream an installation follows.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpdateChannel {
    Stable,
    Beta,
}

impl Default for UpdateChannel {
    fn default() -> Self {
        Self::Stable
    }
}

impl std::fmt::Display for UpdateChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        })
    }
}

/// `serde(deserialize_with)` for a `channel` field: anything other than the
/// exact string `"beta"` (missing — handled by `#[serde(default)]` on the
/// field — wrong type, or an unrecognized string) deserializes as `stable`
/// without ever failing the surrounding document.
pub fn deserialize_channel<'de, D>(deserializer: D) -> Result<UpdateChannel, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value.as_str() {
        Some("beta") => UpdateChannel::Beta,
        _ => UpdateChannel::Stable,
    })
}

/// File name of the shared update-settings file under [`crate::consts::data_dir`].
pub const SETTINGS_FILE_NAME: &str = "update-settings.json";

/// Path to the shared update-settings file read by both the desktop app and the CLI.
pub fn settings_path() -> std::path::PathBuf {
    crate::consts::data_dir().join(SETTINGS_FILE_NAME)
}

#[derive(Deserialize)]
struct ChannelOnly {
    #[serde(default, deserialize_with = "deserialize_channel")]
    channel: UpdateChannel,
}

fn read_update_channel_at(path: &std::path::Path) -> UpdateChannel {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return UpdateChannel::default();
    };
    serde_json::from_str::<ChannelOnly>(&contents)
        .map(|c| c.channel)
        .unwrap_or_default()
}

/// Reads just the `channel` field from the shared settings file. A missing
/// file, unparsable JSON, a missing field and an unrecognized value all read
/// as `stable`.
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
    fn deserialize_channel_missing_field_is_stable() {
        let parsed: ChannelOnly = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed.channel, UpdateChannel::Stable);
    }

    #[test]
    fn deserialize_channel_stable_value() {
        let parsed: ChannelOnly = serde_json::from_str(r#"{"channel":"stable"}"#).unwrap();
        assert_eq!(parsed.channel, UpdateChannel::Stable);
    }

    #[test]
    fn deserialize_channel_beta_value() {
        let parsed: ChannelOnly = serde_json::from_str(r#"{"channel":"beta"}"#).unwrap();
        assert_eq!(parsed.channel, UpdateChannel::Beta);
    }

    #[test]
    fn deserialize_channel_unknown_value_is_stable() {
        let parsed: ChannelOnly = serde_json::from_str(r#"{"channel":"nightly"}"#).unwrap();
        assert_eq!(parsed.channel, UpdateChannel::Stable);
    }

    #[test]
    fn deserialize_channel_wrong_type_is_stable() {
        let parsed: ChannelOnly = serde_json::from_str(r#"{"channel":42}"#).unwrap();
        assert_eq!(parsed.channel, UpdateChannel::Stable);
    }

    #[test]
    fn deserialize_channel_null_is_stable() {
        let parsed: ChannelOnly = serde_json::from_str(r#"{"channel":null}"#).unwrap();
        assert_eq!(parsed.channel, UpdateChannel::Stable);
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
    fn read_update_channel_unknown_value_does_not_invalidate_other_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SETTINGS_FILE_NAME);
        std::fs::write(
            &path,
            r#"{"auto_check":false,"check_interval_hours":6,"channel":"nightly"}"#,
        )
        .unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        #[derive(Deserialize)]
        struct Full {
            auto_check: bool,
            check_interval_hours: u32,
            #[serde(default, deserialize_with = "deserialize_channel")]
            channel: UpdateChannel,
        }
        let full: Full = serde_json::from_str(&contents).unwrap();
        assert!(!full.auto_check);
        assert_eq!(full.check_interval_hours, 6);
        assert_eq!(full.channel, UpdateChannel::Stable);
    }
}
