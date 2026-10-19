//! In-process HTTP service exposing the PII NER detector to the proxy (ADR-096): binds the
//! host address, writes the `pii-ner` lock the compose renderer reads, answers `POST /v1/detect`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::Context;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use speedwave_pii_ner::{Detect, DetectOptions, DevicePreference, Span};
use speedwave_runtime::consts;
use speedwave_runtime::host_mcp_process::lock::{self, LockFile, LockService};
use tokio::sync::broadcast;

use crate::bridges::host_bridge::{
    bind_with_retry, constant_time_eq, load_or_create_persistent_token,
};
use crate::mirror_relay::RelayedPort;

const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_QUEUED_REQUESTS: usize = 32;
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(5);
const RETRY_AFTER_SECS: &str = "5";

/// Seam over the model so the handler and lifecycle are testable without weights.
trait SpanDetector: Send + Sync {
    fn detect_batch(&self, texts: &[&str]) -> Result<Vec<Vec<Span>>, String>;
    fn description(&self) -> String;
}

/// Where the model is in its lifetime; the endpoint answers 503 until `Ready`.
enum DetectorState {
    Loading,
    Ready(Arc<dyn SpanDetector>),
    Failed,
}

struct ServiceState {
    detector: RwLock<DetectorState>,
    token: String,
    inference: tokio::sync::Semaphore,
    queue: Arc<tokio::sync::Semaphore>,
}

impl ServiceState {
    fn new(detector: DetectorState, token: String) -> Arc<Self> {
        Arc::new(Self {
            detector: RwLock::new(detector),
            token,
            inference: tokio::sync::Semaphore::new(1),
            queue: Arc::new(tokio::sync::Semaphore::new(MAX_QUEUED_REQUESTS)),
        })
    }

    fn set(&self, state: DetectorState) {
        *self
            .detector
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = state;
    }

    fn ready(&self) -> Result<Arc<dyn SpanDetector>, &'static str> {
        match &*self
            .detector
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        {
            DetectorState::Ready(d) => Ok(Arc::clone(d)),
            DetectorState::Loading => Err("PII detector is still loading"),
            DetectorState::Failed => Err("PII detector failed to load"),
        }
    }
}

#[derive(serde::Deserialize)]
struct DetectRequest {
    texts: Vec<String>,
}

#[derive(serde::Serialize)]
struct DetectResponse {
    spans: Vec<Vec<Span>>,
}

/// Loader used in production: bundled artifact, GPU when the transcription probe saw one.
type Loader = Box<dyn FnOnce() -> Result<Arc<dyn SpanDetector>, String> + Send>;

/// Running service: listener thread, lock watchdog and the model loading in the background.
pub(crate) struct PiiNerService {
    port: u16,
    lock_path: PathBuf,
    shutdown_tx: Option<broadcast::Sender<()>>,
    watchdog_stop: Option<std::sync::mpsc::Sender<()>>,
    server_thread: Option<JoinHandle<()>>,
    watchdog_thread: Option<JoinHandle<()>>,
    relay: Option<Arc<RelayedPort>>,
    state: Arc<ServiceState>,
}

pub(crate) type SharedPiiNer = Arc<Mutex<Option<PiiNerService>>>;

static GLOBAL_PII_NER: OnceLock<SharedPiiNer> = OnceLock::new();

#[derive(Clone, Copy)]
enum Transition {
    StartIfWanted,
    StopUnlessWanted,
    Sync,
}

pub(crate) fn set_global_pii_ner(handle: SharedPiiNer) {
    let _ = GLOBAL_PII_NER.set(handle);
}

/// Starts the detector when the active project wants it; never stops it. Call before
/// rendering a compose so the proxy picks the live port up.
pub(crate) fn start_if_active_wants() {
    apply_for_active_project(Transition::StartIfWanted);
}

/// Stops the detector unless the active project wants it; never starts it. Call after a
/// switch, a Settings save and a beta toggle.
pub(crate) fn stop_unless_active_wants() {
    apply_for_active_project(Transition::StopUnlessWanted);
}

/// Starts or stops the detector to match the active project, outside a project switch.
pub(crate) fn sync_with_active_project() {
    apply_for_active_project(Transition::Sync);
}

/// Stops the detector regardless of the active project.
pub(crate) fn stop_service() {
    apply_to_global(false, Transition::StopUnlessWanted);
}

