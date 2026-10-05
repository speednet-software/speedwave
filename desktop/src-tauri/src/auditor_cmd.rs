//! The Auditor integration: on a machine under an `llm_egress` policy (ADR-090), what the
//! organisation's Auditor applies to the machine and each project, for display.

use serde::Serialize;
use serde_json::Value;
use speedwave_runtime::defaults::canonical_anthropic_model_id;
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const SELF_PATH: &str = "/api/ai-egress/host/self";
const EGRESS_PATH: &str = "/api/ai-egress";
const AGENT_STATE_PATH: &str = "/Library/Application Support/Auditor/state.json";
const FRESH_FOR: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_PROJECT_LEN: usize = 200;

/// What the UI shows about Auditor; `managed == false` means no policy on the machine.
#[derive(Serialize, Clone, Default)]
pub struct AuditorStatus {
    pub managed: bool,
    pub reachable: bool,
    pub error: Option<String>,
    pub auditor_url: Option<String>,
    pub agent_version: Option<String>,
    pub latency_ms: Option<u64>,
    pub checked_at: Option<String>,
    pub organization: Option<String>,
    pub host: Option<Value>,
    pub access: Option<Value>,
    pub deployments: Vec<Value>,
    pub use_cases: Vec<Value>,
    pub project: Option<Value>,
    pub package_version: Option<String>,
}

struct Endpoint {
    root: String,
    headers: BTreeMap<String, String>,
    ca: Option<String>,
}

fn endpoint() -> Option<Endpoint> {
    let eg = crate::containers_cmd::managed_llm_egress()?;
    let mut url = reqwest::Url::parse(eg.anthropic_base_url.as_deref()?).ok()?;
    let loopback = url
        .host_str()
        .and_then(crate::http_util::rewrite_container_alias_to_loopback);
    if let Some(host) = loopback {
        url.set_host(Some(host)).ok()?;
    }
    let base = url.as_str().trim_end_matches('/');
    let root = base
        .split(EGRESS_PATH)
        .next()
        .unwrap_or(base)
        .trim_end_matches('/');
    Some(Endpoint {
        root: root.to_string(),
        ca: eg.ca_pem().map(str::to_string),
        headers: eg.headers,
    })
}

fn agent_version() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let text = std::fs::read_to_string(AGENT_STATE_PATH).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("agent_version")?.as_str().map(str::to_string)
}

static CACHE: Mutex<Vec<(String, Instant, AuditorStatus)>> = Mutex::new(Vec::new());

fn cached(key: &str) -> Option<(Instant, AuditorStatus)> {
    CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .find(|(k, _, _)| k == key)
        .map(|(_, at, s)| (*at, s.clone()))
}

fn store(key: &str, status: &AuditorStatus) {
    let mut c = CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    c.retain(|(k, _, _)| k != key);
    c.push((key.to_string(), Instant::now(), status.clone()));
}

fn pick(v: &Value, keys: &[&str]) -> Value {
    let mut out = serde_json::Map::new();
    for k in keys {
        if let Some(x) = v.get(*k) {
            out.insert((*k).to_string(), x.clone());
        }
    }
    Value::Object(out)
}

