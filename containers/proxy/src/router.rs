use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Auth {
    #[serde(deserialize_with = "de_bare_auth")]
    Bare(BareAuth),
    Swap {
        #[serde(rename = "swap_env")]
        env: String,
        scheme: Scheme,
    },
}

#[derive(Debug, PartialEq)]
pub enum BareAuth {
    Passthrough,
    None,
}

fn de_bare_auth<'de, D: serde::Deserializer<'de>>(d: D) -> Result<BareAuth, D::Error> {
    use serde::de::Error;
    match String::deserialize(d)?.as_str() {
        "passthrough" => Ok(BareAuth::Passthrough),
        "none" => Ok(BareAuth::None),
        other => Err(D::Error::custom(format!(
            "expected \"passthrough\" or \"none\", got {other:?}"
        ))),
    }
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Scheme {
    Bearer,
    None,
}

#[derive(Debug, Deserialize)]
pub struct Route {
    pub prefix: String,
    pub base_url: String,
    pub auth: Auth,
    #[serde(default)]
    pub provider_kind: String,
    #[serde(default)]
    pub provider_id: String,
}

#[derive(Deserialize)]
pub struct Config {
    pub routes: Vec<Route>,
    #[serde(default)]
    pub caller_token: Option<String>,
    #[serde(skip)]
    pub usage_path: PathBuf,
    #[serde(skip, default = "build_forward_client")]
    pub client: reqwest::Client,
    #[serde(skip, default = "crate::pii::load_engine_state")]
    pub pii: std::sync::Arc<crate::pii::PiiEngineState>,
    #[serde(skip, default = "resolve_audit_dir")]
    pub audit_dir: Option<PathBuf>,
    /// Host-side NER detector (ADR-091); present only when the renderer saw a live detector.
    #[serde(skip)]
    pub ner: Option<std::sync::Arc<crate::ner::NerClient>>,
}

fn resolve_audit_dir() -> Option<PathBuf> {
    std::env::var("AUDIT_DIR").ok().map(PathBuf::from)
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("routes", &self.routes)
            .field(
                "caller_token",
                &self.caller_token.as_ref().map(|_| "[redacted]"),
            )
            .field("usage_path", &self.usage_path)
            .field("ner", &self.ner)
            .finish_non_exhaustive()
    }
}

fn build_forward_client() -> reqwest::Client {
    let build = || {
        reqwest::Client::builder()
            .use_rustls_tls()
            .redirect(reqwest::redirect::Policy::none())
    };
    build().build().unwrap_or_else(|e| {
        log::warn!("forward client build failed ({e}), retrying without proxy env vars");
        build().no_proxy().build().unwrap_or_else(|e| {
            log::error!("failed to build proxy forward client: {e}");
            std::process::exit(1);
        })
    })
}

impl Default for Config {
    fn default() -> Self {
        Self {
            routes: Vec::new(),
            caller_token: None,
            usage_path: PathBuf::from(
                std::env::var("SPW_USAGE_PATH")
                    .unwrap_or_else(|_| "/usage/usage.jsonl".to_string()),
            ),
            client: build_forward_client(),
            pii: crate::pii::load_engine_state(),
            audit_dir: resolve_audit_dir(),
            ner: None,
        }
    }
}

#[derive(Deserialize)]
struct RoutesFile {
    routes: Vec<Route>,
    #[serde(default)]
    caller_token: Option<String>,
    #[serde(default)]
    ner: Option<crate::ner::NerConfig>,
}

impl Config {
    pub fn load_from(path: &std::path::Path) -> Result<Self, Box<dyn std::error::Error>> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("reading {}: {e}", path.display()))?;
        let parsed: RoutesFile =
            serde_json::from_str(&raw).map_err(|e| format!("parsing {}: {e}", path.display()))?;
        let ner = match parsed.ner {
            Some(cfg) => Some(std::sync::Arc::new(
                crate::ner::NerClient::from_config(cfg)
                    .map_err(|e| format!("invalid ner section in {}: {e}", path.display()))?,
            )),
            None => None,
        };
        Ok(Self {
            routes: parsed.routes,
            caller_token: parsed.caller_token,
            ner,
            ..Self::default()
        })
    }
}