fn apply_for_active_project(transition: Transition) {
    let wanted = speedwave_runtime::config::load_user_config()
        .ok()
        .and_then(|cfg| {
            let project = cfg.active_project.clone()?;
            let has_llm =
                crate::containers_cmd::project_llm_is_unconfigured_in(&cfg, &project) == Ok(false);
            Some(has_llm && speedwave_runtime::pii_policy::pii_ner_enabled_for_project(&project))
        })
        .unwrap_or(false);
    apply_to_global(wanted, transition);
}

fn apply_to_global(wanted: bool, transition: Transition) {
    if let Some(shared) = GLOBAL_PII_NER.get() {
        apply_state(
            shared,
            consts::data_dir(),
            wanted,
            transition,
            production_loader,
        );
    }
}

fn apply_state(
    shared: &SharedPiiNer,
    data_dir: &Path,
    wanted: bool,
    transition: Transition,
    loader: fn() -> Loader,
) {
    let mut guard = match shared.lock() {
        Ok(guard) => guard,
        Err(e) => {
            log::warn!("pii-ner service state is poisoned, leaving the service untouched: {e}");
            return;
        }
    };
    match (transition, wanted, guard.is_some()) {
        (Transition::StartIfWanted | Transition::Sync, true, false) => {
            match PiiNerService::start(data_dir, loader()) {
                Ok(service) => {
                    log::info!(
                        "PII NER detector service listening on port {}",
                        service.port()
                    );
                    *guard = Some(service);
                }
                Err(e) => log::error!("PII NER detector service failed to start: {e}"),
            }
        }
        (Transition::StopUnlessWanted | Transition::Sync, false, true) => {
            *guard = None;
            log::info!("PII NER detector service stopped");
        }
        _ => {}
    }
}

impl PiiNerService {
    /// Binds, writes the lock, starts serving 503 and loads the model on a helper thread.
    fn start(data_dir: &Path, loader: Loader) -> anyhow::Result<Self> {
        crate::firewall::ensure_firewall_rule();
        let lock_path = data_dir.join(consts::PII_NER_LOCK_FILE);
        let preferred = lock::read(&lock_path, LockService::PiiNer).map(|l| l.port);
        let listener = match preferred {
            Some(port) => bind_with_retry("pii-ner", Some(port))
                .or_else(|_| bind_with_retry("pii-ner", None))?,
            None => bind_with_retry("pii-ner", None)?,
        };
        let port = listener.local_addr()?.port();
        let token =
            load_or_create_persistent_token(Some(&data_dir.join(consts::PII_NER_AUTH_TOKEN_FILE)))?;
        let state = ServiceState::new(DetectorState::Loading, token.clone());

        let (shutdown_tx, _) = broadcast::channel(1);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let router = build_router(Arc::clone(&state), MAX_BODY_BYTES);
        let mut server_shutdown = shutdown_tx.subscribe();
        let server_thread = std::thread::Builder::new()
            .name("pii_ner::serve".into())
            .spawn(move || {
                let rt = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("tokio runtime: {e}")));
                        return;
                    }
                };
                rt.block_on(async move {
                    listener.set_nonblocking(true).ok();
                    let listener = match tokio::net::TcpListener::from_std(listener) {
                        Ok(l) => l,
                        Err(e) => {
                            let _ = ready_tx.send(Err(format!("TcpListener::from_std: {e}")));
                            return;
                        }
                    };
                    let _ = ready_tx.send(Ok(()));
                    let serve = axum::serve(listener, router).with_graceful_shutdown(async move {
                        let _ = server_shutdown.recv().await;
                    });
                    if let Err(e) = serve.await {
                        log::error!("PII NER detector server stopped with an error: {e}");
                    }
                });
            })?;
        match ready_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => anyhow::bail!("PII NER detector server failed to start: {e}"),
            Err(e) => anyhow::bail!("PII NER detector server ready signal timed out: {e}"),
        }

        let relay = Arc::new(RelayedPort::new(port));
        let lock = LockFile::new(LockService::PiiNer, std::process::id(), port, token);
        if let Err(e) = lock::write(&lock_path, &lock) {
            let _ = shutdown_tx.send(());
            let _ = server_thread.join();
            return Err(e).context("writing the pii-ner lock; service rolled back");
        }

        let watchdog_lock_path = lock_path.clone();
        let watchdog_relay = Arc::clone(&relay);
        let (watchdog_stop, watchdog_rx) = std::sync::mpsc::channel::<()>();
        let watchdog_thread = std::thread::Builder::new()
            .name("pii_ner::watchdog".into())
            .spawn(move || {
                let mut ticks: u32 = 0;
                loop {
                    if !matches!(
                        watchdog_rx.recv_timeout(WATCHDOG_INTERVAL),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                    ) {
                        break;
                    }
                    ticks = ticks.wrapping_add(1);
                    if !watchdog_lock_path.exists() {
                        if let Err(e) = lock::write(&watchdog_lock_path, &lock) {
                            log::warn!("pii-ner watchdog failed to re-create the lock file: {e}");
                        }
                    }
                    if ticks.is_multiple_of(6) {
                        watchdog_relay.ensure_relay();
                    }
                }
            })?;

        let loader_state = Arc::clone(&state);
        std::thread::Builder::new()
            .name("pii_ner::load".into())
            .spawn(move || {
                let started = std::time::Instant::now();
                match loader() {
                    Ok(detector) => {
                        log::info!(
                            "PII NER detector ready: {} ({} ms)",
                            detector.description(),
                            started.elapsed().as_millis()
                        );
                        loader_state.set(DetectorState::Ready(detector));
                    }
                    Err(e) => {
                        log::error!("PII NER detector failed to load: {e}");
                        loader_state.set(DetectorState::Failed);
                    }
                }
            })?;

        Ok(Self {
            port,
            lock_path,
            shutdown_tx: Some(shutdown_tx),
            watchdog_stop: Some(watchdog_stop),
            server_thread: Some(server_thread),
            watchdog_thread: Some(watchdog_thread),
            relay: Some(relay),
            state,
        })
    }

    fn port(&self) -> u16 {
        self.port
    }

    #[cfg(test)]
    fn state(&self) -> Arc<ServiceState> {
        Arc::clone(&self.state)
    }

    /// Stops serving, tears the relay down and removes the lock; idempotent.
    pub(crate) fn stop(&mut self) -> anyhow::Result<()> {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        drop(self.watchdog_stop.take());
        self.state.inference.close();
        if let Some(h) = self.server_thread.take() {
            let _ = h.join();
        }
        if let Some(h) = self.watchdog_thread.take() {
            let _ = h.join();
        }
        drop(self.relay.take());
        match std::fs::remove_file(&self.lock_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).context("removing the pii-ner lock file"),
        }
        Ok(())
    }
}

