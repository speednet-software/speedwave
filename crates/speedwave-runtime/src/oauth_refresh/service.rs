use std::path::Path;

use chrono::Utc;

use super::provider::{ErrorCode, RefreshRequest, RefreshResponse};
use super::store::{self, Paths};
use super::{audit, schedule, status, RefreshOutcome};
use crate::fs_perms;

pub(super) fn refresh_if_due<F>(
    data_dir: &Path,
    project: &str,
    service: &str,
    call: &F,
) -> RefreshOutcome
where
    F: Fn(&str, &RefreshRequest<'_>) -> Result<RefreshResponse, ErrorCode>,
{
    let paths = Paths::new(data_dir, project, service);
    let due = match store::load(&paths.state) {
        Ok(None) => return RefreshOutcome::NotDue,
        Ok(Some(state)) => {
            schedule::needs_refresh(Utc::now(), state.last_refresh_at, state.expires_at)
        }
        Err(_) => true,
    };
    if !due {
        status::record(&paths.token_dir, RefreshOutcome::NotDue);
        return RefreshOutcome::NotDue;
    }
    match fs_perms::with_file_lock_in(&paths.lock, || {
        Ok(refresh_locked(&paths, project, service, call))
    }) {
        Ok(outcome) => outcome,
        Err(_) => {
            log::warn!("could not take the token refresh lock for service {service}");
            RefreshOutcome::NetworkError
        }
    }
}

fn refresh_locked<F>(paths: &Paths, project: &str, service: &str, call: &F) -> RefreshOutcome
where
    F: Fn(&str, &RefreshRequest<'_>) -> Result<RefreshResponse, ErrorCode>,
{
    let state = match store::load(&paths.state) {
        Ok(Some(state)) => state,
        Ok(None) => return RefreshOutcome::NotDue,
        Err(code) => return failed(paths, project, service, code),
    };
    if !schedule::needs_refresh(Utc::now(), state.last_refresh_at, state.expires_at) {
        status::record(&paths.token_dir, RefreshOutcome::NotDue);
        return RefreshOutcome::NotDue;
    }

    let request = RefreshRequest {
        grant_type: state.grant(),
        refresh_token: &state.refresh_token,
        scopes: &state.scopes,
        provider_data: &state.provider_data,
    };
    let response = match call(&state.provider, &request) {
        Ok(response) => response,
        Err(code) => return failed(paths, project, service, code),
    };
    if let Err(code) = store::persist(paths, &state, &response) {
        return failed(paths, project, service, code);
    }

    audit::record(&paths.audit, project, service, Ok(()));
    status::record(&paths.token_dir, RefreshOutcome::Refreshed);
    RefreshOutcome::Refreshed
}

fn failed(paths: &Paths, project: &str, service: &str, code: ErrorCode) -> RefreshOutcome {
    audit::record(&paths.audit, project, service, Err(code));
    let outcome = if code.needs_reconnect() {
        RefreshOutcome::ReconnectRequired
    } else {
        RefreshOutcome::NetworkError
    };
    status::record(&paths.token_dir, outcome);
    outcome
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use chrono::SecondsFormat;

    use super::*;
    use crate::consts;

    fn write_state(paths: &Paths, hours_left: i64) {
        let now = Utc::now();
        let json = serde_json::json!({
            "provider": "slack",
            "providerData": {"clientId": "cid"},
            "scopes": ["chat:write"],
            "grantedScopes": ["chat:write"],
            "refreshToken": "old-rt",
            "expiresAt": (now + chrono::Duration::hours(hours_left))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            "lastRefreshAt": (now + chrono::Duration::hours(hours_left - 12))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        });
        std::fs::create_dir_all(paths.state.parent().unwrap()).unwrap();
        std::fs::write(&paths.state, json.to_string()).unwrap();
    }

    fn rotated() -> Result<RefreshResponse, ErrorCode> {
        Ok(RefreshResponse {
            access_token: "new-at".to_string(),
            refresh_token: Some("new-rt".to_string()),
            expires_in: 43_200,
            granted_scopes: vec!["chat:write".to_string()],
        })
    }

    fn status_state(paths: &Paths) -> Option<String> {
        let text = std::fs::read_to_string(paths.token_dir.join(consts::OAUTH_REFRESH_STATUS_FILE))
            .ok()?;
        let json: serde_json::Value = serde_json::from_str(&text).ok()?;
        json["state"].as_str().map(str::to_string)
    }

    #[test]
    fn a_fresh_token_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths, 10);
        let calls = AtomicUsize::new(0);
        let call = |_: &str, _: &RefreshRequest<'_>| {
            calls.fetch_add(1, Ordering::SeqCst);
            rotated()
        };
        assert_eq!(
            refresh_if_due(dir.path(), "proj", "slack", &call),
            RefreshOutcome::NotDue
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!paths.token_dir.join("access_token").exists());
    }

    #[test]
    fn a_service_without_state_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let call = |_: &str, _: &RefreshRequest<'_>| rotated();
        assert_eq!(
            refresh_if_due(dir.path(), "proj", "slack", &call),
            RefreshOutcome::NotDue
        );
    }

    #[test]
    fn a_token_below_a_quarter_of_its_lifetime_is_refreshed_and_stored() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths, 2);
        std::fs::create_dir_all(&paths.token_dir).unwrap();
        std::fs::write(
            paths.token_dir.join(consts::OAUTH_REFRESH_STATUS_FILE),
            r#"{"state":"network_error","at":"2026-11-18T09:00:00.000Z"}"#,
        )
        .unwrap();
        let call = |provider: &str, request: &RefreshRequest<'_>| {
            assert_eq!(provider, "slack");
            assert_eq!(request.refresh_token, "old-rt");
            assert_eq!(request.provider_data["clientId"], "cid");
            rotated()
        };

        assert_eq!(
            refresh_if_due(dir.path(), "proj", "slack", &call),
            RefreshOutcome::Refreshed
        );

        let state = store::load(&paths.state).ok().flatten().unwrap();
        assert_eq!(state.refresh_token, "new-rt");
        assert_eq!(
            std::fs::read_to_string(paths.token_dir.join("access_token")).unwrap(),
            "new-at"
        );
        assert_eq!(status_state(&paths), None);
        let audit = std::fs::read_to_string(&paths.audit).unwrap();
        assert!(audit.contains(" service=slack action=refresh outcome=ok"));
        assert_eq!(
            refresh_if_due(dir.path(), "proj", "slack", &call),
            RefreshOutcome::NotDue
        );
    }

    #[test]
    fn an_expired_token_is_refreshed() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths, -5);
        let call = |_: &str, _: &RefreshRequest<'_>| rotated();
        assert_eq!(
            refresh_if_due(dir.path(), "proj", "slack", &call),
            RefreshOutcome::Refreshed
        );
    }

    #[test]
    fn a_rejected_grant_asks_for_a_reconnect_and_keeps_the_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths, 1);
        let call = |_: &str, _: &RefreshRequest<'_>| Err(ErrorCode::InvalidGrant);

        assert_eq!(
            refresh_if_due(dir.path(), "proj", "slack", &call),
            RefreshOutcome::ReconnectRequired
        );

        assert_eq!(status_state(&paths).as_deref(), Some("reconnect_required"));
        let state = store::load(&paths.state).ok().flatten().unwrap();
        assert_eq!(state.refresh_token, "old-rt");
        assert!(!paths.token_dir.join("access_token").exists());
        let audit = std::fs::read_to_string(&paths.audit).unwrap();
        assert!(audit.contains(" outcome=error:invalid_grant"));
    }

    #[test]
    fn a_network_failure_is_retried_and_reported_as_such() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths, 1);
        let failing = |_: &str, _: &RefreshRequest<'_>| Err(ErrorCode::Network);

        assert_eq!(
            refresh_if_due(dir.path(), "proj", "slack", &failing),
            RefreshOutcome::NetworkError
        );
        assert_eq!(status_state(&paths).as_deref(), Some("network_error"));

        let working = |_: &str, _: &RefreshRequest<'_>| rotated();
        assert_eq!(
            refresh_if_due(dir.path(), "proj", "slack", &working),
            RefreshOutcome::Refreshed
        );
        assert_eq!(status_state(&paths), None);
    }

    #[test]
    fn a_broken_state_file_asks_for_a_reconnect() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        std::fs::create_dir_all(paths.state.parent().unwrap()).unwrap();
        std::fs::write(&paths.state, "{").unwrap();
        let call = |_: &str, _: &RefreshRequest<'_>| rotated();
        assert_eq!(
            refresh_if_due(dir.path(), "proj", "slack", &call),
            RefreshOutcome::ReconnectRequired
        );
    }

    #[test]
    fn a_fresh_token_clears_a_stale_failure_status() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths, 10);
        std::fs::create_dir_all(&paths.token_dir).unwrap();
        std::fs::write(
            paths.token_dir.join(consts::OAUTH_REFRESH_STATUS_FILE),
            r#"{"state":"reconnect_required","at":"2026-11-18T09:00:00.000Z"}"#,
        )
        .unwrap();
        let call = |_: &str, _: &RefreshRequest<'_>| rotated();
        assert_eq!(
            refresh_if_due(dir.path(), "proj", "slack", &call),
            RefreshOutcome::NotDue
        );
        assert_eq!(status_state(&paths), None);
    }

    #[test]
    fn two_threads_at_the_threshold_make_one_provider_call() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths, 1);
        let calls = AtomicUsize::new(0);
        let call = |_: &str, request: &RefreshRequest<'_>| {
            assert_eq!(request.refresh_token, "old-rt");
            calls.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(300));
            rotated()
        };

        let mut outcomes = std::thread::scope(|scope| {
            let first = scope.spawn(|| refresh_if_due(dir.path(), "proj", "slack", &call));
            let second = scope.spawn(|| refresh_if_due(dir.path(), "proj", "slack", &call));
            [first.join().unwrap(), second.join().unwrap()]
        });

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        outcomes.sort_by_key(|o| *o == RefreshOutcome::Refreshed);
        assert_eq!(
            outcomes,
            [RefreshOutcome::NotDue, RefreshOutcome::Refreshed]
        );
        let state = store::load(&paths.state).ok().flatten().unwrap();
        assert_eq!(state.refresh_token, "new-rt");
    }
}
