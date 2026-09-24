//! Client of the host-side PII NER detector (ADR-091): one POST per request carrying every
//! scanned string leaf, byte-offset spans back. Any failure degrades to `Unavailable`.

use std::collections::hash_map::RandomState;
use std::collections::{HashMap, HashSet};
use std::hash::BuildHasher;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use speedwave_pii_engine::ExternalSpan;

/// Header carrying the detector secret; mirror of `consts::PII_NER_AUTH_HEADER` (cross-read
/// test in `crates/speedwave-runtime/src/consts.rs`).
pub const NER_AUTH_HEADER: &str = "x-speedwave-pii-ner-auth";

/// The only host a rendered `ner.url` may name; mirror of `consts::HOST_GATEWAY_ALIAS`.
const HOST_GATEWAY_ALIAS: &str = "host.docker.internal";

/// Detector endpoint path appended to the configured base URL.
const DETECT_PATH: &str = "/v1/detect";

/// Largest total text volume sent to the detector; bigger requests skip NER (regex still runs).
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

/// Generous by local-hop standards: a burst of parallel sessions opens several connections to
/// the host gateway at once and a 500 ms budget lost that race, which silently degraded a
/// request to rules only. A dead detector still refuses instantly.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const WARN_INTERVAL: Duration = Duration::from_secs(60);

/// Detected span lists kept per generation; two generations bound the cache.
const CACHE_GENERATION_ENTRIES: usize = 2048;

fn default_min_confidence() -> f32 {
    0.6
}

/// A first turn carrying a full context window is seconds of inference; cutting it off means
/// forwarding that turn with rules only, so the client waits rather than leaks. Repeat turns
/// hit the cache and never come near this.
fn default_timeout_ms() -> u64 {
    15000
}

/// The `ner` object of `proxy.json`; rendered by `compose/pii_ner.rs::NerRenderConfig`.
#[derive(Deserialize, Clone)]
pub struct NerConfig {
    pub url: String,
    pub token: String,
    #[serde(default = "default_min_confidence")]
    pub min_confidence: f32,
    /// Labels to seal; an empty list accepts every label the detector reports.
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

impl std::fmt::Debug for NerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NerConfig")
            .field("url", &self.url)
            .field("token", &"[redacted]")
            .field("min_confidence", &self.min_confidence)
            .field("labels", &self.labels)
            .field("timeout_ms", &self.timeout_ms)
            .finish()
    }
}

/// Result of one detector round trip.
#[derive(Debug, PartialEq)]
pub enum NerOutcome {
    /// One span list per input text, already filtered by label and confidence.
    Spans(Vec<Vec<ExternalSpan>>),
    /// The detector did not answer usably; the reason never carries request text.
    Unavailable(String),
}

#[derive(Serialize)]
struct DetectRequest<'a> {
    texts: &'a [String],
}

#[derive(Deserialize)]
struct DetectResponse {
    spans: Vec<Vec<WireSpan>>,
}

#[derive(Deserialize)]
struct WireSpan {
    start: usize,
    end: usize,
    label: String,
    confidence: f32,
}

/// Identifies a text without keeping it: its length plus two independently seeded hashes.
type CacheKey = (usize, u64, u64);

/// Spans already detected for a text, so a retried or continued conversation pays for new
/// leaves only. The cache holds offsets, never request text, and is keyed by a hash seeded
/// per process, so the key of a leaf cannot be computed outside the running proxy.
///
/// Two generations bound it: when the young one fills, it displaces the old one and starts
/// over. A leaf that keeps being sent (the system prompt) is promoted back on every hit and
/// survives; a burst of one-off leaves ages out without unbounded growth.
struct SpanCache {
    seed_a: RandomState,
    seed_b: RandomState,
    generations: Mutex<Generations>,
}

#[derive(Default)]
struct Generations {
    young: HashMap<CacheKey, Vec<ExternalSpan>>,
    old: HashMap<CacheKey, Vec<ExternalSpan>>,
}

impl SpanCache {
    fn new() -> Self {
        Self {
            seed_a: RandomState::new(),
            seed_b: RandomState::new(),
            generations: Mutex::new(Generations::default()),
        }
    }

    fn key(&self, text: &str) -> CacheKey {
        (
            text.len(),
            self.seed_a.hash_one(text),
            self.seed_b.hash_one(text),
        )
    }

    fn get(&self, key: &CacheKey) -> Option<Vec<ExternalSpan>> {
        let mut generations = self
            .generations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(spans) = generations.young.get(key) {
            return Some(spans.clone());
        }
        let spans = generations.old.get(key).cloned()?;
        generations.young.insert(*key, spans.clone());
        Some(spans)
    }