impl Drop for PiiNerService {
    fn drop(&mut self) {
        if let Err(e) = self.stop() {
            log::warn!("pii-ner service stop on drop failed: {e}");
        }
    }
}

fn production_loader() -> Loader {
    Box::new(|| {
        let dir = speedwave_runtime::build::resolve_pii_ner_artifact_dir()
            .ok_or_else(|| "PII NER artifact directory not found".to_string())?;
        let preference = match speedwave_runtime::transcription::accel::gpu_class() {
            speedwave_runtime::transcription::accel::GpuClass::None => DevicePreference::Cpu,
            _ => DevicePreference::Auto,
        };
        let detector = speedwave_pii_ner::load_auto(&dir, preference).map_err(|e| e.to_string())?;
        Ok(Arc::new(ModelDetector(detector)) as Arc<dyn SpanDetector>)
    })
}

struct ModelDetector(Box<dyn Detect>);

impl SpanDetector for ModelDetector {
    fn detect_batch(&self, texts: &[&str]) -> Result<Vec<Vec<Span>>, String> {
        self.0
            .detect_batch(texts, &DetectOptions::default())
            .map_err(|e| e.to_string())
    }

    fn description(&self) -> String {
        format!("{} on {:?}", self.0.description(), self.0.device())
    }
}

fn build_router(state: Arc<ServiceState>, max_body: usize) -> Router {
    Router::new()
        .route(
            "/health",
            get(|| async { ([("content-type", "application/json")], r#"{"status":"ok"}"#) }),
        )
        .route("/v1/detect", post(detect))
        .layer(DefaultBodyLimit::max(max_body))
        .with_state(state)
}

async fn detect(
    State(state): State<Arc<ServiceState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let presented = headers
        .get(consts::PII_NER_AUTH_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !constant_time_eq(presented, &state.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let request: DetectRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "body must be {\"texts\": [..]}" })),
            )
                .into_response();
        }
    };
    let detector = match state.ready() {
        Ok(d) => d,
        Err(reason) => return unavailable(reason),
    };
    let Ok(_queued) = Arc::clone(&state.queue).try_acquire_owned() else {
        return unavailable("PII detector queue is full");
    };
    let _turn = match state.inference.acquire().await {
        Ok(permit) => permit,
        Err(_) => return unavailable("PII detector is shutting down"),
    };
    let result = tokio::task::spawn_blocking(move || {
        let refs: Vec<&str> = request.texts.iter().map(String::as_str).collect();
        detector.detect_batch(&refs)
    })
    .await;
    let failure = match result {
        Ok(Ok(spans)) => return Json(DetectResponse { spans }).into_response(),
        Ok(Err(e)) => format!("inference failed: {e}"),
        Err(e) => format!("task panicked: {e}"),
    };
    log::error!("PII detector {failure}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": "detection failed" })),
    )
        .into_response()
}

