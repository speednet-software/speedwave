use std::path::Path;

use chrono::{SecondsFormat, Utc};

use super::RefreshOutcome;
use crate::consts;

pub(super) fn record(token_dir: &Path, outcome: RefreshOutcome) {
    let path = token_dir.join(consts::OAUTH_REFRESH_STATUS_FILE);
    let state = match outcome {
        RefreshOutcome::ReconnectRequired => "reconnect_required",
        RefreshOutcome::NetworkError => "network_error",
        RefreshOutcome::Refreshed | RefreshOutcome::NotDue => return remove(&path),
    };
    let body = serde_json::json!({
        "state": state,
        "at": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
    .to_string();
    let written = std::fs::create_dir_all(token_dir)
        .map_err(anyhow::Error::from)
        .and_then(|()| crate::fs_perms::write_restricted_file(&path, &body));
    if written.is_err() {
        log::warn!("failed to write the refresh status file");
    }
}

fn remove(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => log::warn!("failed to remove the refresh status file"),
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use super::*;

    fn read(dir: &Path) -> Option<serde_json::Value> {
        let text = std::fs::read_to_string(dir.join(consts::OAUTH_REFRESH_STATUS_FILE)).ok()?;
        serde_json::from_str(&text).ok()
    }

    #[test]
    fn failures_write_their_state_and_a_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let token_dir = dir.path().join("tokens").join("slack");
        record(&token_dir, RefreshOutcome::ReconnectRequired);
        let status = read(&token_dir).unwrap();
        assert_eq!(status["state"], "reconnect_required");
        let at = status["at"].as_str().unwrap();
        assert!(chrono::DateTime::parse_from_rfc3339(at).is_ok(), "{at}");

        record(&token_dir, RefreshOutcome::NetworkError);
        assert_eq!(read(&token_dir).unwrap()["state"], "network_error");
    }

    #[test]
    fn success_or_a_fresh_token_removes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        record(dir.path(), RefreshOutcome::NetworkError);
        assert!(read(dir.path()).is_some());
        record(dir.path(), RefreshOutcome::Refreshed);
        assert!(read(dir.path()).is_none());

        record(dir.path(), RefreshOutcome::ReconnectRequired);
        record(dir.path(), RefreshOutcome::NotDue);
        assert!(read(dir.path()).is_none());
    }

    #[test]
    fn removing_a_missing_file_is_silent() {
        let dir = tempfile::tempdir().unwrap();
        record(dir.path(), RefreshOutcome::Refreshed);
        assert!(read(dir.path()).is_none());
    }
}
