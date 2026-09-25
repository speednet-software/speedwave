use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

pub(crate) const MSG_TYPE_CONTROL_REQUEST: &str = "control_request";
pub(crate) const MSG_TYPE_CONTROL_RESPONSE: &str = "control_response";

pub(crate) const SESSION_INFO_EVENT: &str = "chat_session_info";

const SUBTYPE_INITIALIZE: &str = "initialize";
const SUBTYPE_GET_USAGE: &str = "get_usage";
const SUBTYPE_GET_CONTEXT_USAGE: &str = "get_context_usage";
const SUBTYPE_SET_MODEL: &str = "set_model";
const SUBTYPE_APPLY_FLAG_SETTINGS: &str = "apply_flag_settings";

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(15);
const GET_USAGE_TIMEOUT: Duration = Duration::from_secs(10);
const GET_CONTEXT_USAGE_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const SET_MODEL_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const APPLY_EFFORT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ControlQuery {
    Initialize,
    Usage,
    ContextUsage,
}

impl ControlQuery {
    pub(crate) fn subtype(self) -> &'static str {
        match self {
            Self::Initialize => SUBTYPE_INITIALIZE,
            Self::Usage => SUBTYPE_GET_USAGE,
            Self::ContextUsage => SUBTYPE_GET_CONTEXT_USAGE,
        }
    }

    pub(crate) fn timeout(self) -> Duration {
        match self {
            Self::Initialize => INITIALIZE_TIMEOUT,
            Self::Usage => GET_USAGE_TIMEOUT,
            Self::ContextUsage => GET_CONTEXT_USAGE_TIMEOUT,
        }
    }

    fn request_body(self) -> serde_json::Value {
        match self {
            Self::Initialize => serde_json::json!({ "subtype": SUBTYPE_INITIALIZE }),
            Self::Usage => serde_json::json!({
                "subtype": SUBTYPE_GET_USAGE,
                "skip_behaviors": true,
            }),
            Self::ContextUsage => serde_json::json!({
                "subtype": SUBTYPE_GET_CONTEXT_USAGE,
                "detail": "summary",
            }),
        }
    }
}

pub(crate) fn build_control_request(request_id: &str, query: ControlQuery) -> serde_json::Value {
    serde_json::json!({
        "type": MSG_TYPE_CONTROL_REQUEST,
        "request_id": request_id,
        "request": query.request_body(),
    })
}

pub(crate) fn build_set_model_request(request_id: &str, model: &str) -> serde_json::Value {
    serde_json::json!({
        "type": MSG_TYPE_CONTROL_REQUEST,
        "request_id": request_id,
        "request": { "subtype": SUBTYPE_SET_MODEL, "model": model },
    })
}

pub(crate) fn build_apply_effort_request(request_id: &str, level: &str) -> serde_json::Value {
    serde_json::json!({
        "type": MSG_TYPE_CONTROL_REQUEST,
        "request_id": request_id,
        "request": {
            "subtype": SUBTYPE_APPLY_FLAG_SETTINGS,
            "settings": { "effortLevel": level },
        },
    })
}

fn next_request_id(subtype: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("req_{subtype}_{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ControlError {
    Write(String),
    Timeout {
        subtype: &'static str,
        timeout: Duration,
    },
    SessionEnded,
    Rejected(String),
    Malformed(String),
}

impl std::fmt::Display for ControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Write(e) => write!(f, "failed to write control request: {e}"),
            Self::Timeout { subtype, timeout } => write!(
                f,
                "control request '{subtype}' got no response within {} ms",
                timeout.as_millis()
            ),
            Self::SessionEnded => write!(f, "chat session ended before the control response"),
            Self::Rejected(e) => write!(f, "Claude Code rejected the control request: {e}"),
            Self::Malformed(e) => write!(f, "control response was not understood: {e}"),
        }
    }
}

impl std::error::Error for ControlError {}

