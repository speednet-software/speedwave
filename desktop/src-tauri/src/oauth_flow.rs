// Shared OAuth Device Flow scaffolding. Per-provider `FlowRegistry` owns
// state + event name; the surrounding state machine is identical.

use serde::Serialize;
use std::sync::Mutex;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

#[derive(Serialize, Clone)]
pub(crate) struct DeviceCodeInfo {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub request_id: String,
}

#[derive(Serialize, Clone)]
struct OAuthProgressEvent {
    status: String,
    message: String,
    request_id: String,
}

/// Every `status` the host emits on an OAuth progress event. TS mirror:
/// `OAuthProgressEvent['status']` in `models/integration.ts` (which adds the
/// frontend-only `starting`/`polling`); `progress_statuses_match_ts_union`
/// keeps the two in sync.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ProgressStatus {
    AwaitingRedirect,
    Exchanging,
    Success,
    Error,
    Cancelled,
    Expired,
}

impl ProgressStatus {
    /// Used by the TS-union guard test only.
    #[cfg(test)]
    pub(crate) const ALL: &'static [ProgressStatus] = &[
        ProgressStatus::AwaitingRedirect,
        ProgressStatus::Exchanging,
        ProgressStatus::Success,
        ProgressStatus::Error,
        ProgressStatus::Cancelled,
        ProgressStatus::Expired,
    ];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ProgressStatus::AwaitingRedirect => "awaiting_redirect",
            ProgressStatus::Exchanging => "exchanging",
            ProgressStatus::Success => "success",
            ProgressStatus::Error => "error",
            ProgressStatus::Cancelled => "cancelled",
            ProgressStatus::Expired => "expired",
        }
    }
}

pub(crate) struct ActiveFlow {
    pub request_id: String,
    pub cancel: CancellationToken,
}

pub(crate) struct FlowState {
    pub current: Option<ActiveFlow>,
    pub generation: u64,
}

pub(crate) struct FlowRegistry {
    pub state: Mutex<FlowState>,
    pub event_name: &'static str,
}

impl FlowRegistry {
    pub const fn new(event_name: &'static str) -> Self {
        Self {
            state: Mutex::new(FlowState {
                current: None,
                generation: 0,
            }),
            event_name,
        }
    }

    /// Recovers from poisoning: `FlowState` is two plain fields that stay
    /// coherent across a panic, and `cancel`/`clear_if_current` must still
    /// work mid-teardown (a poisoned lock must not leave a flow uncancelled).
    fn lock_state(&self) -> std::sync::MutexGuard<'_, FlowState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Returned generation lets the caller detect mid-HTTP supersession.
    pub fn install(&self, request_id: String, cancel: CancellationToken) -> u64 {
        let mut state = self.lock_state();
        state.generation += 1;
        if let Some(prev) = state.current.take() {
            prev.cancel.cancel();
        }
        let gen = state.generation;
        state.current = Some(ActiveFlow { request_id, cancel });
        gen
    }

    pub fn current_generation(&self) -> u64 {
        self.lock_state().generation
    }

    /// Drop only if `request_id` still matches — a fresh flow must not be
    /// erased by the old flow's polling task.
    pub fn clear_if_current(&self, request_id: &str) {
        let mut state = self.lock_state();
        if state.current.as_ref().map(|f| f.request_id.as_str()) == Some(request_id) {
            state.current = None;
        }
    }

    pub fn cancel(&self) {
        let mut state = self.lock_state();
        state.generation += 1;
        if let Some(active) = state.current.take() {
            active.cancel.cancel();
        }
    }
}

pub(crate) fn emit_progress(
    app: &tauri::AppHandle,
    registry: &FlowRegistry,
    status: ProgressStatus,
    message: &str,
    request_id: &str,
) {
    let event = OAuthProgressEvent {
        status: status.as_str().to_string(),
        message: message.to_string(),
        request_id: request_id.to_string(),
    };
    if let Err(e) = app.emit(registry.event_name, &event) {
        log::warn!("failed to emit {}: {e}", registry.event_name);
    }
}

/// What the device-poll loop does with one token-endpoint response. The
/// per-IdP classifier maps a `(error_code, error_description)` to one of these.
pub(crate) enum PollAction {
    /// Keep polling at the current interval (`authorization_pending`).
    KeepPolling,
    /// Back off: add 5s to the interval, then keep polling (`slow_down`).
    SlowDown,
    /// Device code expired — emit `expired` status and stop.
    Expired(String),
    /// Terminal failure — emit `error` status with this message and stop.
    Failed(String),
}

/// Applies one classified poll response: bumps the interval on `SlowDown`,
/// returns the terminal `(status, message)` when the loop must stop.
fn apply_poll_action(action: PollAction, interval: &mut u64) -> Option<(ProgressStatus, String)> {
    match action {
        PollAction::KeepPolling => None,
        PollAction::SlowDown => {
            *interval += 5;
            None
        }
        PollAction::Expired(msg) => Some((ProgressStatus::Expired, msg)),
        PollAction::Failed(msg) => Some((ProgressStatus::Error, msg)),
    }
}

