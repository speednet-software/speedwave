use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Instant;

use chrono::Utc;

use super::provider::{ErrorCode, RefreshRequest, RefreshResponse};
use super::store::{self, Paths};
use super::{audit, schedule, RefreshOutcome};
use crate::fs_perms;

#[derive(Clone, Copy, Debug, Default)]
pub(super) enum Hold {
    #[default]
    Ready,
    Until {
        at: Instant,
        state: Option<u64>,
        failures: u32,
    },
    StateChange {
        state: Option<u64>,
    },
}

type Slots = HashMap<(String, String), Arc<Mutex<Hold>>>;

/// Holds of every `(project, service)` of the process, shared by the start check and the refreshers.
#[derive(Clone, Default)]
pub(super) struct Holds(Arc<Mutex<Slots>>);

impl Holds {
    pub(super) fn shared() -> Self {
        static SHARED: OnceLock<Holds> = OnceLock::new();
        SHARED.get_or_init(Self::default).clone()
    }

    /// The hold of one service; whoever locks it waits while another thread refreshes that service.
    pub(super) fn slot(&self, project: &str, service: &str) -> Arc<Mutex<Hold>> {
        Arc::clone(
            self.0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry((project.to_string(), service.to_string()))
                .or_default(),
        )
    }
}

pub(super) fn refresh_gated<F>(
    data_dir: &Path,
    project: &str,
    service: &str,
    call: &F,
    hold: &mut Hold,
    now: Instant,
) -> RefreshOutcome
where
    F: Fn(&str, &RefreshRequest<'_>) -> Result<RefreshResponse, ErrorCode>,
{
    let state = match fingerprint(&Paths::new(data_dir, project, service).state) {
        Ok(state) => state,
        Err(_) => match *hold {
            Hold::StateChange { .. } => return RefreshOutcome::ReconnectRequired,
            Hold::Until { .. } => return RefreshOutcome::NetworkError,
            Hold::Ready => None,
        },
    };
    let failures = match *hold {
        Hold::StateChange { state: held } if held == state => {
            return RefreshOutcome::ReconnectRequired;
        }
        Hold::Until {
            at,
            state: held,
            failures,
        } if held == state => {
            if now < at {
                return RefreshOutcome::NetworkError;
            }
            failures
        }
        Hold::Ready | Hold::Until { .. } | Hold::StateChange { .. } => 0,
    };
    let outcome = refresh_if_due(data_dir, project, service, call);
    *hold = match outcome {
        RefreshOutcome::ReconnectRequired => Hold::StateChange { state },
        RefreshOutcome::NetworkError => {
            let failures = failures.saturating_add(1);
            Hold::Until {
                at: now + schedule::retry_delay(failures),
                state,
                failures,
            }
        }
        RefreshOutcome::Refreshed | RefreshOutcome::NotDue => Hold::Ready,
    };
    outcome
}

fn fingerprint(path: &Path) -> std::io::Result<Option<u64>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let mut hasher = DefaultHasher::new();
            bytes.hash(&mut hasher);
            Ok(Some(hasher.finish()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn refresh_if_due<F>(data_dir: &Path, project: &str, service: &str, call: &F) -> RefreshOutcome
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
    RefreshOutcome::Refreshed
}

fn failed(paths: &Paths, project: &str, service: &str, code: ErrorCode) -> RefreshOutcome {
    audit::record(&paths.audit, project, service, Err(code));
    if code.needs_reconnect() {
        RefreshOutcome::ReconnectRequired
    } else {
        RefreshOutcome::NetworkError
    }
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

        let working = |_: &str, _: &RefreshRequest<'_>| rotated();
        assert_eq!(
            refresh_if_due(dir.path(), "proj", "slack", &working),
            RefreshOutcome::Refreshed
        );
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

    fn failing_with(
        code: ErrorCode,
        calls: &AtomicUsize,
    ) -> impl Fn(&str, &RefreshRequest<'_>) -> Result<RefreshResponse, ErrorCode> + '_ {
        move |_: &str, _: &RefreshRequest<'_>| {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(code)
        }
    }

    fn secs(base: Instant, n: u64) -> Instant {
        base + Duration::from_secs(n)
    }

    fn audit_lines(paths: &Paths) -> usize {
        std::fs::read_to_string(&paths.audit).map_or(0, |text| text.lines().count())
    }

    #[test]
    fn every_reconnect_code_waits_for_the_state_file() {
        for code in [
            ErrorCode::InvalidGrant,
            ErrorCode::ScopeMismatch,
            ErrorCode::MissingField,
            ErrorCode::InvalidConfig,
            ErrorCode::MalformedState,
            ErrorCode::UnknownProvider,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let paths = Paths::new(dir.path(), "proj", "slack");
            write_state(&paths, 1);
            let calls = AtomicUsize::new(0);
            let call = failing_with(code, &calls);
            let mut hold = Hold::default();
            let t0 = Instant::now();
            for tick in 0..3 {
                refresh_gated(
                    dir.path(),
                    "proj",
                    "slack",
                    &call,
                    &mut hold,
                    secs(t0, tick * 10),
                );
            }
            assert_eq!(calls.load(Ordering::SeqCst), 1, "{code:?}");
        }
    }

    #[test]
    fn a_broken_state_file_is_judged_once_until_it_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        std::fs::create_dir_all(paths.state.parent().unwrap()).unwrap();
        std::fs::write(&paths.state, "{").unwrap();
        let calls = AtomicUsize::new(0);
        let call = failing_with(ErrorCode::InvalidGrant, &calls);
        let mut hold = Hold::default();
        let t0 = Instant::now();

        for tick in 0..3 {
            assert_eq!(
                refresh_gated(
                    dir.path(),
                    "proj",
                    "slack",
                    &call,
                    &mut hold,
                    secs(t0, tick * 10)
                ),
                RefreshOutcome::ReconnectRequired
            );
        }
        assert_eq!(audit_lines(&paths), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        write_state(&paths, 1);
        assert_eq!(
            refresh_gated(dir.path(), "proj", "slack", &call, &mut hold, secs(t0, 40)),
            RefreshOutcome::ReconnectRequired
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn an_unreadable_state_file_keeps_the_held_outcome() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths, 1);
        let calls = AtomicUsize::new(0);
        let call = failing_with(ErrorCode::InvalidGrant, &calls);
        let mut hold = Hold::default();
        let t0 = Instant::now();
        refresh_gated(dir.path(), "proj", "slack", &call, &mut hold, t0);

        std::fs::remove_file(&paths.state).unwrap();
        std::fs::create_dir(&paths.state).unwrap();
        assert_eq!(
            refresh_gated(dir.path(), "proj", "slack", &call, &mut hold, secs(t0, 10)),
            RefreshOutcome::ReconnectRequired
        );
        assert!(matches!(hold, Hold::StateChange { .. }));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_changed_state_file_ends_the_wait_for_a_reconnect() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths, 1);
        let calls = AtomicUsize::new(0);
        let rejecting = failing_with(ErrorCode::InvalidGrant, &calls);
        let mut hold = Hold::default();
        let t0 = Instant::now();
        refresh_gated(dir.path(), "proj", "slack", &rejecting, &mut hold, t0);
        refresh_gated(
            dir.path(),
            "proj",
            "slack",
            &rejecting,
            &mut hold,
            secs(t0, 10),
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        write_state(&paths, 2);
        let working = |_: &str, _: &RefreshRequest<'_>| {
            calls.fetch_add(1, Ordering::SeqCst);
            rotated()
        };
        assert_eq!(
            refresh_gated(
                dir.path(),
                "proj",
                "slack",
                &working,
                &mut hold,
                secs(t0, 20)
            ),
            RefreshOutcome::Refreshed
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(matches!(hold, Hold::Ready));
    }

    #[test]
    fn a_successful_refresh_resets_the_backoff() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths, 1);
        let calls = AtomicUsize::new(0);
        let failing = failing_with(ErrorCode::Network, &calls);
        let mut hold = Hold::default();
        let t0 = Instant::now();
        refresh_gated(dir.path(), "proj", "slack", &failing, &mut hold, t0);
        refresh_gated(
            dir.path(),
            "proj",
            "slack",
            &failing,
            &mut hold,
            secs(t0, 10),
        );
        refresh_gated(
            dir.path(),
            "proj",
            "slack",
            &failing,
            &mut hold,
            secs(t0, 30),
        );
        assert!(matches!(hold, Hold::Until { failures: 3, .. }));

        let working = |_: &str, _: &RefreshRequest<'_>| rotated();
        assert_eq!(
            refresh_gated(
                dir.path(),
                "proj",
                "slack",
                &working,
                &mut hold,
                secs(t0, 70)
            ),
            RefreshOutcome::Refreshed
        );
        assert!(matches!(hold, Hold::Ready));
    }

    #[test]
    fn a_changed_state_file_resets_the_backoff_and_retries_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths, 1);
        let calls = AtomicUsize::new(0);
        let call = failing_with(ErrorCode::Network, &calls);
        let mut hold = Hold::default();
        let t0 = Instant::now();
        refresh_gated(dir.path(), "proj", "slack", &call, &mut hold, t0);
        refresh_gated(dir.path(), "proj", "slack", &call, &mut hold, secs(t0, 10));
        refresh_gated(dir.path(), "proj", "slack", &call, &mut hold, secs(t0, 30));
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        write_state(&paths, 2);
        refresh_gated(dir.path(), "proj", "slack", &call, &mut hold, secs(t0, 31));
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        assert!(matches!(hold, Hold::Until { failures: 1, .. }));

        refresh_gated(dir.path(), "proj", "slack", &call, &mut hold, secs(t0, 41));
        assert_eq!(calls.load(Ordering::SeqCst), 5);
    }

    #[test]
    fn a_network_failure_backs_off_from_ten_seconds_and_doubles_to_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths, 1);
        let calls = AtomicUsize::new(0);
        let call = failing_with(ErrorCode::Network, &calls);
        let mut hold = Hold::default();
        let t0 = Instant::now();

        let mut now = 0;
        for (attempt, wait) in [(1, 10), (2, 20), (3, 40), (4, 80), (5, 120), (6, 120)] {
            assert_eq!(
                refresh_gated(dir.path(), "proj", "slack", &call, &mut hold, secs(t0, now)),
                RefreshOutcome::NetworkError
            );
            assert_eq!(calls.load(Ordering::SeqCst), attempt);
            let early = secs(t0, now + wait - 1);
            assert_eq!(
                refresh_gated(dir.path(), "proj", "slack", &call, &mut hold, early),
                RefreshOutcome::NetworkError
            );
            assert_eq!(calls.load(Ordering::SeqCst), attempt, "held for {wait} s");
            now += wait;
        }
        refresh_gated(dir.path(), "proj", "slack", &call, &mut hold, secs(t0, now));
        assert_eq!(calls.load(Ordering::SeqCst), 7);
    }

    #[test]
    fn an_unreadable_state_file_keeps_the_backoff_even_after_the_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path(), "proj", "slack");
        write_state(&paths, 1);
        let calls = AtomicUsize::new(0);
        let call = failing_with(ErrorCode::Network, &calls);
        let mut hold = Hold::default();
        let t0 = Instant::now();
        refresh_gated(dir.path(), "proj", "slack", &call, &mut hold, t0);

        std::fs::remove_file(&paths.state).unwrap();
        std::fs::create_dir(&paths.state).unwrap();
        for tick in [5, 10, 600] {
            assert_eq!(
                refresh_gated(
                    dir.path(),
                    "proj",
                    "slack",
                    &call,
                    &mut hold,
                    secs(t0, tick)
                ),
                RefreshOutcome::NetworkError
            );
        }
        assert!(matches!(hold, Hold::Until { failures: 1, .. }));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
