use serde::Deserialize;
use std::path::PathBuf;

/// How authentication is applied when forwarding to a backend.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Auth {
    /// A bare string: `"passthrough"` (forward the caller's key unchanged) or
    /// `"none"` (drop inbound auth, inject nothing — local servers).
    #[serde(deserialize_with = "de_bare_auth")]
    Bare(BareAuth),
    /// Replace the caller's key with the value of an env var.
    Swap {
        #[serde(rename = "swap_env")]
        env: String,
        scheme: Scheme,
    },
}

/// The two string-valued auth modes.
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

/// Authorization scheme used in the forwarded request.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Scheme {
    Bearer,
    None,
}

/// One entry in the routing table.
#[derive(Debug, Deserialize)]
pub struct Route {
    pub prefix: String,
    pub base_url: String,
    pub auth: Auth,
    /// Provider kind for host-side cost attribution (ADR-073). Never sniffed
    /// in the proxy — the renderer writes it from the active provider.
    #[serde(default)]
    pub provider_kind: String,
    #[serde(default)]
    pub provider_id: String,
}

/// Top-level proxy routing config, deserialized from `/config/proxy.json`.
/// `usage_path` is resolved once at startup from `SPW_USAGE_PATH`.
#[derive(Debug, Deserialize)]
pub struct Config {
    pub routes: Vec<Route>,
    /// Per-project caller secret only the `claude` container holds; the auth
    /// middleware requires it on `/v1/*`. Absent ⇒ legacy config, checks skip.
    #[serde(default)]
    pub caller_token: Option<String>,
    #[serde(skip)]
    pub usage_path: PathBuf,
    /// Shared outbound client (cloned per request — cheap, Arc-backed). Built
    /// once with no-redirect (SSRF, ADR-041) and connection reuse.
    #[serde(skip, default = "build_forward_client")]
    pub client: reqwest::Client,
}

/// Outbound forwarding client: rustls TLS, no redirects (SSRF defence). Retries
/// once without proxy env vars on build failure, then exits fatally.
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
        }
    }
}

/// File-backed fields; `usage_path`/`client` come from env/default, not the file.
#[derive(Deserialize)]
struct RoutesFile {
    routes: Vec<Route>,
    #[serde(default)]
    caller_token: Option<String>,
}

impl Config {
    /// Load the routing table from `path`, resolving `usage_path` from
    /// `SPW_USAGE_PATH`. Unreadable or malformed file is a fatal startup error.
    pub fn load_from(path: &std::path::Path) -> Result<Self, Box<dyn std::error::Error>> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("reading {}: {e}", path.display()))?;
        let parsed: RoutesFile =
            serde_json::from_str(&raw).map_err(|e| format!("parsing {}: {e}", path.display()))?;
        Ok(Self {
            routes: parsed.routes,
            caller_token: parsed.caller_token,
            ..Self::default()
        })
    }
}

/// Resolve a model string to its backend route by its prefix (before the first
/// `/`); a bare model uses `"anthropic"`. `None` for empty/unknown prefix.
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
}