pub fn resolve<'a>(cfg: &'a Config, model: &str) -> Option<&'a Route> {
    if model.is_empty() {
        return None;
    }
    let prefix = match model.split_once('/') {
        Some((p, _)) => p,
        None => "anthropic",
    };
    cfg.routes.iter().find(|r| r.prefix == prefix)
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test fixture setup, failure aborts the test"
    )]
    use super::*;

    fn fixture_config() -> Config {
        Config {
            routes: vec![
                Route {
                    prefix: "anthropic".to_string(),
                    base_url: "https://api.anthropic.com".to_string(),
                    auth: Auth::Bare(BareAuth::Passthrough),
                    provider_kind: "anthropic_oauth".to_string(),
                    provider_id: "anthropic".to_string(),
                },
                Route {
                    prefix: "openrouter".to_string(),
                    base_url: "https://openrouter.ai/api".to_string(),
                    auth: Auth::Swap {
                        env: "SPW_KEY_OPENROUTER".to_string(),
                        scheme: Scheme::Bearer,
                    },
                    provider_kind: "openrouter".to_string(),
                    provider_id: "openrouter".to_string(),
                },
                Route {
                    prefix: "local".to_string(),
                    base_url: "http://10.0.0.1:8080".to_string(),
                    auth: Auth::Swap {
                        env: "SPW_KEY_LOCAL".to_string(),
                        scheme: Scheme::None,
                    },
                    provider_kind: "local".to_string(),
                    provider_id: "local".to_string(),
                },
            ],
            usage_path: PathBuf::from("/usage/usage.jsonl"),
            ..Default::default()
        }
    }

    #[test]
    fn config_debug_redacts_caller_token() {
        let mut cfg = fixture_config();
        cfg.caller_token = Some("super-secret-caller-token".to_string());
        let dbg = format!("{cfg:?}");
        assert!(!dbg.contains("super-secret-caller-token"), "leaked: {dbg}");
        assert!(dbg.contains("[redacted]"));
    }

    #[test]
    fn anthropic_prefix_routes_to_passthrough() {
        let cfg = fixture_config();
        let r = resolve(&cfg, "claude-opus-4-8").unwrap();
        assert_eq!(r.auth, Auth::Bare(BareAuth::Passthrough));
    }

    #[test]
    fn openrouter_prefix_swaps_bearer_key() {
        let cfg = fixture_config();
        let r = resolve(&cfg, "openrouter/anthropic/claude-3.5-sonnet").unwrap();
        assert!(matches!(&r.auth, Auth::Swap { env, .. } if env == "SPW_KEY_OPENROUTER"));
    }

    #[test]
    fn unknown_prefix_returns_none() {
        assert!(resolve(&fixture_config(), "mistral/large").is_none());
    }

    #[test]
    fn bare_model_with_multiple_slashes_uses_first_segment() {
        let cfg = fixture_config();
        let r = resolve(&cfg, "openrouter/meta/llama-3/8b").unwrap();
        assert!(matches!(&r.auth, Auth::Swap { env, .. } if env == "SPW_KEY_OPENROUTER"));
    }

    #[test]
    fn empty_model_returns_none() {
        assert!(resolve(&fixture_config(), "").is_none());
    }

    #[test]
    fn route_deserializes_provider_kind_and_id() {
        let json = r#"{"routes":[{"prefix":"openrouter","base_url":"https://openrouter.ai/api","auth":{"swap_env":"SPW_KEY_OPENROUTER","scheme":"bearer"},"provider_kind":"openrouter","provider_id":"openrouter"}],"usage_path":null}"#;
        let cfg: Config = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.routes[0].provider_kind, "openrouter");
        assert_eq!(cfg.routes[0].provider_id, "openrouter");
    }

    #[test]
    fn build_forward_client_succeeds_on_primary_path() {
        let _client = build_forward_client();
    }

    #[test]
    fn build_forward_client_no_proxy_fallback_chain_builds() {
        let build = || {
            reqwest::Client::builder()
                .use_rustls_tls()
                .redirect(reqwest::redirect::Policy::none())
        };
        let result = build().no_proxy().build();
        assert!(
            result.is_ok(),
            "no_proxy() fallback chain must build a client: {:?}",
            result.err()
        );
    }

    #[test]
    fn resolve_matches_an_arbitrary_custom_prefix_not_just_known_provider_kinds() {
        let cfg = Config {
            routes: vec![Route {
                prefix: "my-or".to_string(),
                base_url: "https://openrouter.ai/api".to_string(),
                auth: Auth::Swap {
                    env: "SPW_KEY_MY_OR".to_string(),
                    scheme: Scheme::Bearer,
                },
                provider_kind: "openrouter".to_string(),
                provider_id: "my-or".to_string(),
            }],
            usage_path: PathBuf::from("/usage/usage.jsonl"),
            ..Default::default()
        };
        let r = resolve(&cfg, "my-or/anthropic/claude-sonnet-5").unwrap();
        assert!(matches!(&r.auth, Auth::Swap { env, .. } if env == "SPW_KEY_MY_OR"));
    }

    #[test]
    fn config_deserializes_from_proxy_json_format() {
        let json = r#"{
            "routes": [
                {"prefix":"anthropic","base_url":"https://api.anthropic.com","auth":"passthrough"},
                {"prefix":"openrouter","base_url":"https://openrouter.ai/api","auth":{"swap_env":"SPW_KEY_OPENROUTER","scheme":"bearer"}},
                {"prefix":"local","base_url":"http://10.0.0.1:8080","auth":{"swap_env":"SPW_KEY_LOCAL","scheme":"none"}}
            ]
        }"#;
        let cfg: Config = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.routes.len(), 3);
        assert_eq!(cfg.routes[0].auth, Auth::Bare(BareAuth::Passthrough));
        assert!(
            matches!(&cfg.routes[1].auth, Auth::Swap { env, scheme } if env == "SPW_KEY_OPENROUTER" && *scheme == Scheme::Bearer)
        );
        assert!(
            matches!(&cfg.routes[2].auth, Auth::Swap { env, scheme } if env == "SPW_KEY_LOCAL" && *scheme == Scheme::None)
        );
    }

    fn write_config(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
        let path = dir.join("proxy.json");
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn load_from_without_a_ner_section_has_no_detector() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"{"routes":[],"caller_token":"c"}"#);
        let cfg = Config::load_from(&path).unwrap();
        assert!(cfg.ner.is_none());
        assert_eq!(cfg.caller_token.as_deref(), Some("c"));
    }

    #[test]
    fn load_from_builds_the_detector_client_from_a_rendered_ner_section() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"routes":[],"ner":{"url":"http://host.docker.internal:50123","token":"t","min_confidence":0.6,"labels":["SURNAME"]}}"#,
        );
        let cfg = Config::load_from(&path).unwrap();
        assert!(cfg.ner.is_some());
        assert!(!format!("{cfg:?}").contains("\"t\""));
    }

    #[test]
    fn load_from_rejects_a_ner_url_outside_the_host_gateway() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"routes":[],"ner":{"url":"http://10.0.0.7:50123","token":"t"}}"#,
        );
        let err = Config::load_from(&path).unwrap_err().to_string();
        assert!(err.contains("invalid ner section"), "{err}");
    }
}