#[derive(Debug, Clone, PartialEq)]
enum ControlOutcome {
    Success(serde_json::Value),
    Rejected(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Routed {
    Delivered,
    Unmatched,
    Malformed,
}

#[derive(Default)]
struct Waiters {
    by_id: HashMap<String, mpsc::Sender<ControlOutcome>>,
    closed: bool,
}

#[derive(Clone, Default)]
pub(crate) struct ControlChannel {
    waiters: Arc<Mutex<Waiters>>,
}

impl ControlChannel {
    fn lock_waiters(&self) -> std::sync::MutexGuard<'_, Waiters> {
        self.waiters.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn route_response(&self, parsed: &serde_json::Value) -> Routed {
        let response = &parsed["response"];
        let Some(request_id) = response["request_id"].as_str() else {
            log::debug!("dropped control_response without a request id");
            return Routed::Malformed;
        };
        let Some(waiter) = self.lock_waiters().by_id.remove(request_id) else {
            log::debug!("dropped control_response for unknown request id {request_id}");
            return Routed::Unmatched;
        };
        let outcome = match response["subtype"].as_str() {
            Some("success") => ControlOutcome::Success(response["response"].clone()),
            Some("error") => ControlOutcome::Rejected(
                response["error"]
                    .as_str()
                    .unwrap_or("no error text")
                    .to_string(),
            ),
            other => ControlOutcome::Rejected(format!(
                "unknown control_response subtype {}",
                other.unwrap_or("<none>")
            )),
        };
        if waiter.send(outcome).is_err() {
            log::debug!("control_response for {request_id} arrived after its caller gave up");
        }
        Routed::Delivered
    }

    pub(crate) fn close(&self) {
        let mut waiters = self.lock_waiters();
        waiters.closed = true;
        waiters.by_id.clear();
    }

    #[cfg(test)]
    pub(crate) fn pending_ids(&self) -> Vec<String> {
        self.lock_waiters().by_id.keys().cloned().collect()
    }

    fn register(&self, subtype: &'static str) -> Result<PendingControl, ControlError> {
        let request_id = next_request_id(subtype);
        let (tx, rx) = mpsc::channel();
        let mut waiters = self.lock_waiters();
        if waiters.closed {
            return Err(ControlError::SessionEnded);
        }
        waiters.by_id.insert(request_id.clone(), tx);
        Ok(PendingControl {
            channel: self.clone(),
            request_id,
            subtype,
            rx,
        })
    }

    pub(crate) fn request<W: Write>(
        &self,
        stdin: &Mutex<W>,
        query: ControlQuery,
        timeout: Duration,
    ) -> Result<serde_json::Value, ControlError> {
        let pending = self.register(query.subtype())?;
        let payload = build_control_request(&pending.request_id, query);
        let written = match stdin.lock() {
            Ok(mut w) => writeln!(w, "{payload}").and_then(|()| w.flush()),
            Err(e) => Err(std::io::Error::other(format!("stdin lock poisoned: {e}"))),
        };
        if let Err(e) = written {
            pending.forget();
            return Err(ControlError::Write(e.to_string()));
        }
        pending.wait(timeout)
    }

    pub(crate) fn send_set_model<W: Write>(
        &self,
        locked_stdin: &mut W,
        model: &str,
    ) -> Result<PendingControl, ControlError> {
        self.send_session_change(locked_stdin, SUBTYPE_SET_MODEL, |id| {
            build_set_model_request(id, model)
        })
    }

    pub(crate) fn send_apply_effort<W: Write>(
        &self,
        locked_stdin: &mut W,
        level: &str,
    ) -> Result<PendingControl, ControlError> {
        self.send_session_change(locked_stdin, SUBTYPE_APPLY_FLAG_SETTINGS, |id| {
            build_apply_effort_request(id, level)
        })
    }

    fn send_session_change<W: Write>(
        &self,
        locked_stdin: &mut W,
        subtype: &'static str,
        build: impl FnOnce(&str) -> serde_json::Value,
    ) -> Result<PendingControl, ControlError> {
        let pending = self.register(subtype)?;
        let payload = build(&pending.request_id);
        if let Err(e) = writeln!(locked_stdin, "{payload}").and_then(|()| locked_stdin.flush()) {
            pending.forget();
            return Err(ControlError::Write(e.to_string()));
        }
        Ok(pending)
    }
}

pub(crate) struct PendingControl {
    channel: ControlChannel,
    request_id: String,
    subtype: &'static str,
    rx: mpsc::Receiver<ControlOutcome>,
}

impl PendingControl {
    fn forget(&self) {
        self.channel.lock_waiters().by_id.remove(&self.request_id);
    }

    pub(crate) fn wait(self, timeout: Duration) -> Result<serde_json::Value, ControlError> {
        match self.rx.recv_timeout(timeout) {
            Ok(ControlOutcome::Success(value)) => Ok(value),
            Ok(ControlOutcome::Rejected(e)) => Err(ControlError::Rejected(e)),
            Err(RecvTimeoutError::Timeout) => {
                self.forget();
                Err(ControlError::Timeout {
                    subtype: self.subtype,
                    timeout,
                })
            }
            Err(RecvTimeoutError::Disconnected) => Err(ControlError::SessionEnded),
        }
    }
}

#[derive(Clone)]
pub(crate) struct ControlHandle {
    channel: ControlChannel,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
}

impl ControlHandle {
    pub(crate) fn new(
        channel: ControlChannel,
        stdin: Arc<Mutex<std::process::ChildStdin>>,
    ) -> Self {
        Self { channel, stdin }
    }

    pub(crate) fn query(&self, query: ControlQuery) -> Result<serde_json::Value, ControlError> {
        self.channel.request(&self.stdin, query, query.timeout())
    }

    pub(crate) fn apply_effort(&self, level: &str) -> Result<(), ControlError> {
        self.apply_effort_within(level, APPLY_EFFORT_TIMEOUT)
    }

    pub(crate) fn apply_effort_within(
        &self,
        level: &str,
        timeout: Duration,
    ) -> Result<(), ControlError> {
        let pending = {
            let mut stdin = self
                .stdin
                .lock()
                .map_err(|e| ControlError::Write(format!("stdin lock poisoned: {e}")))?;
            self.channel.send_apply_effort(&mut *stdin, level)?
        };
        pending.wait(timeout).map(|_| ())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ModelRow {
    pub(crate) value: String,
    #[serde(default, rename(deserialize = "resolvedModel"))]
    pub(crate) resolved_model: Option<String>,
    #[serde(default, rename(deserialize = "displayName"))]
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) description: String,
    #[serde(default, rename(deserialize = "supportsEffort"))]
    pub(crate) supports_effort: bool,
    #[serde(default, rename(deserialize = "supportedEffortLevels"))]
    pub(crate) supported_effort_levels: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct AccountInfo {
    #[serde(default, rename(deserialize = "subscriptionType"))]
    pub(crate) subscription_type: Option<String>,
    #[serde(default, rename(deserialize = "apiProvider"))]
    pub(crate) api_provider: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct SessionInfo {
    pub(crate) models: Vec<ModelRow>,
    #[serde(default)]
    pub(crate) account: AccountInfo,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum SessionInfoState {
    #[default]
    Unavailable,
    Pending,
    Ready {
        info: SessionInfo,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct SessionInfoEvent {
    pub(crate) project: String,
    pub(crate) status: SessionInfoState,
}

pub(crate) fn session_info_state_from(
    outcome: Result<serde_json::Value, ControlError>,
) -> SessionInfoState {
    match outcome.and_then(|value| parse_session_info(&value)) {
        Ok(info) => SessionInfoState::Ready { info },
        Err(e) => {
            log::warn!("Claude Code session info unavailable, using the static catalog: {e}");
            SessionInfoState::Unavailable
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct RateWindow {
    #[serde(default)]
    pub(crate) utilization: Option<f64>,
    #[serde(default)]
    pub(crate) resets_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ModelScopedWindow {
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) utilization: Option<f64>,
    #[serde(default)]
    pub(crate) resets_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ExtraUsage {
    pub(crate) is_enabled: bool,
    #[serde(default)]
    pub(crate) monthly_limit: Option<f64>,
    #[serde(default)]
    pub(crate) used_credits: Option<f64>,
    #[serde(default)]
    pub(crate) utilization: Option<f64>,
    #[serde(default)]
    pub(crate) currency: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct RateLimits {
    #[serde(default)]
    pub(crate) five_hour: Option<RateWindow>,
    #[serde(default)]
    pub(crate) seven_day: Option<RateWindow>,
    #[serde(default)]
    pub(crate) seven_day_opus: Option<RateWindow>,
    #[serde(default)]
    pub(crate) seven_day_sonnet: Option<RateWindow>,
    #[serde(default)]
    pub(crate) model_scoped: Vec<ModelScopedWindow>,
    #[serde(default)]
    pub(crate) extra_usage: Option<ExtraUsage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct PlanUsage {
    #[serde(default)]
    pub(crate) subscription_type: Option<String>,
    pub(crate) rate_limits_available: bool,
    #[serde(default)]
    pub(crate) rate_limits: Option<RateLimits>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ContextCategory {
    pub(crate) name: String,
    pub(crate) tokens: u64,
    #[serde(default, rename(deserialize = "isDeferred"))]
    pub(crate) is_deferred: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ContextUsage {
    pub(crate) model: String,
    #[serde(rename(deserialize = "totalTokens"))]
    pub(crate) total_tokens: u64,
    #[serde(rename(deserialize = "maxTokens"))]
    pub(crate) max_tokens: u64,
    pub(crate) percentage: f64,
    #[serde(default)]
    pub(crate) categories: Vec<ContextCategory>,
}

const FREE_SPACE_CATEGORY: &str = "Free space";

impl ContextUsage {
    pub(crate) fn without_free_space(mut self) -> Self {
        self.categories.retain(|c| c.name != FREE_SPACE_CATEGORY);
        self
    }
}

fn parse_payload<T: serde::de::DeserializeOwned>(
    subtype: &'static str,
    value: &serde_json::Value,
) -> Result<T, ControlError> {
    T::deserialize(value).map_err(|e| ControlError::Malformed(format!("{subtype}: {e}")))
}

pub(crate) fn parse_session_info(value: &serde_json::Value) -> Result<SessionInfo, ControlError> {
    parse_payload(SUBTYPE_INITIALIZE, value)
}

pub(crate) fn parse_plan_usage(value: &serde_json::Value) -> Result<PlanUsage, ControlError> {
    parse_payload(SUBTYPE_GET_USAGE, value)
}

pub(crate) fn parse_context_usage(value: &serde_json::Value) -> Result<ContextUsage, ControlError> {
    parse_payload(SUBTYPE_GET_CONTEXT_USAGE, value)
}

#[cfg(test)]
pub(crate) const FIXTURE: &str =
    include_str!("../tests/fixtures/cc-2.1.267-control-responses.sanitized.json");

#[cfg(test)]
const APPLY_EFFORT_FIXTURE: &str =
    include_str!("../tests/fixtures/cc-2.1.267-apply-effort.sanitized.json");

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        serde_json::from_str(FIXTURE).expect("fixture is valid JSON")
    }

    fn success_line(request_id: &str, payload: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "type": MSG_TYPE_CONTROL_RESPONSE,
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": payload,
            }
        })
    }

    fn written_request(sink: &Mutex<Vec<u8>>) -> serde_json::Value {
        let bytes = sink.lock().unwrap().clone();
        let text = String::from_utf8(bytes).expect("utf8");
        let line = text.lines().next().expect("one request line");
        serde_json::from_str(line).expect("request is valid JSON")
    }

    fn request_in_background(
        channel: &ControlChannel,
        sink: &Arc<Mutex<Vec<u8>>>,
        query: ControlQuery,
    ) -> std::thread::JoinHandle<Result<serde_json::Value, ControlError>> {
        let channel = channel.clone();
        let sink = sink.clone();
        std::thread::spawn(move || channel.request(&sink, query, Duration::from_secs(10)))
    }

    fn wait_for_pending(channel: &ControlChannel, count: usize) -> Vec<String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let ids = channel.pending_ids();
            if ids.len() >= count {
                return ids;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "request never registered a waiter"
            );
            std::thread::yield_now();
        }
    }

    #[test]
    fn fixture_is_the_capture_of_the_pinned_claude_code() {
        assert_eq!(
            fixture()["claude_code_version"],
            speedwave_runtime::defaults::CLAUDE_VERSION,
            "re-capture the control-response fixture for the new Claude Code pin"
        );
    }

    #[test]
    fn build_control_request_matches_the_sdk_envelope() {
        let v = build_control_request("req_x_1", ControlQuery::Initialize);
        assert_eq!(v["type"], "control_request");
        assert_eq!(v["request_id"], "req_x_1");
        assert_eq!(v["request"], serde_json::json!({ "subtype": "initialize" }));
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["request", "request_id", "type"]);
    }

    #[test]
    fn usage_request_skips_the_transcript_scan() {
        let v = build_control_request("r", ControlQuery::Usage);
        assert_eq!(
            v["request"],
            serde_json::json!({ "subtype": "get_usage", "skip_behaviors": true })
        );
    }

    #[test]
    fn context_usage_request_asks_for_the_summary_detail() {
        let v = build_control_request("r", ControlQuery::ContextUsage);
        assert_eq!(
            v["request"],
            serde_json::json!({ "subtype": "get_context_usage", "detail": "summary" })
        );
    }

    #[test]
    fn request_ids_are_unique_and_carry_the_subtype() {
        let a = next_request_id(ControlQuery::Usage.subtype());
        let b = next_request_id(ControlQuery::Usage.subtype());
        assert_ne!(a, b);
        assert!(a.starts_with("req_get_usage_"));
        assert!(next_request_id(ControlQuery::Initialize.subtype()).starts_with("req_initialize_"));
    }

    #[test]
    fn every_query_has_a_positive_timeout() {
        for q in [
            ControlQuery::Initialize,
            ControlQuery::Usage,
            ControlQuery::ContextUsage,
        ] {
            assert!(q.timeout() > Duration::ZERO, "{q:?}");
        }
        assert!(SET_MODEL_TIMEOUT > Duration::ZERO);
        assert!(APPLY_EFFORT_TIMEOUT > Duration::ZERO);
    }

    #[test]
    fn matching_response_resolves_the_pending_request() {
        let channel = ControlChannel::default();
        let sink = Arc::new(Mutex::new(Vec::new()));
        let caller = request_in_background(&channel, &sink, ControlQuery::ContextUsage);
        let id = wait_for_pending(&channel, 1).remove(0);
        let routed = channel.route_response(&success_line(&id, serde_json::json!({ "ok": 1 })));
        assert_eq!(routed, Routed::Delivered);
        assert_eq!(
            caller.join().unwrap().unwrap(),
            serde_json::json!({ "ok": 1 })
        );
        assert!(channel.pending_ids().is_empty());

        let sent = written_request(&sink);
        assert_eq!(sent["request_id"], id.as_str());
        assert_eq!(sent["request"]["subtype"], "get_context_usage");
    }

    #[test]
    fn response_with_unknown_id_is_dropped_and_leaves_pending_requests_alone() {
        let channel = ControlChannel::default();
        let sink = Arc::new(Mutex::new(Vec::new()));
        let caller = request_in_background(&channel, &sink, ControlQuery::Usage);
        let id = wait_for_pending(&channel, 1).remove(0);

        let stranger = success_line("req_interrupt_7", serde_json::Value::Null);
        assert_eq!(channel.route_response(&stranger), Routed::Unmatched);
        assert_eq!(channel.pending_ids(), vec![id.clone()]);

        channel.route_response(&success_line(&id, serde_json::json!({})));
        assert!(caller.join().unwrap().is_ok());
    }

    #[test]
    fn response_without_request_id_is_malformed_and_dropped() {
        let channel = ControlChannel::default();
        let line = serde_json::json!({ "type": "control_response", "response": {} });
        assert_eq!(channel.route_response(&line), Routed::Malformed);
        let bare = serde_json::json!({ "type": "control_response" });
        assert_eq!(channel.route_response(&bare), Routed::Malformed);
    }

    #[test]
    fn unanswered_request_times_out_and_forgets_its_waiter() {
        let channel = ControlChannel::default();
        let sink = Mutex::new(Vec::new());
        let err = channel
            .request(&sink, ControlQuery::Usage, Duration::from_millis(30))
            .expect_err("no responder");
        assert_eq!(
            err,
            ControlError::Timeout {
                subtype: "get_usage",
                timeout: Duration::from_millis(30),
            }
        );
        assert!(channel.pending_ids().is_empty());

        let late = written_request(&sink);
        let late_id = late["request_id"].as_str().unwrap();
        assert_eq!(
            channel.route_response(&success_line(late_id, serde_json::json!({}))),
            Routed::Unmatched,
            "a late answer to a timed-out request must be dropped"
        );
    }

    #[test]
    fn error_response_rejects_the_request_with_claude_codes_text() {
        let channel = ControlChannel::default();
        let sink = Arc::new(Mutex::new(Vec::new()));
        let caller = request_in_background(&channel, &sink, ControlQuery::Usage);
        let id = wait_for_pending(&channel, 1).remove(0);
        let line = serde_json::json!({
            "type": "control_response",
            "response": { "subtype": "error", "request_id": id, "error": "Unsupported subtype" }
        });
        assert_eq!(channel.route_response(&line), Routed::Delivered);
        assert_eq!(
            caller.join().unwrap(),
            Err(ControlError::Rejected("Unsupported subtype".to_string()))
        );
    }

    #[test]
    fn response_with_unknown_subtype_rejects_instead_of_hanging() {
        let channel = ControlChannel::default();
        let sink = Arc::new(Mutex::new(Vec::new()));
        let caller = request_in_background(&channel, &sink, ControlQuery::Usage);
        let id = wait_for_pending(&channel, 1).remove(0);
        let line = serde_json::json!({
            "type": "control_response",
            "response": { "subtype": "partial", "request_id": id }
        });
        channel.route_response(&line);
        assert!(matches!(
            caller.join().unwrap(),
            Err(ControlError::Rejected(_))
        ));
    }

    #[test]
    fn closing_the_channel_ends_every_pending_request() {
        let channel = ControlChannel::default();
        let sink = Arc::new(Mutex::new(Vec::new()));
        let caller = request_in_background(&channel, &sink, ControlQuery::Initialize);
        wait_for_pending(&channel, 1);
        channel.close();
        assert_eq!(caller.join().unwrap(), Err(ControlError::SessionEnded));
    }

    #[test]
    fn a_query_on_a_closed_channel_fails_at_once_and_writes_nothing() {
        let channel = ControlChannel::default();
        channel.close();
        let sink = Mutex::new(Vec::new());
        let started = std::time::Instant::now();

        let err = channel
            .request(&sink, ControlQuery::Usage, Duration::from_secs(30))
            .expect_err("the session has ended");

        assert_eq!(err, ControlError::SessionEnded);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(sink.lock().unwrap().is_empty());
        assert!(channel.pending_ids().is_empty());
    }

    #[test]
    fn a_session_change_on_a_closed_channel_fails_at_once_and_writes_nothing() {
        let channel = ControlChannel::default();
        channel.close();
        let mut sink = Vec::new();

        let effort = channel.send_apply_effort(&mut sink, "low").err();
        let model = channel.send_set_model(&mut sink, "claude-haiku-4-5").err();

        assert_eq!(effort, Some(ControlError::SessionEnded));
        assert_eq!(model, Some(ControlError::SessionEnded));
        assert!(sink.is_empty());
        assert!(channel.pending_ids().is_empty());
    }

    #[test]
    fn a_clone_taken_before_the_close_is_closed_too() {
        let channel = ControlChannel::default();
        let held_by_a_handle = channel.clone();

        channel.close();

        assert_eq!(
            held_by_a_handle
                .send_apply_effort(&mut Vec::new(), "high")
                .err(),
            Some(ControlError::SessionEnded)
        );
    }

    fn apply_effort_capture() -> serde_json::Value {
        serde_json::from_str(APPLY_EFFORT_FIXTURE).expect("capture is valid JSON")
    }

    #[test]
    fn the_apply_effort_capture_is_of_the_pinned_claude_code() {
        assert_eq!(
            apply_effort_capture()["claude_code_version"],
            speedwave_runtime::defaults::CLAUDE_VERSION,
            "re-capture the apply_flag_settings contract for the new Claude Code pin"
        );
    }

    #[test]
    fn claude_code_takes_an_effort_change_from_the_next_model_request_and_writes_no_settings() {
        let capture = apply_effort_capture();

        assert_eq!(
            capture["applied"],
            serde_json::json!(["launch", "low", "max", "turbo"])
        );
        assert_eq!(
            capture["requests"],
            serde_json::json!(["high", "low", "max", "max"]),
            "each level must reach the next model request without a restart"
        );
        assert_eq!(capture["settings_json_unchanged"], true);
    }

    #[test]
    fn an_effort_change_stores_no_level_outside_the_pin() {
        let capture = apply_effort_capture();
        let added = capture["claude_json_added"]
            .as_object()
            .expect("the capture records what .claude.json gained");

        for (key, value) in added {
            assert!(
                key.starts_with("unpin") && key.ends_with("LaunchEffort"),
                "apply_flag_settings may record only launch-hold releases in .claude.json: {key}"
            );
            assert_eq!(
                value,
                &serde_json::Value::Bool(true),
                "a launch-hold release is a flag, never a level: {key}"
            );
        }
    }

    #[test]
    fn an_effort_change_sent_before_the_first_turn_reaches_its_first_model_request() {
        let capture = apply_effort_capture();
        let before = &capture["before_first_turn"];

        assert_eq!(before["response"]["response"]["subtype"], "success");
        assert_ne!(
            before["applied"], capture["requests"][0],
            "the recording must apply a level other than the launch level"
        );
        assert_eq!(before["requests"], serde_json::json!([before["applied"]]));
    }

    #[test]
    fn an_effort_input_written_during_a_tool_using_turn_never_runs() {
        let capture = apply_effort_capture();
        let mid_turn = &capture["effort_command_mid_tool_turn"];

        assert_eq!(
            mid_turn["result_num_turns"],
            serde_json::json!([2, 1]),
            "no answer of its own may follow the tool-using turn"
        );
        assert_eq!(
            mid_turn["requests"],
            serde_json::json!(["high", "high", "high"]),
            "the next turn must keep the launch level"
        );
    }

    #[test]
    fn claude_codes_answer_to_an_effort_change_resolves_the_pick() {
        let capture = apply_effort_capture();
        for level in ["low", "max"] {
            let channel = ControlChannel::default();
            let pending = channel
                .send_apply_effort(&mut Vec::new(), level)
                .expect("written");
            let id = channel.pending_ids().pop().expect("a waiter");
            let mut answer = capture["responses"][level].clone();
            answer["response"]["request_id"] = serde_json::Value::String(id);

            assert_eq!(channel.route_response(&answer), Routed::Delivered);
            assert!(pending.wait(Duration::from_secs(5)).is_ok(), "{level}");
        }
    }

    #[test]
    fn claude_code_answers_an_unknown_effort_level_with_success_and_keeps_the_level() {
        let capture = apply_effort_capture();

        assert_eq!(
            capture["responses"]["turbo"]["response"]["subtype"],
            "success"
        );
        assert_eq!(capture["requests"][3], capture["requests"][2]);
        assert!(crate::pin_cmd::validate_effort_level("turbo").is_err());
    }

    #[test]
    fn write_failure_is_reported_and_forgets_its_waiter() {
        struct FailWriter;
        impl Write for FailWriter {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "boom"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let channel = ControlChannel::default();
        let err = channel
            .request(
                &Mutex::new(FailWriter),
                ControlQuery::Usage,
                Duration::from_secs(5),
            )
            .expect_err("write must fail");
        assert!(
            matches!(&err, ControlError::Write(e) if e.contains("boom")),
            "{err}"
        );
        assert!(channel.pending_ids().is_empty());
    }

    #[test]
    fn set_model_request_matches_the_sdk_envelope() {
        let v = build_set_model_request("req_set_model_1", "openrouter/openai/gpt-4o-mini");
        assert_eq!(
            v,
            serde_json::json!({
                "type": "control_request",
                "request_id": "req_set_model_1",
                "request": { "subtype": "set_model", "model": "openrouter/openai/gpt-4o-mini" },
            })
        );
    }

    #[test]
    fn a_set_model_written_under_the_callers_lock_resolves_on_its_answer() {
        let channel = ControlChannel::default();
        let mut sink = Vec::new();

        let pending = channel
            .send_set_model(&mut sink, "local/llama-3.1-70b")
            .expect("written");

        let sent: serde_json::Value =
            serde_json::from_str(String::from_utf8(sink).unwrap().trim_end()).unwrap();
        assert_eq!(sent["request"]["model"], "local/llama-3.1-70b");
        let id = sent["request_id"].as_str().unwrap().to_string();
        assert!(id.starts_with("req_set_model_"), "{id}");
        assert_eq!(channel.pending_ids(), vec![id.clone()]);
        let answer = serde_json::json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": id },
        });
        assert_eq!(channel.route_response(&answer), Routed::Delivered);
        assert_eq!(
            pending.wait(Duration::from_secs(5)),
            Ok(serde_json::Value::Null)
        );
        assert!(channel.pending_ids().is_empty());
    }

    #[test]
    fn a_set_model_that_cannot_be_written_leaves_no_waiter() {
        struct FailWriter;
        impl Write for FailWriter {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "gone"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let channel = ControlChannel::default();

        let err = channel
            .send_set_model(&mut FailWriter, "local/llama-3.1-70b")
            .err()
            .expect("write must fail");

        assert!(
            matches!(&err, ControlError::Write(e) if e.contains("gone")),
            "{err}"
        );
        assert!(channel.pending_ids().is_empty());
    }

    #[test]
    fn an_unanswered_set_model_times_out_and_forgets_its_waiter() {
        let channel = ControlChannel::default();
        let pending = channel
            .send_set_model(&mut Vec::new(), "local/llama-3.1-70b")
            .expect("written");

        let err = pending
            .wait(Duration::from_millis(30))
            .expect_err("no answer");

        assert_eq!(
            err,
            ControlError::Timeout {
                subtype: "set_model",
                timeout: Duration::from_millis(30),
            }
        );
        assert!(channel.pending_ids().is_empty());
    }

    #[test]
    fn apply_effort_request_matches_the_sdk_envelope() {
        let v = build_apply_effort_request("req_apply_flag_settings_1", "xhigh");
        assert_eq!(
            v,
            serde_json::json!({
                "type": "control_request",
                "request_id": "req_apply_flag_settings_1",
                "request": {
                    "subtype": "apply_flag_settings",
                    "settings": { "effortLevel": "xhigh" },
                },
            })
        );
    }

    #[test]
    fn an_effort_change_written_under_the_callers_lock_resolves_on_its_answer() {
        let channel = ControlChannel::default();
        let mut sink = Vec::new();

        let pending = channel
            .send_apply_effort(&mut sink, "low")
            .expect("written");

        let text = String::from_utf8(sink).unwrap();
        assert_eq!(text.lines().count(), 1);
        let sent: serde_json::Value = serde_json::from_str(text.trim_end()).unwrap();
        assert_eq!(sent["request"]["settings"]["effortLevel"], "low");
        let id = sent["request_id"].as_str().unwrap().to_string();
        assert!(id.starts_with("req_apply_flag_settings_"), "{id}");
        assert_eq!(channel.pending_ids(), vec![id.clone()]);
        let answer = serde_json::json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": id },
        });
        assert_eq!(channel.route_response(&answer), Routed::Delivered);
        assert_eq!(
            pending.wait(Duration::from_secs(5)),
            Ok(serde_json::Value::Null)
        );
        assert!(channel.pending_ids().is_empty());
    }

    #[test]
    fn a_rejected_effort_change_carries_claude_codes_text() {
        let channel = ControlChannel::default();
        let pending = channel
            .send_apply_effort(&mut Vec::new(), "max")
            .expect("written");
        let id = channel.pending_ids().pop().expect("a waiter");
        let answer = serde_json::json!({
            "type": "control_response",
            "response": { "subtype": "error", "request_id": id, "error": "not allowed" },
        });

        assert_eq!(channel.route_response(&answer), Routed::Delivered);
        assert_eq!(
            pending.wait(Duration::from_secs(5)),
            Err(ControlError::Rejected("not allowed".to_string()))
        );
    }

    #[test]
    fn an_unanswered_effort_change_times_out_and_forgets_its_waiter() {
        let channel = ControlChannel::default();
        let pending = channel
            .send_apply_effort(&mut Vec::new(), "medium")
            .expect("written");

        let err = pending
            .wait(Duration::from_millis(30))
            .expect_err("no answer");

        assert_eq!(
            err,
            ControlError::Timeout {
                subtype: "apply_flag_settings",
                timeout: Duration::from_millis(30),
            }
        );
        assert!(channel.pending_ids().is_empty());
    }

    #[test]
    fn an_effort_change_that_cannot_be_written_leaves_no_waiter() {
        struct FailWriter;
        impl Write for FailWriter {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "gone"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let channel = ControlChannel::default();

        let err = channel
            .send_apply_effort(&mut FailWriter, "low")
            .err()
            .expect("write must fail");

        assert!(
            matches!(&err, ControlError::Write(e) if e.contains("gone")),
            "{err}"
        );
        assert!(channel.pending_ids().is_empty());
    }

    #[test]
    fn concurrent_requests_resolve_independently() {
        let channel = ControlChannel::default();
        let sink = Arc::new(Mutex::new(Vec::new()));
        let first = request_in_background(&channel, &sink, ControlQuery::Usage);
        let first_id = wait_for_pending(&channel, 1).remove(0);
        let second = request_in_background(&channel, &sink, ControlQuery::ContextUsage);
        let second_id = wait_for_pending(&channel, 2)
            .into_iter()
            .find(|id| *id != first_id)
            .unwrap();
        channel.route_response(&success_line(&second_id, serde_json::json!("second")));
        channel.route_response(&success_line(&first_id, serde_json::json!("first")));
        assert_eq!(first.join().unwrap().unwrap(), serde_json::json!("first"));
        assert_eq!(second.join().unwrap().unwrap(), serde_json::json!("second"));
    }

    #[test]
    fn initialize_fixture_parses_models_and_account() {
        let info = parse_session_info(&fixture()["run_A"]["initialize"]).unwrap();
        let values: Vec<&str> = info.models.iter().map(|m| m.value.as_str()).collect();
        assert_eq!(
            values,
            vec![
                "default",
                "opus[1m]",
                "claude-fable-5-1[1m]",
                "sonnet",
                "sonnet[1m]",
                "haiku"
            ]
        );
        let resolved: Vec<Option<&str>> = info
            .models
            .iter()
            .map(|m| m.resolved_model.as_deref())
            .collect();
        assert_eq!(
            resolved,
            vec![
                Some("claude-opus-5[1m]"),
                Some("claude-opus-5[1m]"),
                Some("claude-fable-5-1[1m]"),
                Some("claude-sonnet-5[1m]"),
                Some("claude-sonnet-5[1m]"),
                Some("claude-haiku-4-5"),
            ]
        );
        let default = &info.models[0];
        assert!(default.supports_effort);
        assert_eq!(
            default.supported_effort_levels,
            vec!["low", "medium", "high", "xhigh", "max"]
        );
        let haiku = info.models.last().unwrap();
        assert!(!haiku.supports_effort);
        assert!(haiku.supported_effort_levels.is_empty());
        assert_eq!(
            info.account.subscription_type.as_deref(),
            Some("Claude Max")
        );
        assert_eq!(info.account.api_provider.as_deref(), Some("firstParty"));
    }

    #[test]
    fn initialize_fixture_without_alias_pins_resolves_the_bare_ids() {
        let info = parse_session_info(&fixture()["run_B"]["initialize"]).unwrap();
        let by_value = |v: &str| {
            info.models
                .iter()
                .find(|m| m.value == v)
                .and_then(|m| m.resolved_model.clone())
        };
        assert_eq!(by_value("default").as_deref(), Some("claude-opus-5[1m]"));
        assert_eq!(by_value("sonnet").as_deref(), Some("claude-sonnet-5"));
        assert_eq!(
            by_value("haiku").as_deref(),
            Some("claude-haiku-4-5-20251001")
        );
    }

    #[test]
    fn initialize_without_models_is_not_understood() {
        let err = parse_session_info(&serde_json::json!({ "account": {} })).expect_err("no models");
        assert!(matches!(err, ControlError::Malformed(_)));
    }

    #[test]
    fn initialize_tolerates_a_missing_account_and_unknown_keys() {
        let info = parse_session_info(&serde_json::json!({
            "models": [{ "value": "default", "displayName": "Default", "description": "d", "futureFlag": 1 }],
            "commands": [],
            "pid": 7
        }))
        .unwrap();
        assert_eq!(info.account, AccountInfo::default());
        assert_eq!(info.models[0].resolved_model, None);
    }

    #[test]
    fn account_never_carries_identity_fields() {
        let info = parse_session_info(&serde_json::json!({
            "models": [],
            "account": { "email": "a@b.c", "organization": "Org", "subscriptionType": "Claude Pro" }
        }))
        .unwrap();
        let wire = serde_json::to_string(&info).unwrap();
        assert!(!wire.contains("a@b.c"), "{wire}");
        assert!(!wire.contains("Org"), "{wire}");
    }

    #[test]
    fn session_info_state_is_ready_for_a_parsed_initialize_response() {
        let state = session_info_state_from(Ok(fixture()["run_A"]["initialize"].clone()));
        let SessionInfoState::Ready { info } = state else {
            panic!("expected ready, got {state:?}");
        };
        assert_eq!(info.models.len(), 6);
    }

    #[test]
    fn session_info_state_is_unavailable_on_any_failure() {
        assert_eq!(
            session_info_state_from(Err(ControlError::SessionEnded)),
            SessionInfoState::Unavailable
        );
        assert_eq!(
            session_info_state_from(Ok(serde_json::json!({ "models": "nope" }))),
            SessionInfoState::Unavailable
        );
        assert_eq!(SessionInfoState::default(), SessionInfoState::Unavailable);
    }

    #[test]
    fn usage_fixture_parses_the_typed_windows() {
        for run in ["run_A", "run_B"] {
            let usage = parse_plan_usage(&fixture()[run]["get_usage"]).unwrap();
            assert_eq!(usage.subscription_type.as_deref(), Some("max"));
            assert!(usage.rate_limits_available);
            let limits = usage.rate_limits.expect("rate limits");
            let five = limits.five_hour.expect("five_hour");
            assert_eq!(five.utilization, Some(15.0));
            assert!(five.resets_at.unwrap().starts_with("2026-09-18T12:40:00"));
            assert_eq!(limits.seven_day.unwrap().utilization, Some(70.0));
            assert_eq!(limits.seven_day_opus, None);
            assert_eq!(limits.seven_day_sonnet, None);
            assert_eq!(limits.model_scoped.len(), 1);
            assert_eq!(limits.model_scoped[0].display_name, "Fable");
            assert_eq!(limits.model_scoped[0].utilization, Some(67.0));
            let extra = limits.extra_usage.expect("extra_usage");
            assert!(!extra.is_enabled);
            assert_eq!(extra.utilization, None);
        }
    }

    #[test]
    fn usage_ignores_undeclared_keys() {
        let raw = &fixture()["run_A"]["get_usage"];
        for undeclared in ["nimbus_quill", "limits", "spend", "seven_day_breakdown"] {
            assert!(
                !raw["rate_limits"][undeclared].is_null(),
                "the capture no longer carries the undeclared key {undeclared}"
            );
        }
        let wire = serde_json::to_value(parse_plan_usage(raw).unwrap()).unwrap();
        let mut top: Vec<&str> = wire
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        top.sort_unstable();
        assert_eq!(
            top,
            vec!["rate_limits", "rate_limits_available", "subscription_type"]
        );
        let mut windows: Vec<&str> = wire["rate_limits"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        windows.sort_unstable();
        assert_eq!(
            windows,
            vec![
                "extra_usage",
                "five_hour",
                "model_scoped",
                "seven_day",
                "seven_day_opus",
                "seven_day_sonnet"
            ]
        );
    }

    #[test]
    fn usage_with_null_rate_limits_parses_as_unavailable() {
        let usage = parse_plan_usage(&serde_json::json!({
            "subscription_type": null,
            "rate_limits_available": false,
            "rate_limits": null,
            "session": { "total_cost_usd": 0.0 },
            "brand_new_key": [1, 2, 3]
        }))
        .unwrap();
        assert_eq!(usage.subscription_type, None);
        assert!(!usage.rate_limits_available);
        assert_eq!(usage.rate_limits, None);
    }

    #[test]
    fn usage_window_tolerates_null_fields_and_extra_keys() {
        let usage = parse_plan_usage(&serde_json::json!({
            "subscription_type": "pro",
            "rate_limits_available": true,
            "rate_limits": {
                "five_hour": { "utilization": null, "resets_at": null, "locked_reason": "x" },
                "model_scoped": [{ "display_name": "Opus", "utilization": 3.5, "resets_at": null, "id": 9 }],
                "zebra_crossing": { "utilization": 1 }
            }
        }))
        .unwrap();
        let limits = usage.rate_limits.unwrap();
        assert_eq!(
            limits.five_hour,
            Some(RateWindow {
                utilization: None,
                resets_at: None
            })
        );
        assert_eq!(limits.seven_day, None);
        assert_eq!(limits.model_scoped[0].utilization, Some(3.5));
        assert_eq!(limits.extra_usage, None);
    }

    #[test]
    fn usage_with_a_wrong_typed_field_is_not_understood() {
        let err = parse_plan_usage(&serde_json::json!({
            "rate_limits_available": true,
            "rate_limits": { "five_hour": { "utilization": "15%" } }
        }))
        .expect_err("string utilization");
        assert!(matches!(err, ControlError::Malformed(_)));
        assert!(parse_plan_usage(&serde_json::json!({ "rate_limits": null })).is_err());
    }

    #[test]
    fn context_usage_fixture_parses_every_captured_model() {
        let fx = fixture();
        let mut seen = 0;
        for run in ["run_A", "run_B"] {
            for (key, value) in fx[run].as_object().unwrap() {
                if !key.starts_with("get_context_usage/") {
                    continue;
                }
                let usage =
                    parse_context_usage(value).unwrap_or_else(|e| panic!("{run} {key}: {e}"));
                assert!(usage.total_tokens > 0, "{run} {key}");
                assert!(usage.max_tokens >= usage.total_tokens, "{run} {key}");
                assert!(
                    usage.categories.iter().any(|c| c.name == "Free space"),
                    "{run} {key}"
                );
                seen += 1;
            }
        }
        assert!(seen >= 30, "captured context entries: {seen}");
    }

    #[test]
    fn pinned_binary_gives_bare_ids_200k_and_only_the_1m_suffix_one_million() {
        let fx = fixture();
        for run in ["run_A", "run_B"] {
            for (key, value) in fx[run].as_object().unwrap() {
                if !key.starts_with("get_context_usage/") {
                    continue;
                }
                let usage = parse_context_usage(value).unwrap();
                let expected = if usage.model.ends_with("[1m]") {
                    1_000_000
                } else {
                    200_000
                };
                assert_eq!(usage.max_tokens, expected, "{run} {key} -> {}", usage.model);
            }
        }
    }

    #[test]
    fn context_usage_for_display_drops_free_space_and_keeps_every_used_category() {
        let raw =
            parse_context_usage(&fixture()["run_A"]["get_context_usage/claude-opus-5"]).unwrap();
        let total = raw.total_tokens;
        let shown = raw.without_free_space();
        let names: Vec<&str> = shown.categories.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "System prompt",
                "System tools",
                "Custom agents",
                "Memory files",
                "Skills",
                "Autocompact buffer"
            ]
        );
        assert_eq!(shown.total_tokens, total);
        assert_eq!(shown.max_tokens, 200_000);
    }

    #[test]
    fn context_usage_reads_the_deferred_flag_of_a_category() {
        let usage = parse_context_usage(&serde_json::json!({
            "model": "m", "totalTokens": 10, "maxTokens": 100, "percentage": 10,
            "categories": [
                { "name": "System tools", "tokens": 10, "color": "inactive" },
                { "name": "MCP tools (deferred)", "tokens": 900, "color": "inactive", "isDeferred": true }
            ]
        }))
        .unwrap();
        assert!(!usage.categories[0].is_deferred);
        assert!(usage.categories[1].is_deferred);
    }

    #[test]
    fn context_usage_without_a_free_space_category_is_left_alone() {
        let usage = ContextUsage {
            model: "m".to_string(),
            total_tokens: 1,
            max_tokens: 2,
            percentage: 50.0,
            categories: vec![ContextCategory {
                name: "Messages".to_string(),
                tokens: 1,
                is_deferred: false,
            }],
        };
        assert_eq!(usage.clone().without_free_space(), usage);
    }

    #[test]
    fn context_usage_before_the_first_message_reports_the_baseline() {
        let usage = parse_context_usage(&fixture()["run_A"]["get_context_usage/initial"]).unwrap();
        assert_eq!(usage.model, "claude-fable-5-1[1m]");
        assert_eq!(usage.total_tokens, 46_567);
        assert_eq!(usage.max_tokens, 1_000_000);
        assert!((usage.percentage - 5.0).abs() < f64::EPSILON);
        assert_eq!(usage.categories[0].name, "System prompt");
        assert_eq!(usage.categories[0].tokens, 3_902);
    }

    #[test]
    fn context_usage_tolerates_unknown_keys_and_rejects_a_missing_window() {
        let ok = parse_context_usage(&serde_json::json!({
            "model": "m", "totalTokens": 1, "maxTokens": 2, "percentage": 50,
            "gridRows": [], "apiUsage": null, "somethingNew": true
        }))
        .unwrap();
        assert!(ok.categories.is_empty());
        let err = parse_context_usage(&serde_json::json!({
            "model": "m", "totalTokens": 1, "percentage": 50
        }))
        .expect_err("maxTokens missing");
        assert!(matches!(err, ControlError::Malformed(_)));
    }

    fn ts_interface_fields(src: &'static str, name: &str) -> Vec<&'static str> {
        let marker = format!("export interface {name} {{");
        let idx = src
            .find(&marker)
            .unwrap_or_else(|| panic!("claude-control.ts must declare `{marker}`"));
        let body = src[idx + marker.len()..]
            .split("\n}")
            .next()
            .expect("interface must be closed");
        let mut fields: Vec<&str> = body
            .lines()
            .filter_map(|l| l.split(':').next())
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.starts_with('/') && !s.starts_with('*'))
            .collect();
        fields.sort_unstable();
        fields
    }

    fn rust_fields<T: Serialize>(sample: &T) -> Vec<String> {
        let json = serde_json::to_value(sample).expect("sample serializes");
        let mut keys: Vec<String> = json
            .as_object()
            .expect("sample is an object")
            .keys()
            .cloned()
            .collect();
        keys.sort_unstable();
        keys
    }

    #[test]
    fn control_payloads_match_ts_mirrors() {
        let ts = include_str!("../../src/src/app/models/claude-control.ts");
        let info = parse_session_info(&fixture()["run_A"]["initialize"]).unwrap();
        let usage = parse_plan_usage(&fixture()["run_A"]["get_usage"]).unwrap();
        let limits = usage.rate_limits.clone().unwrap();
        let context =
            parse_context_usage(&fixture()["run_A"]["get_context_usage/initial"]).unwrap();

        assert_eq!(
            rust_fields(&info.models[0]),
            ts_interface_fields(ts, "ClaudeModelRow")
        );
        assert_eq!(
            rust_fields(&info.account),
            ts_interface_fields(ts, "ClaudeAccountInfo")
        );
        assert_eq!(
            rust_fields(&info),
            ts_interface_fields(ts, "ClaudeSessionInfo")
        );
        assert_eq!(
            rust_fields(&usage),
            ts_interface_fields(ts, "ClaudePlanUsage")
        );
        assert_eq!(
            rust_fields(&limits),
            ts_interface_fields(ts, "ClaudeRateLimits")
        );
        assert_eq!(
            rust_fields(limits.five_hour.as_ref().unwrap()),
            ts_interface_fields(ts, "ClaudeRateWindow")
        );
        assert_eq!(
            rust_fields(&limits.model_scoped[0]),
            ts_interface_fields(ts, "ClaudeModelScopedWindow")
        );
        assert_eq!(
            rust_fields(limits.extra_usage.as_ref().unwrap()),
            ts_interface_fields(ts, "ClaudeExtraUsage")
        );
        assert_eq!(
            rust_fields(&context),
            ts_interface_fields(ts, "ClaudeContextUsage")
        );
        assert_eq!(
            rust_fields(&context.categories[0]),
            ts_interface_fields(ts, "ClaudeContextCategory")
        );
        assert_eq!(
            rust_fields(&SessionInfoEvent {
                project: "p".to_string(),
                status: SessionInfoState::Pending,
            }),
            ts_interface_fields(ts, "ClaudeSessionInfoEvent")
        );
    }

    #[test]
    fn session_info_state_tags_match_ts_union() {
        let ts = include_str!("../../src/src/app/models/claude-control.ts");
        let info = parse_session_info(&fixture()["run_A"]["initialize"]).unwrap();
        for state in [
            SessionInfoState::Unavailable,
            SessionInfoState::Pending,
            SessionInfoState::Ready { info },
        ] {
            let json = serde_json::to_value(&state).unwrap();
            let tag = json["state"].as_str().unwrap();
            assert!(
                ts.contains(&format!("state: '{tag}'")),
                "ClaudeSessionInfoState must carry the '{tag}' state"
            );
        }
        assert_eq!(
            ts.matches("state: '").count(),
            3,
            "ClaudeSessionInfoState has a state the Rust enum lacks"
        );
        assert!(
            ts.contains(&format!("'{SESSION_INFO_EVENT}'")),
            "claude-control.ts must name the {SESSION_INFO_EVENT} event"
        );
    }
}