    fn put(&self, key: CacheKey, spans: Vec<ExternalSpan>) {
        let mut generations = self
            .generations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if generations.young.len() >= CACHE_GENERATION_ENTRIES {
            generations.old = std::mem::take(&mut generations.young);
        }
        generations.young.insert(key, spans);
    }
}

/// A detector round trip that did not produce spans.
enum PostError {
    /// Nothing came back: connection refused, reset, connect timeout, read timeout.
    Transport(reqwest::Error),
    /// The detector answered, but not with a usable body.
    Rejected(String),
}

/// Ready-to-call detector client; built once at startup from the `ner` section.
pub struct NerClient {
    endpoint: String,
    token: String,
    min_confidence: f32,
    labels: HashSet<String>,
    client: reqwest::Client,
    last_warn: Mutex<Option<Instant>>,
    cache: SpanCache,
    /// One detector call at a time: the host serialises inference anyway, so a queued caller
    /// costs nothing extra and usually finds its leaves cached by the call ahead of it.
    gate: tokio::sync::Semaphore,
}

impl std::fmt::Debug for NerClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NerClient")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

/// Accepts only `http://host.docker.internal:<port>` with nothing else.
pub fn validate_base_url(raw: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(raw).map_err(|e| format!("not a URL: {e}"))?;
    if url.scheme() != "http" {
        return Err(format!("scheme must be http, got {}", url.scheme()));
    }
    if url.host_str() != Some(HOST_GATEWAY_ALIAS) {
        return Err(format!("host must be {HOST_GATEWAY_ALIAS}"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("userinfo is not allowed".to_string());
    }
    if !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
        return Err("path, query and fragment are not allowed".to_string());
    }
    if url.port().is_none() {
        return Err("an explicit port is required".to_string());
    }
    Ok(())
}

fn build_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .build()
        .map_err(|e| format!("building the detector client: {e}"))
}

/// The error and every cause below it, so a connection refusal, a reset or a connect
/// timeout is named in the log instead of the generic "error sending request".
fn error_chain(error: &reqwest::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        parts.push(cause.to_string());
        source = cause.source();
    }
    parts.join(": ")
}

/// The span lists once every slot is filled, else `None`.
fn all_resolved(resolved: &[Option<Vec<ExternalSpan>>]) -> Option<Vec<Vec<ExternalSpan>>> {
    resolved.iter().cloned().collect()
}

impl NerClient {
    /// Validates the URL shape and builds the client; an error is a fatal config error.
    pub fn from_config(cfg: NerConfig) -> Result<Self, String> {
        validate_base_url(&cfg.url)?;
        if cfg.token.is_empty() {
            return Err("token must not be empty".to_string());
        }
        Self::build(cfg)
    }

    #[cfg(test)]
    pub fn for_test(cfg: NerConfig) -> Self {
        Self::build(cfg).unwrap_or_else(|e| panic!("test client: {e}"))
    }

    fn build(cfg: NerConfig) -> Result<Self, String> {
        let client = build_client(Duration::from_millis(cfg.timeout_ms.max(1)))?;
        Ok(Self {
            endpoint: format!("{}{DETECT_PATH}", cfg.url.trim_end_matches('/')),
            token: cfg.token,
            min_confidence: cfg.min_confidence,
            labels: cfg.labels.into_iter().collect(),
            client,
            last_warn: Mutex::new(None),
            cache: SpanCache::new(),
            gate: tokio::sync::Semaphore::new(1),
        })
    }

