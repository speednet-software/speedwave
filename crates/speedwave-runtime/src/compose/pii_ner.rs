//! Host-side PII NER detector wiring (ADR-090): reads the Desktop service lock and renders
//! the `ner` section of `proxy.json`, so the proxy can ask the host for entity spans.

use std::path::Path;

use serde::Serialize;

use crate::consts;
use crate::host_mcp_process::lock::{self, LockService};

/// Confidence below which the proxy drops a detected span.
pub const DEFAULT_NER_MIN_CONFIDENCE: f32 = 0.6;

/// Model labels the proxy seals by default. `ORG`, `IMEI`, `URL` and `IP_ADDRESS` are left
/// out: they are routine technical content in a coding assistant, not personal data.
pub const DEFAULT_NER_LABELS: &[&str] = &[
    "SSN",
    "CREDIT_CARD",
    "EMAIL",
    "GIVEN_NAME",
    "SURNAME",
    "PHONE",
    "TAX_ID",
    "BANK_ACCOUNT",
    "ROUTING_NUMBER",
    "GOVERNMENT_ID",
    "PASSPORT",
    "DRIVERS_LICENSE",
    "BUILDING_NUMBER",
    "STREET_NAME",
    "SECONDARY_ADDRESS",
    "CITY",
    "STATE",
    "ZIP_CODE",
];

/// A detector whose lock names a live process.
#[derive(Clone, PartialEq, Eq)]
pub struct LiveNerService {
    /// Host bind port of the detector.
    pub port: u16,
    token: String,
}

impl LiveNerService {
    /// Bearer secret the proxy must present.
    pub fn token(&self) -> &str {
        &self.token
    }

    #[cfg(test)]
    pub(crate) fn test_new(port: u16, token: &str) -> Self {
        Self {
            port,
            token: token.to_string(),
        }
    }
}

impl std::fmt::Debug for LiveNerService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveNerService")
            .field("port", &self.port)
            .field("token", &"***REDACTED***")
            .finish()
    }
}

/// Reads `<data_dir>/pii-ner.lock.json`; `None` unless the recorded PID is alive and a
/// token is present, so a stale lock never renders a dead endpoint into `proxy.json`.
pub fn live_service_in(data_dir: &Path) -> Option<LiveNerService> {
    let lock = lock::read(
        &data_dir.join(consts::PII_NER_LOCK_FILE),
        LockService::PiiNer,
    )?;
    if !crate::host_mcp_process::probe::is_pid_alive(lock.pid) || lock.auth_token.is_empty() {
        return None;
    }
    Some(LiveNerService {
        port: lock.port,
        token: lock.auth_token,
    })
}

/// The `ner` object of `proxy.json`; field names mirror `containers/proxy/src/ner.rs::NerConfig`.
#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct NerRenderConfig {
    url: String,
    token: String,
    min_confidence: f32,
    labels: Vec<String>,
}

pub(crate) fn ner_render_config(live: &LiveNerService) -> NerRenderConfig {
    NerRenderConfig {
        url: super::workers::worker_gateway_url(live.port),
        token: live.token.clone(),
        min_confidence: DEFAULT_NER_MIN_CONFIDENCE,
        labels: DEFAULT_NER_LABELS.iter().map(|l| l.to_string()).collect(),
    }
}

/// Accepts only `http://<HOST_GATEWAY_ALIAS>:<port>` with nothing else; returns the port.
pub fn validate_ner_url(raw: &str) -> Result<u16, String> {
    let url = url::Url::parse(raw).map_err(|e| format!("not a URL: {e}"))?;
    if url.scheme() != "http" {
        return Err(format!("scheme must be http, got {}", url.scheme()));
    }
    if url.host_str() != Some(consts::HOST_GATEWAY_ALIAS) {
        return Err(format!("host must be {}", consts::HOST_GATEWAY_ALIAS));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("userinfo is not allowed".to_string());
    }
    if !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
        return Err("path, query and fragment are not allowed".to_string());
    }
    url.port()
        .ok_or_else(|| "an explicit port is required".to_string())
}

/// Whether a rendered `proxy.json` still matches the detector that is live now.
#[derive(Debug, PartialEq, Eq)]
pub enum NerUrlState {
    /// No `ner` section rendered and no live detector: nothing to reconcile.
    Absent,
    /// The rendered URL targets the live detector's container-facing port.
    Current,
    /// Rendered and live disagree (either side missing, another port, or unparsable JSON).
    Stale,
}

