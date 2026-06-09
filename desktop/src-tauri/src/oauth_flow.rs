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

    /// Returned generation lets the caller detect mid-HTTP supersession.
    pub fn install(&self, request_id: String, cancel: CancellationToken) -> Result<u64, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;
        state.generation += 1;
        if let Some(prev) = state.current.take() {
            prev.cancel.cancel();
        }
        let gen = state.generation;
        state.current = Some(ActiveFlow { request_id, cancel });
        Ok(gen)
    }

    pub fn current_generation(&self) -> Result<u64, String> {
        let state = self
            .state
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;
        Ok(state.generation)
    }

    /// Drop only if `request_id` still matches — a fresh flow must not be
    /// erased by the old flow's polling task.
    pub fn clear_if_current(&self, request_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            if state.current.as_ref().map(|f| f.request_id.as_str()) == Some(request_id) {
                state.current = None;
            }
        }
    }

    pub fn cancel(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.generation += 1;
            if let Some(active) = state.current.take() {
                active.cancel.cancel();
            }
        }
    }
}

pub(crate) fn emit_progress(
    app: &tauri::AppHandle,
    registry: &FlowRegistry,
    status: &str,
    message: &str,
    request_id: &str,
) {
    let event = OAuthProgressEvent {
        status: status.to_string(),
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
/// `on_success(body)` parses+persists IdP-specific tokens; `classify(body)`
/// returns `Ok(())` on success-shaped body, else a [`PollAction`]. The whole
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
    C: Fn(&[u8]) -> Result<(), PollAction> + Send + 'static,
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
                    "expired",
                    "Device code expired — please try again",
                    &request_id,
                );
                registry.clear_if_current(&request_id);
                return;
            }
            tokio::select! {
                () = tokio::time::sleep(Duration::from_secs(interval)) => {}
                () = cancel.cancelled() => {
                    emit_progress(&app, registry, "cancelled", "OAuth flow cancelled", &request_id);
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
                    "cancelled",
                    "OAuth flow cancelled",
                    &request_id,
                );
                registry.clear_if_current(&request_id);
                return;
            }

            let bytes = match resp {
                Ok(r) => match crate::http_util::read_body_limited(r, "token").await {
                    Ok(b) => b,
                    Err(e) => {
                        emit_progress(&app, registry, "error", &e, &request_id);
                        registry.clear_if_current(&request_id);
                        return;
                    }
                },
                Err(e) => {
                    emit_progress(
                        &app,
                        registry,
                        "error",
                        &format!("Network error: {e}"),
                        &request_id,
                    );
                    registry.clear_if_current(&request_id);
                    return;
                }
            };

            match classify(&bytes) {
                Ok(()) => {
                    if let Err(e) = on_success(&bytes) {
                        emit_progress(
                            &app,
                            registry,
                            "error",
                            &format!("Failed to save tokens: {e}"),
                            &request_id,
                        );
                    } else {
                        emit_progress(
                            &app,
                            registry,
                            "success",
                            "Authentication successful",
                            &request_id,
                        );
                    }
                    registry.clear_if_current(&request_id);
                    return;
                }
                Err(PollAction::KeepPolling) => continue,
                Err(PollAction::SlowDown) => {
                    interval += 5;
                    continue;
                }
                Err(PollAction::Expired(msg)) => {
                    emit_progress(&app, registry, "expired", &msg, &request_id);
                    registry.clear_if_current(&request_id);
                    return;
                }
                Err(PollAction::Failed(msg)) => {
                    emit_progress(&app, registry, "error", &msg, &request_id);
                    registry.clear_if_current(&request_id);
                    return;
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
        let _ = reg.install("rid-1".to_string(), old.clone()).unwrap();

        let new = CancellationToken::new();
        let gen = reg.install("rid-2".to_string(), new.clone()).unwrap();

        assert!(old.is_cancelled(), "previous token must be cancelled");
        assert!(!new.is_cancelled(), "new token must be live");
        assert!(gen >= 2);
    }

    #[test]
    #[serial]
    fn clear_if_current_only_clears_matching_id() {
        let reg = FlowRegistry::new("test_oauth_progress");
        let token = CancellationToken::new();
        let _ = reg.install("keep-me".to_string(), token).unwrap();

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
        let _ = reg.install("rid".to_string(), token.clone()).unwrap();
        let before = reg.current_generation().unwrap();

        reg.cancel();

        assert!(token.is_cancelled());
        assert!(reg.state.lock().unwrap().current.is_none());
        assert!(reg.current_generation().unwrap() > before);
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