    /// Detects spans for every text; the result has exactly one list per input text, in the
    /// same order, or is `Unavailable`. Blank texts and texts detected before never reach the
    /// detector, so a retried request and a continued conversation pay for new leaves only.
    pub async fn detect_batch(&self, texts: &[String]) -> NerOutcome {
        if texts.is_empty() {
            return NerOutcome::Spans(Vec::new());
        }
        let keys: Vec<Option<CacheKey>> = texts
            .iter()
            .map(|text| (!text.is_empty()).then(|| self.cache.key(text)))
            .collect();
        let mut resolved: Vec<Option<Vec<ExternalSpan>>> = keys
            .iter()
            .map(|key| match key {
                None => Some(Vec::new()),
                Some(key) => self.cache.get(key),
            })
            .collect();
        if let Some(spans) = all_resolved(&resolved) {
            return NerOutcome::Spans(spans);
        }

        let _turn = self.gate.acquire().await;
        for (slot, key) in resolved.iter_mut().zip(&keys) {
            if let (None, Some(key)) = (&slot, key) {
                *slot = self.cache.get(key);
            }
        }
        let mut pending: Vec<String> = Vec::new();
        let mut pending_keys: Vec<CacheKey> = Vec::new();
        for (index, slot) in resolved.iter().enumerate() {
            if slot.is_some() {
                continue;
            }
            let Some(key) = keys[index] else { continue };
            if pending_keys.contains(&key) {
                continue;
            }
            pending_keys.push(key);
            pending.push(texts[index].clone());
        }
        if pending.is_empty() {
            return match all_resolved(&resolved) {
                Some(spans) => NerOutcome::Spans(spans),
                None => NerOutcome::Unavailable("internal: unresolved leaf".to_string()),
            };
        }
        let total: usize = pending.iter().map(String::len).sum();
        if total > MAX_REQUEST_BYTES {
            return NerOutcome::Unavailable(format!(
                "request text of {total} bytes exceeds the {MAX_REQUEST_BYTES} byte cap"
            ));
        }

        let parsed = match self.post_once_then_retry(&pending).await {
            Ok(parsed) => parsed,
            Err(reason) => return NerOutcome::Unavailable(reason),
        };
        if parsed.spans.len() != pending.len() {
            return NerOutcome::Unavailable(format!(
                "detector returned {} span lists for {} texts",
                parsed.spans.len(),
                pending.len()
            ));
        }
        let mut fresh: HashMap<CacheKey, Vec<ExternalSpan>> = HashMap::new();
        for (key, list) in pending_keys.into_iter().zip(parsed.spans) {
            let spans = self.filter_spans(list);
            self.cache.put(key, spans.clone());
            fresh.insert(key, spans);
        }
        for (slot, key) in resolved.iter_mut().zip(&keys) {
            if let (None, Some(key)) = (&slot, key) {
                *slot = fresh.get(key).cloned();
            }
        }
        match all_resolved(&resolved) {
            Some(spans) => NerOutcome::Spans(spans),
            None => NerOutcome::Unavailable("detector answer did not cover every text".to_string()),
        }
    }

    /// `/v1/detect` is pure inference, so a send that never got an answer is safe to repeat
    /// once: a connection the VM gateway dropped between two bursts costs a retry, not a
    /// request forwarded with rules only. A timeout is not repeated, it would only double the
    /// wait the caller already paid.
    async fn post_once_then_retry(&self, texts: &[String]) -> Result<DetectResponse, String> {
        match self.post(texts).await {
            Ok(parsed) => Ok(parsed),
            Err(PostError::Rejected(reason)) => Err(reason),
            Err(PostError::Transport(first)) if first.is_timeout() => {
                Err(format!("request failed: {}", error_chain(&first)))
            }
            Err(PostError::Transport(first)) => {
                log::debug!(
                    "retrying the PII NER detector after a transport error: {}",
                    error_chain(&first)
                );
                match self.post(texts).await {
                    Ok(parsed) => Ok(parsed),
                    Err(PostError::Rejected(reason)) => Err(reason),
                    Err(PostError::Transport(second)) => Err(format!(
                        "request failed twice: {}; first: {}",
                        error_chain(&second),
                        error_chain(&first)
                    )),
                }
            }
        }
    }

    async fn post(&self, texts: &[String]) -> Result<DetectResponse, PostError> {
        let response = self
            .client
            .post(&self.endpoint)
            .header(NER_AUTH_HEADER, &self.token)
            .json(&DetectRequest { texts })
            .send()
            .await
            .map_err(PostError::Transport)?;
        let status = response.status();
        if status != reqwest::StatusCode::OK {
            return Err(PostError::Rejected(format!("detector answered {status}")));
        }
        response
            .json()
            .await
            .map_err(|e| PostError::Rejected(format!("malformed detector response: {e}")))
    }

    fn filter_spans(&self, spans: Vec<WireSpan>) -> Vec<ExternalSpan> {
        spans
            .into_iter()
            .filter(|s| s.confidence >= self.min_confidence)
            .filter(|s| self.labels.is_empty() || self.labels.contains(&s.label))
            .map(|s| ExternalSpan {
                start: s.start,
                end: s.end,
                category: s.label,
            })
            .collect()
    }

