//! Client of the host-side PII NER detector (ADR-089): one POST per request carrying every
//! scanned string leaf, byte-offset spans back. Any failure degrades to `Unavailable`.

use std::collections::HashSet;
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

const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const WARN_INTERVAL: Duration = Duration::from_secs(60);

fn default_min_confidence() -> f32 {
    0.6
}

fn default_timeout_ms() -> u64 {
    5000
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
    /// When set, an unavailable detector fails the request instead of degrading to rules only.
    #[serde(default)]
    pub required: bool,
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
            .field("required", &self.required)
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

/// Ready-to-call detector client; built once at startup from the `ner` section.
pub struct NerClient {
    endpoint: String,
    token: String,
    min_confidence: f32,
    labels: HashSet<String>,
    required: bool,
    client: reqwest::Client,
    last_warn: Mutex<Option<Instant>>,
}

impl std::fmt::Debug for NerClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NerClient")
            .field("endpoint", &self.endpoint)
            .field("required", &self.required)
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
            required: cfg.required,
            client,
            last_warn: Mutex::new(None),
        })
    }

    /// Whether an unavailable detector must fail the request.
    pub fn required(&self) -> bool {
        self.required
    }

    /// Detects spans for every text in one round trip; the result has exactly one list per
    /// input text or is `Unavailable`.
    pub async fn detect_batch(&self, texts: &[String]) -> NerOutcome {
        if texts.is_empty() {
            return NerOutcome::Spans(Vec::new());
        }
        let total: usize = texts.iter().map(String::len).sum();
        if total > MAX_REQUEST_BYTES {
            return NerOutcome::Unavailable(format!(
                "request text of {total} bytes exceeds the {MAX_REQUEST_BYTES} byte cap"
            ));
        }
        let response = match self
            .client
            .post(&self.endpoint)
            .header(NER_AUTH_HEADER, &self.token)
            .json(&DetectRequest { texts })
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                return NerOutcome::Unavailable(format!("request failed: {}", error_chain(&e)))
            }
        };
        let status = response.status();
        if status != reqwest::StatusCode::OK {
            return NerOutcome::Unavailable(format!("detector answered {status}"));
        }
        let parsed: DetectResponse = match response.json().await {
            Ok(p) => p,
            Err(e) => return NerOutcome::Unavailable(format!("malformed detector response: {e}")),
        };
        if parsed.spans.len() != texts.len() {
            return NerOutcome::Unavailable(format!(
                "detector returned {} span lists for {} texts",
                parsed.spans.len(),
                texts.len()
            ));
        }
        NerOutcome::Spans(
            parsed
                .spans
                .into_iter()
                .map(|list| self.filter_spans(list))
                .collect(),
        )
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
            required: false,
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
        assert!(!client.required());
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