use std::time::Duration;
use tokio::time::Instant;

/// Inputs for [`run_device_poll`]. The two closures carry the only per-IdP
/// differences: classifying a polling error and persisting a success body.
pub(crate) struct DevicePollConfig {
    pub client: reqwest::Client,
    pub token_url: String,
    pub form_body: String,
    /// `true` for GitHub (`Accept: application/json`).
    pub accept_json: bool,
    pub interval_secs: u64,
    pub expires_in_secs: u64,
}

/// Runs the device-code polling state machine shared by SharePoint and GitHub.
/// `on_success(body)` parses+persists IdP-specific tokens; `classify(status,
/// body)` returns `Ok(())` on a success-shaped body, else a [`PollAction`]. The
/// loop (deadline / sleep / cancel / network) is identical across IdPs.
pub(crate) fn run_device_poll<C, S>(
    app: tauri::AppHandle,
    registry: &'static FlowRegistry,
    request_id: String,
    config: DevicePollConfig,
    cancel: CancellationToken,
    classify: C,
    on_success: S,
) where
    C: Fn(u16, &[u8]) -> Result<(), PollAction> + Send + 'static,
    S: Fn(&[u8]) -> Result<(), String> + Send + 'static,
{
    tokio::spawn(async move {
        let mut interval = config.interval_secs;
        let deadline = Instant::now() + Duration::from_secs(config.expires_in_secs);
        loop {
            if Instant::now() >= deadline {
                emit_progress(
                    &app,
                    registry,
                    ProgressStatus::Expired,
                    "Device code expired — please try again",
                    &request_id,
                );
                registry.clear_if_current(&request_id);
                return;
            }
            tokio::select! {
                () = tokio::time::sleep(Duration::from_secs(interval)) => {}
                () = cancel.cancelled() => {
                    emit_progress(&app, registry, ProgressStatus::Cancelled, "OAuth flow cancelled", &request_id);
                    registry.clear_if_current(&request_id);
                    return;
                }
            }

            let mut req = config
                .client
                .post(&config.token_url)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(config.form_body.clone())
                .timeout(Duration::from_secs(30));
            if config.accept_json {
                req = req.header("Accept", "application/json");
            }
            let resp = req.send().await;

            if cancel.is_cancelled() {
                emit_progress(
                    &app,
                    registry,
                    ProgressStatus::Cancelled,
                    "OAuth flow cancelled",
                    &request_id,
                );
                registry.clear_if_current(&request_id);
                return;
            }

            let (status, bytes) = match resp {
                Ok(r) => {
                    let status = r.status().as_u16();
                    match crate::http_util::read_body_limited(r, "token").await {
                        Ok(b) => (status, b),
                        Err(e) => {
                            emit_progress(&app, registry, ProgressStatus::Error, &e, &request_id);
                            registry.clear_if_current(&request_id);
                            return;
                        }
                    }
                }
                Err(e) => {
                    emit_progress(
                        &app,
                        registry,
                        ProgressStatus::Error,
                        &format!("Network error: {e}"),
                        &request_id,
                    );
                    registry.clear_if_current(&request_id);
                    return;
                }
            };

            match classify(status, &bytes) {
                Ok(()) => {
                    if let Err(e) = on_success(&bytes) {
                        emit_progress(
                            &app,
                            registry,
                            ProgressStatus::Error,
                            &format!("Failed to save tokens: {e}"),
                            &request_id,
                        );
                    } else {
                        emit_progress(
                            &app,
                            registry,
                            ProgressStatus::Success,
                            "Authentication successful",
                            &request_id,
                        );
                    }
                    registry.clear_if_current(&request_id);
                    return;
                }
                Err(action) => {
                    if let Some((status, msg)) = apply_poll_action(action, &mut interval) {
                        emit_progress(&app, registry, status, &msg, &request_id);
                        registry.clear_if_current(&request_id);
                        return;
                    }
                }
            }
        }
    });
}