/// Exact match between `ner.url` in `proxy_json` and the URL the renderer would write for
/// `live_port`; an unparsable config never counts as current.
pub fn ner_url_state(proxy_json: &str, live_port: Option<u16>) -> NerUrlState {
    let doc: serde_json::Value = match serde_json::from_str(proxy_json) {
        Ok(doc) => doc,
        Err(e) => {
            log::warn!("proxy.json is not parsable ({e}); treating the NER URL as stale");
            return NerUrlState::Stale;
        }
    };
    let rendered = doc.pointer("/ner/url").and_then(|v| v.as_str());
    match (rendered, live_port) {
        (None, None) => NerUrlState::Absent,
        (Some(url), Some(port)) if url == super::workers::worker_gateway_url(port) => {
            NerUrlState::Current
        }
        _ => NerUrlState::Stale,
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::*;
    use crate::host_mcp_process::lock::LockFile;

    fn write_lock(dir: &Path, pid: u32, port: u16, token: &str) {
        let lock = LockFile::new(LockService::PiiNer, pid, port, token.to_string());
        lock::write(&dir.join(consts::PII_NER_LOCK_FILE), &lock).unwrap();
    }

    #[test]
    fn live_service_requires_a_live_pid_and_a_token() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(live_service_in(tmp.path()).is_none());

        write_lock(tmp.path(), std::process::id(), 50111, "secret");
        let live = live_service_in(tmp.path()).unwrap();
        assert_eq!(live.port, 50111);
        assert_eq!(live.token(), "secret");
        assert!(!format!("{live:?}").contains("secret"));

        write_lock(tmp.path(), std::process::id(), 50111, "");
        assert!(live_service_in(tmp.path()).is_none());

        write_lock(tmp.path(), u32::MAX - 7, 50111, "secret");
        assert!(live_service_in(tmp.path()).is_none());
    }

    #[test]
    fn lock_of_another_service_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let lock = LockFile::new(LockService::McpOs, std::process::id(), 5, "t".into());
        lock::write(&tmp.path().join(consts::PII_NER_LOCK_FILE), &lock).unwrap();
        assert!(live_service_in(tmp.path()).is_none());
    }

    #[test]
    fn render_config_carries_gateway_url_defaults_and_token() {
        let live = LiveNerService {
            port: 50222,
            token: "tok".into(),
        };
        let cfg = ner_render_config(&live);
        assert_eq!(validate_ner_url(&cfg.url), Ok(50222));
        assert_eq!(cfg.token, "tok");
        assert_eq!(cfg.labels.len(), DEFAULT_NER_LABELS.len());
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.starts_with(r#"{"url":"http://host.docker.internal:50222","token":"tok","min_confidence":0.6,"labels":["SSN","#));
    }

    #[test]
    fn default_labels_exclude_technical_and_organisation_classes() {
        for excluded in ["ORG", "IMEI", "URL", "IP_ADDRESS"] {
            assert!(!DEFAULT_NER_LABELS.contains(&excluded), "{excluded}");
        }
        let mut sorted = DEFAULT_NER_LABELS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), DEFAULT_NER_LABELS.len());
    }

    #[test]
    fn validate_ner_url_accepts_only_the_bare_gateway_endpoint() {
        assert_eq!(
            validate_ner_url("http://host.docker.internal:4321"),
            Ok(4321)
        );
        assert_eq!(
            validate_ner_url("http://host.docker.internal:4321/"),
            Ok(4321)
        );
        for bad in [
            "https://host.docker.internal:4321",
            "http://host.docker.internal",
            "http://127.0.0.1:4321",
            "http://host.docker.internal:4321/v1/detect",
            "http://host.docker.internal:4321?x=1",
            "http://host.docker.internal:4321#f",
            "http://user@host.docker.internal:4321",
            "host.docker.internal:4321",
            "",
        ] {
            assert!(validate_ner_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn ner_url_state_matches_exactly() {
        let expected = super::super::workers::worker_gateway_url(50333);
        let rendered = format!(r#"{{"routes":[],"ner":{{"url":"{expected}","token":"t"}}}}"#);
        assert_eq!(ner_url_state(&rendered, Some(50333)), NerUrlState::Current);
        assert_eq!(ner_url_state(&rendered, Some(5033)), NerUrlState::Stale);
        assert_eq!(ner_url_state(&rendered, None), NerUrlState::Stale);
        assert_eq!(
            ner_url_state(r#"{"routes":[]}"#, Some(50333)),
            NerUrlState::Stale
        );
        assert_eq!(ner_url_state(r#"{"routes":[]}"#, None), NerUrlState::Absent);
        assert_eq!(ner_url_state("not json", None), NerUrlState::Stale);
    }
}