fn fill(status: &mut AuditorStatus, v: &Value) {
    status.reachable = true;
    status.error = None;
    status.organization = v
        .get("organization")
        .and_then(Value::as_str)
        .map(str::to_string);
    status.host = v.get("host").map(|h| pick(h, &["id", "name", "hostType"]));
    status.access = v.get("access").map(|a| {
        pick(
            a,
            &[
                "state",
                "mode",
                "reason",
                "models",
                "pinned_model",
                "default_model",
            ],
        )
    });
    status.deployments = v
        .get("deployments")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|d| {
                    pick(
                        d,
                        &[
                            "id",
                            "name",
                            "deploymentType",
                            "providerName",
                            "providerCode",
                            "models",
                            "region",
                            "dataScope",
                        ],
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    status.use_cases = v
        .get("use_cases")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|u| {
                    pick(
                        u,
                        &[
                            "node_id",
                            "name",
                            "state",
                            "reason",
                            "compliance",
                            "pinned_model",
                            "models",
                        ],
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    status.project = v.get("project").filter(|p| !p.is_null()).cloned();
    status.package_version = v
        .get("package")
        .and_then(|p| p.get("macos"))
        .and_then(Value::as_str)
        .map(str::to_string);
}

/// What Auditor applies on this machine, and to `project` when named; the last answer on failure.
#[tauri::command]
pub async fn get_auditor_status(
    project: Option<String>,
    force: Option<bool>,
) -> Result<AuditorStatus, String> {
    let Some(ep) = endpoint() else {
        return Ok(AuditorStatus::default());
    };
    let project = project.filter(|p| !p.trim().is_empty());
    if project.as_ref().is_some_and(|p| p.len() > MAX_PROJECT_LEN) {
        return Err("project name too long".to_string());
    }
    let key = project.clone().unwrap_or_default();
    let last = cached(&key);
    if !force.unwrap_or(false) {
        if let Some((at, s)) = &last {
            if at.elapsed() < FRESH_FOR && s.reachable {
                return Ok(s.clone());
            }
        }
    }
    let previous_error = last.as_ref().and_then(|(_, s)| s.error.clone());
    let mut status = last.map(|(_, s)| s).unwrap_or_default();
    status.managed = true;
    status.auditor_url = Some(ep.root.clone());
    status.agent_version = agent_version();
    let mut url =
        reqwest::Url::parse(&format!("{}{SELF_PATH}", ep.root)).map_err(|e| e.to_string())?;
    if let Some(p) = &project {
        url.query_pairs_mut().append_pair("project", p);
    }
    let client = crate::http_util::build_hardened_client_trusting(None, ep.ca.as_deref())?;
    let started = Instant::now();
    let mut request = client.get(url).timeout(REQUEST_TIMEOUT);
    for (name, value) in &ep.headers {
        request = request.header(name, value);
    }
    let answer = request.send().await;
    match answer {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(v) => fill(&mut status, &v),
            Err(e) => {
                status.reachable = false;
                status.error = Some(format!("Auditor sent an unreadable answer: {e}"));
            }
        },
        Ok(r) => {
            let code = r.status();
            let detail = r
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("detail").and_then(Value::as_str).map(str::to_string));
            status.reachable = false;
            status.error = Some(detail.unwrap_or_else(|| format!("Auditor answered {code}")));
        }
        Err(e) => {
            status.reachable = false;
            status.error = Some(format!("Auditor could not be reached: {}", e.without_url()));
        }
    }
    status.latency_ms = Some(started.elapsed().as_millis() as u64);
    status.checked_at = Some(chrono::Utc::now().to_rfc3339());
    if status.error != previous_error {
        match &status.error {
            Some(e) => log::warn!("Auditor status is unavailable: {e}"),
            None => log::info!("Auditor status is available again"),
        }
    }
    store(&key, &status);
    Ok(status)
}

/// The models Auditor allows for `project`, from its last answer.
pub(crate) fn allowed_models(project: &str) -> Option<Vec<String>> {
    let (_, s) = cached(project)?;
    let models = s
        .project?
        .get("models")?
        .as_array()?
        .iter()
        .filter_map(|m| m.as_str().map(str::to_string))
        .collect::<Vec<_>>();
    Some(models)
}

fn same_model(a: &str, b: &str) -> bool {
    canonical_anthropic_model_id(a) == canonical_anthropic_model_id(b)
}

fn check_against(allowed: Option<&[String]>, model: &str) -> Result<(), String> {
    match allowed {
        Some(list) if !list.is_empty() && !list.iter().any(|m| same_model(m, model)) => {
            Err(format!(
                "Auditor does not allow {model} for this project ({})",
                list.join(", ")
            ))
        }
        _ => Ok(()),
    }
}

fn allowed_pin(pin: String, allowed: Option<&[String]>) -> Option<String> {
    allowed
        .is_some_and(|list| list.iter().any(|m| same_model(m, &pin)))
        .then_some(pin)
}

/// Under the policy a pick must be one of the models Auditor allows for the project.
pub(crate) fn check_model_allowed(project: &str, model: &str) -> Result<(), String> {
    if !crate::containers_cmd::llm_locked_by_policy() {
        return Ok(());
    }
    check_against(allowed_models(project).as_deref(), model)
}

/// The project's pinned model when Auditor allows it, for `--model` over the policy's default.
pub(crate) fn policy_model_flag(project: &str) -> Option<String> {
    if !crate::containers_cmd::llm_locked_by_policy() {
        return None;
    }
    let pin = speedwave_runtime::claude_settings::get_model_pin(
        speedwave_runtime::consts::data_dir().as_path(),
        project,
    )?;
    allowed_pin(pin, allowed_models(project).as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fill_keeps_what_the_ui_shows_and_drops_the_rest() {
        let mut s = AuditorStatus::default();
        fill(
            &mut s,
            &json!({
                "organization": "Speednet",
                "host": {"id": "h", "name": "Mac", "owner": "x"},
                "access": {"state": "ALLOWED", "models": [], "rate_limit_rpm": 5},
                "deployments": [{"id": "d", "name": "Claude", "models": ["claude-opus-4-8"], "secret": "no"}],
                "use_cases": [{"node_id": "n", "name": "UC", "compliance": {"state": "COMPLETE"}, "usage": {"x": 1}}],
                "project": {"name": "p", "models": ["claude-opus-4-8"]},
                "recent": [{"prompt": "never"}],
                "package": {"macos": "1.0.3"}
            }),
        );
        assert!(s.reachable && s.organization.as_deref() == Some("Speednet"));
        assert!(s.host.as_ref().unwrap().get("owner").is_none());
        assert!(s.access.as_ref().unwrap().get("rate_limit_rpm").is_none());
        assert!(s.deployments[0].get("secret").is_none());
        assert!(
            s.use_cases[0].get("usage").is_none()
                && s.use_cases[0]["compliance"]["state"] == "COMPLETE"
        );
        assert_eq!(s.package_version.as_deref(), Some("1.0.3"));
        let text = serde_json::to_string(&s).unwrap();
        assert!(!text.contains("never"));
    }

    #[test]
    fn a_model_with_a_context_suffix_is_the_same_model() {
        assert!(same_model("claude-sonnet-5[1m]", "claude-sonnet-5"));
        assert!(!same_model("claude-opus-4-8", "claude-sonnet-5"));
    }

    #[test]
    fn a_pick_outside_the_allowed_models_is_refused() {
        let allowed = vec!["claude-opus-5-5".to_string(), "claude-sonnet-5".to_string()];
        assert!(check_against(Some(&allowed), "claude-sonnet-5[1m]").is_ok());
        assert!(check_against(Some(&allowed), "claude-haiku-4-5").is_err());
        assert!(check_against(Some(&[]), "claude-haiku-4-5").is_ok());
        assert!(check_against(None, "claude-haiku-4-5").is_ok());
    }

    #[test]
    fn only_an_allowed_pin_reaches_the_session() {
        let allowed = vec!["claude-opus-5-5".to_string()];
        assert_eq!(
            allowed_pin("claude-opus-5-5[1m]".into(), Some(&allowed)).as_deref(),
            Some("claude-opus-5-5[1m]")
        );
        assert!(allowed_pin("claude-sonnet-5".into(), Some(&allowed)).is_none());
        assert!(allowed_pin("claude-opus-5-5".into(), None).is_none());
    }
}
