//! Host-side OAuth token refresh.

mod audit;
mod display_name;
mod generic;
mod http;
mod microsoft;
mod provider;
mod schedule;
mod service;
mod slack;
mod status;
mod store;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use provider::{ErrorCode, RefreshRequest, RefreshResponse};

use crate::consts;

/// Result of one check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefreshOutcome {
    /// Nothing to refresh.
    NotDue,
    /// The token was refreshed.
    Refreshed,
    /// The user must sign in again.
    ReconnectRequired,
    /// A later attempt can succeed.
    NetworkError,
}

/// Outcome for one service.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceRefresh {
    /// Service id.
    pub service: String,
    /// Check result.
    pub outcome: RefreshOutcome,
}

/// Refreshes the due tokens of `project`, waiting at most `timeout`.
pub fn refresh_now_with_timeout(project: &str, timeout: Duration) -> Vec<ServiceRefresh> {
    refresh_with_timeout(
        consts::data_dir().clone(),
        project.to_string(),
        timeout,
        provider::refresh,
    )
}

fn refresh_with_timeout<F>(
    data_dir: PathBuf,
    project: String,
    timeout: Duration,
    call: F,
) -> Vec<ServiceRefresh>
where
    F: Fn(&str, &RefreshRequest<'_>) -> Result<RefreshResponse, ErrorCode> + Send + 'static,
{
    let (sender, receiver) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("oauth-refresh-once".to_string())
        .spawn(move || {
            let mut holds = HashMap::new();
            let _ = sender.send(refresh_project(
                &data_dir,
                &project,
                &call,
                &mut holds,
                Instant::now(),
            ));
        });
    if spawned.is_err() {
        log::warn!("failed to start the start-of-session token refresh");
        return Vec::new();
    }
    receiver.recv_timeout(timeout).unwrap_or_default()
}

/// Handle of the background refresher; dropping it stops the thread.
pub struct SessionRefresher {
    _stop: mpsc::Sender<()>,
}

/// Refreshes the due tokens of `project` periodically; `on_change` gets each changed outcome.
pub fn spawn_session_refresher<F>(project: &str, on_change: F) -> SessionRefresher
where
    F: Fn(&ServiceRefresh) + Send + 'static,
{
    let (stop, stopped) = mpsc::channel();
    let project = project.to_string();
    let spawned = std::thread::Builder::new()
        .name("oauth-refresh".to_string())
        .spawn(move || {
            run_session_refresher(
                consts::data_dir().clone(),
                &project,
                consts::OAUTH_REFRESH_CHECK_INTERVAL,
                &provider::refresh,
                &on_change,
                &stopped,
            );
        });
    if spawned.is_err() {
        log::warn!("failed to start the session token refresher");
    }
    SessionRefresher { _stop: stop }
}

fn run_session_refresher<F, G>(
    data_dir: PathBuf,
    project: &str,
    interval: Duration,
    call: &F,
    on_change: &G,
    stopped: &mpsc::Receiver<()>,
) where
    F: Fn(&str, &RefreshRequest<'_>) -> Result<RefreshResponse, ErrorCode>,
    G: Fn(&ServiceRefresh),
{
    let mut last: HashMap<String, RefreshOutcome> = HashMap::new();
    let mut holds: HashMap<String, service::Hold> = HashMap::new();
    loop {
        for result in refresh_project(&data_dir, project, call, &mut holds, Instant::now()) {
            report(&mut last, &result, on_change);
        }
        if !matches!(
            stopped.recv_timeout(interval),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            return;
        }
    }
}

fn refresh_project<F>(
    data_dir: &std::path::Path,
    project: &str,
    call: &F,
    holds: &mut HashMap<String, service::Hold>,
    now: Instant,
) -> Vec<ServiceRefresh>
where
    F: Fn(&str, &RefreshRequest<'_>) -> Result<RefreshResponse, ErrorCode>,
{
    store::services(data_dir, project)
        .into_iter()
        .map(|service| {
            display_name::write(data_dir, project, &service);
            let hold = holds.entry(service.clone()).or_default();
            let outcome = service::refresh_gated(data_dir, project, &service, call, hold, now);
            ServiceRefresh { service, outcome }
        })
        .collect()
}

fn report<G>(last: &mut HashMap<String, RefreshOutcome>, result: &ServiceRefresh, on: &G)
where
    G: Fn(&ServiceRefresh),
{
    let ServiceRefresh { service, outcome } = result;
    if last.insert(service.clone(), *outcome) == Some(*outcome) {
        return;
    }
    match outcome {
        RefreshOutcome::Refreshed => log::info!("refreshed the token of service {service}"),
        RefreshOutcome::NetworkError => {
            log::warn!("token refresh of service {service} failed, retrying");
        }
        RefreshOutcome::ReconnectRequired => {
            log::warn!("service {service} needs a new sign-in");
        }
        RefreshOutcome::NotDue => {}
    }
    on(result);
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use chrono::{SecondsFormat, Utc};

    use super::*;

    fn write_due_state(data_dir: &std::path::Path, service: &str) {
        let now = Utc::now();
        let json = serde_json::json!({
            "provider": "slack",
            "providerData": {"clientId": "cid"},
            "scopes": [],
            "grantedScopes": [],
            "refreshToken": "rt",
            "expiresAt": (now + chrono::Duration::minutes(30))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            "lastRefreshAt": (now - chrono::Duration::hours(11))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        });
        let path = crate::plugin::oauth_state_file_in(data_dir, "proj", service);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, json.to_string()).unwrap();
    }

    fn rotated(_: &str, _: &RefreshRequest<'_>) -> Result<RefreshResponse, ErrorCode> {
        Ok(RefreshResponse {
            access_token: "at".to_string(),
            refresh_token: Some("rt2".to_string()),
            expires_in: 43_200,
            granted_scopes: Vec::new(),
        })
    }

    #[test]
    fn every_service_of_the_project_is_checked() {
        let dir = tempfile::tempdir().unwrap();
        write_due_state(dir.path(), "slack");
        write_due_state(dir.path(), "sharepoint");
        let mut holds = HashMap::new();
        let now = Instant::now();
        let results = refresh_project(dir.path(), "proj", &rotated, &mut holds, now);
        let outcomes: Vec<(&str, RefreshOutcome)> = results
            .iter()
            .map(|r| (r.service.as_str(), r.outcome))
            .collect();
        assert_eq!(
            outcomes,
            vec![
                ("sharepoint", RefreshOutcome::Refreshed),
                ("slack", RefreshOutcome::Refreshed)
            ]
        );
        assert_eq!(
            refresh_project(dir.path(), "proj", &rotated, &mut holds, now)
                .iter()
                .map(|r| r.outcome)
                .collect::<Vec<_>>(),
            vec![RefreshOutcome::NotDue, RefreshOutcome::NotDue]
        );
        assert!(refresh_project(dir.path(), "other", &rotated, &mut holds, now).is_empty());
    }

    #[test]
    fn the_refresher_reports_a_reconnect_once_asks_the_provider_once_and_stops_when_dropped() {
        let dir = tempfile::tempdir().unwrap();
        write_due_state(dir.path(), "slack");
        let attempts = Arc::new(AtomicUsize::new(0));
        let reported = Arc::new(Mutex::new(Vec::<String>::new()));
        let (stop, stopped) = mpsc::channel();

        let worker = {
            let attempts = Arc::clone(&attempts);
            let reported = Arc::clone(&reported);
            let data_dir = dir.path().to_path_buf();
            std::thread::spawn(move || {
                let call = |_: &str, _: &RefreshRequest<'_>| {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    Err(ErrorCode::InvalidGrant)
                };
                let on = |refresh: &ServiceRefresh| {
                    reported.lock().unwrap().push(refresh.service.clone());
                };
                run_session_refresher(
                    data_dir,
                    "proj",
                    Duration::from_millis(5),
                    &call,
                    &on,
                    &stopped,
                );
            })
        };

        let deadline = Instant::now() + Duration::from_secs(10);
        while attempts.load(Ordering::SeqCst) < 1 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        std::thread::sleep(Duration::from_millis(100));
        drop(stop);
        worker.join().unwrap();

        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert_eq!(*reported.lock().unwrap(), vec!["slack".to_string()]);
    }

    #[test]
    fn only_changes_of_outcome_are_reported_so_a_recovery_and_a_new_failure_are_seen() {
        let reported = Mutex::new(Vec::<RefreshOutcome>::new());
        let on = |refresh: &ServiceRefresh| reported.lock().unwrap().push(refresh.outcome);
        let mut last = HashMap::new();
        for outcome in [
            RefreshOutcome::ReconnectRequired,
            RefreshOutcome::ReconnectRequired,
            RefreshOutcome::NotDue,
            RefreshOutcome::ReconnectRequired,
        ] {
            report(
                &mut last,
                &ServiceRefresh {
                    service: "slack".to_string(),
                    outcome,
                },
                &on,
            );
        }
        assert_eq!(
            *reported.lock().unwrap(),
            vec![
                RefreshOutcome::ReconnectRequired,
                RefreshOutcome::NotDue,
                RefreshOutcome::ReconnectRequired
            ]
        );
    }

    #[test]
    fn the_start_of_session_check_returns_its_results() {
        let dir = tempfile::tempdir().unwrap();
        write_due_state(dir.path(), "slack");
        let results = refresh_with_timeout(
            dir.path().to_path_buf(),
            "proj".to_string(),
            Duration::from_secs(10),
            rotated,
        );
        assert_eq!(
            results,
            vec![ServiceRefresh {
                service: "slack".to_string(),
                outcome: RefreshOutcome::Refreshed
            }]
        );
    }

    #[test]
    fn the_start_of_session_check_gives_up_on_a_slow_provider_but_the_refresh_still_lands() {
        let dir = tempfile::tempdir().unwrap();
        write_due_state(dir.path(), "slack");
        let slow = |provider: &str, request: &RefreshRequest<'_>| {
            std::thread::sleep(Duration::from_millis(300));
            rotated(provider, request)
        };
        let started = std::time::Instant::now();
        let results = refresh_with_timeout(
            dir.path().to_path_buf(),
            "proj".to_string(),
            Duration::from_millis(20),
            slow,
        );
        assert!(results.is_empty());
        assert!(started.elapsed() < Duration::from_millis(250));

        let token = store::Paths::new(dir.path(), "proj", "slack")
            .token_dir
            .join("access_token");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !token.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(std::fs::read_to_string(token).unwrap(), "at");
    }
}
