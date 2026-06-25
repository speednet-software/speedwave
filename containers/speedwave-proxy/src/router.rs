use serde::Deserialize;

/// How authentication is applied when forwarding to a backend.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Auth {
    /// Forward the caller's key unchanged.
    #[serde(deserialize_with = "de_passthrough")]
    Passthrough,
    /// Replace the caller's key with the value of an env var.
    Swap {
        #[serde(rename = "swap_env")]
        env: String,
        scheme: Scheme,
    },
}

fn de_passthrough<'de, D: serde::Deserializer<'de>>(d: D) -> Result<(), D::Error> {
    use serde::de::Error;
    let s = String::deserialize(d)?;
    if s == "passthrough" {
        Ok(())
    } else {
        Err(D::Error::custom(format!(
            "expected \"passthrough\", got {s:?}"
        )))
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
}

/// Top-level proxy routing configuration, deserialized from `/config/proxy.json`.
#[derive(Debug, Default, Deserialize)]
pub struct Config {
    pub routes: Vec<Route>,
}

/// Resolve a model string to its backend route.
///
/// Splits `model` on the first `/`. A bare non-empty model (no slash) uses
/// the prefix `"anthropic"`. Returns `None` for an empty model or an unknown prefix.
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
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    fn fixture_config() -> Config {
        Config {
            routes: vec![
                Route {
                    prefix: "anthropic".to_string(),
                    base_url: "https://api.anthropic.com".to_string(),
                    auth: Auth::Passthrough,
                },
                Route {
                    prefix: "openrouter".to_string(),
                    base_url: "https://openrouter.ai/api".to_string(),
                    auth: Auth::Swap {
                        env: "SPW_KEY_OPENROUTER".to_string(),
                        scheme: Scheme::Bearer,
                    },
                },
                Route {
                    prefix: "local".to_string(),
                    base_url: "http://10.0.0.1:8080".to_string(),
                    auth: Auth::Swap {
                        env: "SPW_KEY_LOCAL".to_string(),
                        scheme: Scheme::None,
                    },
                },
            ],
        }
    }

    #[test]
    fn anthropic_prefix_routes_to_passthrough() {
        let cfg = fixture_config();
        let r = resolve(&cfg, "claude-opus-4-8").unwrap();
        assert_eq!(r.auth, Auth::Passthrough);
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
        assert_eq!(cfg.routes[0].auth, Auth::Passthrough);
        assert!(
            matches!(&cfg.routes[1].auth, Auth::Swap { env, scheme } if env == "SPW_KEY_OPENROUTER" && *scheme == Scheme::Bearer)
        );
        assert!(
            matches!(&cfg.routes[2].auth, Auth::Swap { env, scheme } if env == "SPW_KEY_LOCAL" && *scheme == Scheme::None)
        );
    }
}