/// Atomic 0o600 write of a single credential into `svc_dir/<file_name>`.
pub(crate) fn save_credential_file(
    svc_dir: &std::path::Path,
    file_name: &str,
    value: &str,
) -> Result<(), String> {
    let max = crate::types::MAX_CREDENTIAL_BYTES;
    if value.len() > max {
        return Err(format!("{file_name} exceeds {max} bytes"));
    }
    std::fs::create_dir_all(svc_dir).map_err(|e| e.to_string())?;
    let path = svc_dir.join(file_name);
    speedwave_runtime::fs_perms::write_restricted_file(&path, value).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    #[serial]
    fn install_bumps_generation_and_cancels_previous() {
        let reg = FlowRegistry::new("test_oauth_progress");
        let old = CancellationToken::new();
        let _ = reg.install("rid-1".to_string(), old.clone());

        let new = CancellationToken::new();
        let gen = reg.install("rid-2".to_string(), new.clone());

        assert!(old.is_cancelled(), "previous token must be cancelled");
        assert!(!new.is_cancelled(), "new token must be live");
        assert!(gen >= 2);
    }

    #[test]
    #[serial]
    fn clear_if_current_only_clears_matching_id() {
        let reg = FlowRegistry::new("test_oauth_progress");
        let token = CancellationToken::new();
        let _ = reg.install("keep-me".to_string(), token);

        reg.clear_if_current("other-id");
        assert!(reg.state.lock().unwrap().current.is_some());

        reg.clear_if_current("keep-me");
        assert!(reg.state.lock().unwrap().current.is_none());
    }

    #[test]
    #[serial]
    fn cancel_clears_active_and_bumps_generation() {
        let reg = FlowRegistry::new("test_oauth_progress");
        let token = CancellationToken::new();
        let _ = reg.install("rid".to_string(), token.clone());
        let before = reg.current_generation();

        reg.cancel();

        assert!(token.is_cancelled());
        assert!(reg.state.lock().unwrap().current.is_none());
        assert!(reg.current_generation() > before);
    }

    // A panic while holding the lock must not disable cancellation — every
    // FlowRegistry method recovers from poisoning via lock_state.
    #[test]
    #[serial]
    fn registry_methods_survive_poisoned_lock() {
        static REG: FlowRegistry = FlowRegistry::new("test_oauth_progress");
        let token = CancellationToken::new();
        let _ = REG.install("rid".to_string(), token.clone());

        let _ = std::thread::spawn(|| {
            let _guard = REG.state.lock().unwrap();
            panic!("poison the lock");
        })
        .join();
        assert!(REG.state.lock().is_err(), "lock must be poisoned");

        REG.cancel();
        assert!(token.is_cancelled(), "cancel must work on a poisoned lock");
        let gen = REG.current_generation();
        assert_eq!(
            REG.install("rid-2".to_string(), CancellationToken::new()),
            gen + 1
        );
        REG.cancel();
    }

    #[test]
    fn apply_poll_action_keep_polling_leaves_interval() {
        let mut interval = 5;
        assert!(apply_poll_action(PollAction::KeepPolling, &mut interval).is_none());
        assert_eq!(interval, 5);
    }

    #[test]
    fn apply_poll_action_slow_down_adds_five() {
        let mut interval = 5;
        assert!(apply_poll_action(PollAction::SlowDown, &mut interval).is_none());
        assert_eq!(interval, 10);
    }

    #[test]
    fn apply_poll_action_expired_is_terminal() {
        let mut interval = 5;
        let (status, msg) =
            apply_poll_action(PollAction::Expired("gone".to_string()), &mut interval).unwrap();
        assert_eq!(status, ProgressStatus::Expired);
        assert_eq!(msg, "gone");
        assert_eq!(interval, 5);
    }

    #[test]
    fn apply_poll_action_failed_is_terminal_error() {
        let mut interval = 5;
        let (status, msg) =
            apply_poll_action(PollAction::Failed("boom".to_string()), &mut interval).unwrap();
        assert_eq!(status, ProgressStatus::Error);
        assert_eq!(msg, "boom");
    }

    // Cross-language SSOT guard (cf. allowed_auth_field_types_match_ts_union):
    // the TS OAuthProgressEvent['status'] union must equal the Rust-emitted
    // statuses plus the two frontend-only states ('starting', 'polling').
    #[test]
    fn progress_statuses_match_ts_union() {
        let src = include_str!("../../src/src/app/models/integration.ts");
        let start = src
            .find("export interface OAuthProgressEvent")
            .expect("integration.ts must declare OAuthProgressEvent");
        let status_pos = src[start..].find("status:").expect("status field") + start;
        let end = src[status_pos..].find(';').expect("union terminator") + status_pos;
        let mut ts: Vec<String> = src[status_pos + "status:".len()..end]
            .split('|')
            .map(|s| s.trim().trim_matches('\'').to_string())
            .filter(|s| !s.is_empty())
            .collect();
        ts.sort();

        let mut rust: Vec<String> = ProgressStatus::ALL
            .iter()
            .map(|s| s.as_str().to_string())
            .chain(["starting".to_string(), "polling".to_string()])
            .collect();
        rust.sort();

        assert_eq!(
            ts, rust,
            "integration.ts status union drifted from ProgressStatus"
        );
    }

    #[test]
    fn save_credential_file_writes_mode_0o600() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("svc");
        save_credential_file(&dir, "token", "value").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("token")).unwrap(), "value");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("token"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn save_credential_file_rejects_oversized() {
        let tmp = tempfile::tempdir().unwrap();
        let big = "x".repeat(crate::types::MAX_CREDENTIAL_BYTES + 1);
        let err = save_credential_file(tmp.path(), "token", &big).unwrap_err();
        assert!(err.contains("token"));
        assert!(err.contains("exceeds"));
    }

    #[test]
    fn save_credential_file_errors_on_unwritable_path() {
        let impossible = std::path::Path::new("/dev/null/impossible");
        let err = save_credential_file(impossible, "token", "v");
        assert!(err.is_err());
    }
}