    /// Logs an unavailability at most once per minute; a dead detector must not flood the log.
    pub fn warn_unavailable(&self, reason: &str) {
        let mut last = self
            .last_warn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let due = last.is_none_or(|t| t.elapsed() >= WARN_INTERVAL);
        if due {
            *last = Some(Instant::now());
            log::warn!("PII NER detector unavailable, scanning with rules only: {reason}");
        }
    }
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test fixture setup, failure aborts the test"
    )]
    use super::*;

    fn cfg(url: &str) -> NerConfig {
        NerConfig {
            url: url.to_string(),
            token: "t".to_string(),
            min_confidence: 0.6,
            labels: vec!["SURNAME".into(), "CITY".into()],
            timeout_ms: 5000,
        }
    }

    #[test]
    fn base_url_must_be_the_bare_gateway_endpoint() {
        assert!(validate_base_url("http://host.docker.internal:50123").is_ok());
        assert!(validate_base_url("http://host.docker.internal:50123/").is_ok());
        for bad in [
            "https://host.docker.internal:50123",
            "http://host.docker.internal",
            "http://10.0.0.1:50123",
            "http://host.docker.internal:50123/v1/detect",
            "http://host.docker.internal:50123?a=b",
            "http://x@host.docker.internal:50123",
            "",
        ] {
            assert!(validate_base_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn from_config_rejects_bad_urls_and_empty_tokens_but_accepts_the_rendered_shape() {
        assert!(NerClient::from_config(cfg("http://10.0.0.1:1")).is_err());
        let mut empty = cfg("http://host.docker.internal:50123");
        empty.token.clear();
        assert!(NerClient::from_config(empty).is_err());
        let client = NerClient::from_config(cfg("http://host.docker.internal:50123/")).unwrap();
        assert_eq!(
            client.endpoint,
            "http://host.docker.internal:50123/v1/detect"
        );
    }

    #[test]
    fn filter_keeps_configured_labels_above_the_threshold() {
        let client = NerClient::for_test(cfg("http://127.0.0.1:1"));
        let spans = vec![
            WireSpan {
                start: 0,
                end: 3,
                label: "SURNAME".into(),
                confidence: 0.95,
            },
            WireSpan {
                start: 4,
                end: 8,
                label: "SURNAME".into(),
                confidence: 0.59,
            },
            WireSpan {
                start: 9,
                end: 12,
                label: "URL".into(),
                confidence: 0.99,
            },
            WireSpan {
                start: 13,
                end: 20,
                label: "CITY".into(),
                confidence: 0.6,
            },
        ];
        let kept = client.filter_spans(spans);
        assert_eq!(kept.len(), 2);
        assert_eq!(
            (kept[0].start, kept[0].end, kept[0].category.as_str()),
            (0, 3, "SURNAME")
        );
        assert_eq!(kept[1].category, "CITY");

        let mut any = cfg("http://127.0.0.1:1");
        any.labels.clear();
        let client = NerClient::for_test(any);
        let kept = client.filter_spans(vec![WireSpan {
            start: 0,
            end: 1,
            label: "URL".into(),
            confidence: 0.9,
        }]);
        assert_eq!(kept.len(), 1);
    }

    #[test]
    fn debug_output_never_carries_the_token() {
        let rendered = format!("{:?}", cfg("http://host.docker.internal:50123"));
        assert!(rendered.contains("[redacted]") && !rendered.contains("\"t\""));
        let client = NerClient::for_test(cfg("http://127.0.0.1:1"));
        assert!(!format!("{client:?}").contains("token"));
    }

    #[tokio::test]
    async fn empty_and_oversized_batches_short_circuit() {
        let client = NerClient::for_test(cfg("http://127.0.0.1:1"));
        assert_eq!(
            client.detect_batch(&[]).await,
            NerOutcome::Spans(Vec::new())
        );
        let huge = vec!["x".repeat(MAX_REQUEST_BYTES + 1)];
        assert!(matches!(
            client.detect_batch(&huge).await,
            NerOutcome::Unavailable(_)
        ));
    }

    /// Detector stand-in: answers every text with one span, counts the texts per request and
    /// can drop the first connection unanswered the way the VM gateway drops a stale one.
    struct FakeDetector {
        port: u16,
        batches: std::sync::Arc<Mutex<Vec<usize>>>,
    }

    #[derive(Deserialize)]
    struct WireRequest {
        texts: Vec<String>,
    }

    impl FakeDetector {
        async fn spawn(drop_first_connection: bool) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let batches = std::sync::Arc::new(Mutex::new(Vec::new()));
            let recorded = std::sync::Arc::clone(&batches);
            tokio::spawn(async move {
                let mut drop_next = drop_first_connection;
                while let Ok((mut stream, _)) = listener.accept().await {
                    if drop_next {
                        drop_next = false;
                        drop(stream);
                        continue;
                    }
                    let Some(texts) = read_texts(&mut stream).await else {
                        continue;
                    };
                    recorded
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push(texts.len());
                    let spans: Vec<serde_json::Value> = texts
                        .iter()
                        .map(|text| {
                            serde_json::json!([{
                                "start": 0,
                                "end": text.len().min(3),
                                "label": "SURNAME",
                                "confidence": 0.9,
                            }])
                        })
                        .collect();
                    let body = serde_json::json!({ "spans": spans }).to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    use tokio::io::AsyncWriteExt;
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.flush().await;
                }
            });
            Self { port, batches }
        }

        fn url(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }

        fn batches(&self) -> Vec<usize> {
            self.batches
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }
    }

    /// Reads one HTTP request off the socket and returns the `texts` it carries.
    async fn read_texts(stream: &mut tokio::net::TcpStream) -> Option<Vec<String>> {
        use tokio::io::AsyncReadExt;
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..read]);
            let Some(head) = buffer
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .map(|at| at + 4)
            else {
                continue;
            };
            let headers = String::from_utf8_lossy(&buffer[..head]).to_lowercase();
            let length: usize = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse().ok())?;
            if buffer.len() >= head + length {
                let parsed: WireRequest =
                    serde_json::from_slice(&buffer[head..head + length]).ok()?;
                return Some(parsed.texts);
            }
        }
    }

    #[tokio::test]
    async fn a_repeated_text_is_detected_once_and_then_served_from_the_cache() {
        let detector = FakeDetector::spawn(false).await;
        let client = NerClient::for_test(cfg(&detector.url()));
        let leaves = vec!["Kowalski".to_string(), "Kowalski".to_string()];

        let first = client.detect_batch(&leaves).await;
        let NerOutcome::Spans(spans) = &first else {
            panic!("{first:?}")
        };
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0], spans[1]);
        assert_eq!(spans[0].len(), 1);

        let second = client.detect_batch(&leaves).await;
        assert_eq!(first, second);
        assert_eq!(
            detector.batches(),
            vec![1],
            "one round trip with one text: the repeat inside the batch and the second call are cached"
        );
    }

    #[tokio::test]
    async fn blank_leaves_never_reach_the_detector_but_keep_their_slot() {
        let detector = FakeDetector::spawn(false).await;
        let client = NerClient::for_test(cfg(&detector.url()));

        let outcome = client
            .detect_batch(&[String::new(), "Kowalski".to_string(), String::new()])
            .await;
        let NerOutcome::Spans(spans) = &outcome else {
            panic!("{outcome:?}")
        };
        assert_eq!(spans.len(), 3);
        assert!(spans[0].is_empty() && spans[2].is_empty());
        assert_eq!(spans[1].len(), 1);
        assert_eq!(detector.batches(), vec![1]);
    }

    #[tokio::test]
    async fn a_dropped_connection_is_retried_before_degrading_to_rules_only() {
        let detector = FakeDetector::spawn(true).await;
        let client = NerClient::for_test(cfg(&detector.url()));

        let outcome = client.detect_batch(&["Kowalski".to_string()]).await;
        let NerOutcome::Spans(spans) = &outcome else {
            panic!("{outcome:?}")
        };
        assert_eq!(spans[0].len(), 1);
        assert_eq!(detector.batches(), vec![1]);
    }

    #[tokio::test]
    async fn the_cache_survives_a_generation_rotation_for_a_text_that_keeps_coming_back() {
        let client = NerClient::for_test(cfg("http://127.0.0.1:1"));
        let hot = client.cache.key("system prompt");
        client.cache.put(hot, vec![]);
        for filler in 0..CACHE_GENERATION_ENTRIES {
            let key = client.cache.key(&format!("leaf {filler}"));
            client.cache.put(key, vec![]);
            assert!(client.cache.get(&hot).is_some(), "rotation {filler}");
        }
    }

    #[tokio::test]
    async fn connection_failure_is_unavailable() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let client = NerClient::for_test(cfg(&format!("http://127.0.0.1:{port}")));
        let outcome = client.detect_batch(&["Jan".to_string()]).await;
        assert!(matches!(outcome, NerOutcome::Unavailable(_)), "{outcome:?}");
        client.warn_unavailable("first");
        client.warn_unavailable("second is suppressed");
        assert!(client.last_warn.lock().unwrap().is_some());
    }
}