fn unavailable(reason: &str) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(axum::http::header::RETRY_AFTER, RETRY_AFTER_SECS)],
        Json(serde_json::json!({ "error": reason })),
    )
        .into_response()
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::*;
    use crate::mirror_relay::recorder::{calls_for_port, RelayOp};
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use speedwave_pii_ner::Label;
    use tower::ServiceExt;

    struct FakeDetector;

    impl SpanDetector for FakeDetector {
        fn detect_batch(&self, texts: &[&str]) -> Result<Vec<Vec<Span>>, String> {
            Ok(texts
                .iter()
                .map(|t| {
                    t.find("Kowalski")
                        .map(|start| {
                            vec![Span {
                                start,
                                end: start + "Kowalski".len(),
                                label: Label::Surname,
                                confidence: 0.99,
                            }]
                        })
                        .unwrap_or_default()
                })
                .collect())
        }

        fn description(&self) -> String {
            "fake".into()
        }
    }

    fn ready_state() -> Arc<ServiceState> {
        ServiceState::new(DetectorState::Ready(Arc::new(FakeDetector)), "tok".into())
    }

    async fn call(
        state: Arc<ServiceState>,
        max_body: usize,
        token: Option<&str>,
        body: &str,
    ) -> (StatusCode, HeaderMap, serde_json::Value) {
        let mut req = Request::builder()
            .method("POST")
            .uri("/v1/detect")
            .header("content-type", "application/json");
        if let Some(t) = token {
            req = req.header(consts::PII_NER_AUTH_HEADER, t);
        }
        let resp = build_router(state, max_body)
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, headers, json)
    }

    #[tokio::test]
    async fn ready_detector_answers_one_span_list_per_text() {
        let (status, _, json) = call(
            ready_state(),
            MAX_BODY_BYTES,
            Some("tok"),
            r#"{"texts":["Jan Kowalski","nic"]}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["spans"].as_array().unwrap().len(), 2);
        assert_eq!(json["spans"][0][0]["start"], 4);
        assert_eq!(json["spans"][0][0]["end"], 12);
        assert_eq!(json["spans"][0][0]["label"], "SURNAME");
        assert!(json["spans"][1].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn wrong_or_missing_token_is_unauthorized() {
        for token in [None, Some(""), Some("other")] {
            let (status, _, _) =
                call(ready_state(), MAX_BODY_BYTES, token, r#"{"texts":["x"]}"#).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{token:?}");
        }
    }

    #[tokio::test]
    async fn malformed_body_is_bad_request_and_oversized_is_too_large() {
        let (status, _, _) = call(ready_state(), MAX_BODY_BYTES, Some("tok"), "{}").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _, _) = call(ready_state(), MAX_BODY_BYTES, Some("tok"), "nope").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _, _) = call(
            ready_state(),
            16,
            Some("tok"),
            r#"{"texts":["too long body"]}"#,
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn loading_and_failed_detectors_answer_503_with_retry_after() {
        for state in [DetectorState::Loading, DetectorState::Failed] {
            let state = ServiceState::new(state, "tok".into());
            let (status, headers, _) =
                call(state, MAX_BODY_BYTES, Some("tok"), r#"{"texts":["x"]}"#).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(
                headers.get(axum::http::header::RETRY_AFTER).unwrap(),
                RETRY_AFTER_SECS
            );
        }
    }

    #[tokio::test]
    async fn health_reports_only_status() {
        let resp = build_router(ready_state(), MAX_BODY_BYTES)
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], br#"{"status":"ok"}"#);
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn start_writes_lock_and_token_then_stop_removes_the_lock() {
        let tmp = tempfile::tempdir().unwrap();
        let mut service = PiiNerService::start(
            tmp.path(),
            Box::new(|| Ok(Arc::new(FakeDetector) as Arc<dyn SpanDetector>)),
        )
        .unwrap();
        let lock_path = tmp.path().join(consts::PII_NER_LOCK_FILE);
        let lock = lock::read(&lock_path, LockService::PiiNer).unwrap();
        assert_eq!(lock.port, service.port());
        assert_eq!(lock.pid, std::process::id());
        let token =
            std::fs::read_to_string(tmp.path().join(consts::PII_NER_AUTH_TOKEN_FILE)).unwrap();
        assert_eq!(lock.auth_token, token.trim());
        assert!(uuid::Uuid::parse_str(token.trim()).is_ok());
        assert!(speedwave_runtime::compose::live_pii_ner_service_in(tmp.path()).is_some());
        let port = service.port();
        assert_eq!(
            calls_for_port(port).last(),
            Some(&RelayOp::Ensure),
            "a started service ensures its relay"
        );

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while service.state().ready().is_err() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            service.state().ready().is_ok(),
            "loader result must be published"
        );

        service.stop().unwrap();
        assert!(!lock_path.exists());
        assert!(tmp.path().join(consts::PII_NER_AUTH_TOKEN_FILE).exists());
        let after_stop = calls_for_port(port);
        assert_eq!(
            after_stop.last(),
            Some(&RelayOp::Remove),
            "stop tears the relay down"
        );
        service.stop().unwrap();
        assert_eq!(
            calls_for_port(port),
            after_stop,
            "a second stop touches no relay"
        );
    }

    fn fake_loader() -> Loader {
        Box::new(|| Ok(Arc::new(FakeDetector) as Arc<dyn SpanDetector>))
    }

    fn running_port(shared: &SharedPiiNer) -> Option<u16> {
        shared.lock().unwrap().as_ref().map(PiiNerService::port)
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn start_if_wanted_starts_once_and_never_stops() {
        let tmp = tempfile::tempdir().unwrap();
        let shared = SharedPiiNer::default();
        let lock_path = tmp.path().join(consts::PII_NER_LOCK_FILE);

        apply_state(
            &shared,
            tmp.path(),
            false,
            Transition::StartIfWanted,
            fake_loader,
        );
        assert!(running_port(&shared).is_none());
        assert!(!lock_path.exists());

        apply_state(
            &shared,
            tmp.path(),
            true,
            Transition::StartIfWanted,
            fake_loader,
        );
        let port = running_port(&shared).unwrap();
        assert!(lock_path.exists());

        apply_state(
            &shared,
            tmp.path(),
            true,
            Transition::StartIfWanted,
            fake_loader,
        );
        assert_eq!(running_port(&shared), Some(port));

        apply_state(
            &shared,
            tmp.path(),
            false,
            Transition::StartIfWanted,
            fake_loader,
        );
        assert_eq!(running_port(&shared), Some(port));
        assert!(lock_path.exists());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn stop_unless_wanted_stops_when_unwanted_and_never_starts() {
        let tmp = tempfile::tempdir().unwrap();
        let shared = SharedPiiNer::default();
        let lock_path = tmp.path().join(consts::PII_NER_LOCK_FILE);

        apply_state(
            &shared,
            tmp.path(),
            true,
            Transition::StopUnlessWanted,
            fake_loader,
        );
        assert!(running_port(&shared).is_none());
        assert!(!lock_path.exists());

        apply_state(
            &shared,
            tmp.path(),
            true,
            Transition::StartIfWanted,
            fake_loader,
        );
        let port = running_port(&shared).unwrap();
        let token_path = tmp.path().join(consts::PII_NER_AUTH_TOKEN_FILE);
        let token = std::fs::read_to_string(&token_path).unwrap();
        apply_state(
            &shared,
            tmp.path(),
            true,
            Transition::StopUnlessWanted,
            fake_loader,
        );
        assert_eq!(running_port(&shared), Some(port));

        apply_state(
            &shared,
            tmp.path(),
            false,
            Transition::StopUnlessWanted,
            fake_loader,
        );
        assert!(running_port(&shared).is_none());
        assert!(!lock_path.exists());
        assert_eq!(calls_for_port(port).last(), Some(&RelayOp::Remove));
        assert_eq!(std::fs::read_to_string(&token_path).unwrap(), token);
        apply_state(
            &shared,
            tmp.path(),
            false,
            Transition::StopUnlessWanted,
            fake_loader,
        );
        assert!(running_port(&shared).is_none());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn sync_starts_when_wanted_and_stops_when_not() {
        let tmp = tempfile::tempdir().unwrap();
        let shared = SharedPiiNer::default();
        let lock_path = tmp.path().join(consts::PII_NER_LOCK_FILE);

        apply_state(&shared, tmp.path(), false, Transition::Sync, fake_loader);
        assert!(running_port(&shared).is_none());

        apply_state(&shared, tmp.path(), true, Transition::Sync, fake_loader);
        let port = running_port(&shared).unwrap();
        apply_state(&shared, tmp.path(), true, Transition::Sync, fake_loader);
        assert_eq!(running_port(&shared), Some(port));

        apply_state(&shared, tmp.path(), false, Transition::Sync, fake_loader);
        assert!(running_port(&shared).is_none());
        assert!(!lock_path.exists());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn a_failed_switch_to_a_detector_off_project_keeps_the_port_the_previous_proxy_uses() {
        let tmp = tempfile::tempdir().unwrap();
        let shared = SharedPiiNer::default();
        let lock_path = tmp.path().join(consts::PII_NER_LOCK_FILE);

        apply_state(
            &shared,
            tmp.path(),
            true,
            Transition::StartIfWanted,
            fake_loader,
        );
        let port = running_port(&shared).unwrap();
        let lock_before = std::fs::read_to_string(&lock_path).unwrap();

        apply_state(
            &shared,
            tmp.path(),
            false,
            Transition::StartIfWanted,
            fake_loader,
        );
        assert_eq!(running_port(&shared), Some(port));
        assert_eq!(std::fs::read_to_string(&lock_path).unwrap(), lock_before);
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn a_successful_switch_to_a_detector_off_project_stops_the_service_and_a_later_start_reuses_the_token(
    ) {
        let tmp = tempfile::tempdir().unwrap();
        let shared = SharedPiiNer::default();
        let lock_path = tmp.path().join(consts::PII_NER_LOCK_FILE);
        let token_path = tmp.path().join(consts::PII_NER_AUTH_TOKEN_FILE);

        apply_state(
            &shared,
            tmp.path(),
            true,
            Transition::StartIfWanted,
            fake_loader,
        );
        let first_token = std::fs::read_to_string(&token_path).unwrap();

        apply_state(
            &shared,
            tmp.path(),
            false,
            Transition::StartIfWanted,
            fake_loader,
        );
        apply_state(
            &shared,
            tmp.path(),
            false,
            Transition::StopUnlessWanted,
            fake_loader,
        );
        assert!(running_port(&shared).is_none());
        assert!(!lock_path.exists());

        apply_state(
            &shared,
            tmp.path(),
            true,
            Transition::StartIfWanted,
            fake_loader,
        );
        assert!(lock_path.exists());
        assert_eq!(std::fs::read_to_string(&token_path).unwrap(), first_token);
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn restart_reuses_the_persistent_token_and_the_port_of_a_stale_lock() {
        let tmp = tempfile::tempdir().unwrap();
        let loader = || -> Loader { Box::new(|| Err("no model in this test".to_string())) };
        let first = PiiNerService::start(tmp.path(), loader()).unwrap();
        let lock_path = tmp.path().join(consts::PII_NER_LOCK_FILE);
        let (port, token) = {
            let lock = lock::read(&lock_path, LockService::PiiNer).unwrap();
            (lock.port, lock.auth_token)
        };
        drop(first);
        assert!(!lock_path.exists());
        let stale = LockFile::new(LockService::PiiNer, std::process::id(), port, token.clone());
        lock::write(&lock_path, &stale).unwrap();

        let second = PiiNerService::start(tmp.path(), loader()).unwrap();
        let lock = lock::read(
            &tmp.path().join(consts::PII_NER_LOCK_FILE),
            LockService::PiiNer,
        )
        .unwrap();
        assert_eq!(lock.auth_token, token);
        assert_eq!(second.port(), port);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while matches!(
            *second.state().detector.read().unwrap(),
            DetectorState::Loading
        ) && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            second.state().ready().map(|_| ()).unwrap_err(),
            "PII detector failed to load"
        );
    }

    #[test]
    fn default_ner_labels_are_model_labels() {
        for label in speedwave_runtime::compose::DEFAULT_NER_LABELS {
            assert!(label.parse::<Label>().is_ok(), "{label}");
        }
    }
}
