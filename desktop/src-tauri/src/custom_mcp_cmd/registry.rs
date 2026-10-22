use serde_json::Value;
use speedwave_runtime::consts;
use speedwave_runtime::custom_mcp::failure;
use speedwave_runtime::custom_mcp::model;

/// Largest npm packument the review screen reads (full documents carry every version).
pub(crate) const MAX_PACKUMENT_BYTES: usize = 32 * 1024 * 1024;

const PACKUMENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const MAX_MAINTAINERS: usize = 20;
const MAX_REGISTRY_TEXT_CHARS: usize = 128;

/// What the npm registry says about one version, read host-side without running any code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RegistryFacts {
    pub(crate) published_at: String,
    pub(crate) license: Option<String>,
    pub(crate) publisher: Option<String>,
    pub(crate) maintainers: Vec<String>,
    pub(crate) provenance: bool,
    pub(crate) previous_publisher: Option<String>,
}

/// `https://registry.npmjs.org/<package>` with a scoped name's `/` escaped.
pub(crate) fn packument_url(package: &str) -> Result<String, String> {
    if !model::is_npm_package_name(package).map_err(|e| e.to_string())? {
        return Err(format!("{package:?} is not a valid npm package name"));
    }
    Ok(format!(
        "{}{}",
        consts::CUSTOM_MCP_NPM_REGISTRY,
        package.replacen('/', "%2F", 1)
    ))
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|s| s.chars().take(MAX_REGISTRY_TEXT_CHARS).collect::<String>())
        .filter(|s| !s.is_empty())
}

fn license_of(version: &Value) -> Option<String> {
    match version.get("license") {
        Some(Value::String(_)) => text(version.get("license")),
        Some(Value::Object(map)) => text(map.get("type")),
        _ => None,
    }
}

fn publisher_of(version: &Value) -> Option<String> {
    text(version.get("_npmUser").and_then(|u| u.get("name")))
}

/// Review facts of `version` from a full packument, refusing a registry integrity other than the
/// pinned one; `previous_version` (an earlier approval) supplies the publisher to compare.
pub(crate) fn parse_packument(
    doc: &Value,
    version: &str,
    pinned_integrity: &str,
    previous_version: Option<&str>,
) -> Result<RegistryFacts, String> {
    let entry = doc
        .get("versions")
        .and_then(|v| v.get(version))
        .ok_or_else(|| format!("the npm registry does not list version {version}"))?;
    let registry_integrity = entry
        .get("dist")
        .and_then(|d| d.get("integrity"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if registry_integrity != pinned_integrity {
        return Err(format!(
            "the npm registry reports another tarball integrity for version {version} than the \
             one npm pinned; refusing it"
        ));
    }
    let published_at = doc
        .get("time")
        .and_then(|t| t.get(version))
        .and_then(Value::as_str)
        .filter(|t| chrono::DateTime::parse_from_rfc3339(t).is_ok())
        .ok_or_else(|| format!("the npm registry gives no publication time for {version}"))?
        .to_string();
    let maintainers = entry
        .get("maintainers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|m| text(m.get("name")))
                .take(MAX_MAINTAINERS)
                .collect()
        })
        .unwrap_or_default();
    let previous_publisher = previous_version
        .and_then(|v| doc.get("versions").and_then(|all| all.get(v)))
        .and_then(publisher_of);
    Ok(RegistryFacts {
        published_at,
        license: license_of(entry),
        publisher: publisher_of(entry),
        maintainers,
        provenance: entry
            .get("dist")
            .and_then(|d| d.get("attestations"))
            .is_some_and(Value::is_object),
        previous_publisher,
    })
}

/// Fetches the full packument of `package` with the hardened client: no redirects, capped body.
pub(crate) async fn fetch_packument(package: &str) -> Result<Value, String> {
    let url = packument_url(package)?;
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/json"),
    );
    let resp = crate::http_util::build_hardened_client(Some(headers))?
        .get(&url)
        .timeout(PACKUMENT_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            failure::failure(
                failure::REGISTRY,
                "The npm registry could not be reached. Check the internet connection and try again",
                crate::http_util::error_chain(&e),
            )
        })?;
    let status = resp.status();
    if !status.is_success() {
        return Err(failure::failure(
            failure::REGISTRY,
            &format!("The npm registry does not know the package {package}"),
            format!("answered {status}"),
        ));
    }
    let body =
        crate::http_util::read_body_capped(resp, "npm registry", MAX_PACKUMENT_BYTES).await?;
    serde_json::from_slice(&body).map_err(|e| {
        failure::failure(
            failure::REGISTRY,
            "The npm registry sent an answer Speedwave cannot read",
            e,
        )
    })
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions use unwrap")]
mod tests {
    use super::*;

    const INTEGRITY: &str = "sha512-abc";

    fn packument() -> Value {
        serde_json::json!({
            "name": "@scope/pkg",
            "time": {"1.0.0": "2026-01-02T03:04:05.000Z", "2.0.0": "2026-09-01T00:00:00.000Z"},
            "versions": {
                "1.0.0": {
                    "license": {"type": "MIT"},
                    "_npmUser": {"name": "alice", "email": "a@example.com"},
                    "dist": {"integrity": "sha512-old"}
                },
                "2.0.0": {
                    "license": "Apache-2.0",
                    "_npmUser": {"name": "mallory", "email": "m@example.com"},
                    "maintainers": [{"name": "alice", "email": "a@example.com"}, {"name": "mallory"}],
                    "dist": {"integrity": INTEGRITY, "attestations": {"url": "https://x", "provenance": {}}}
                }
            }
        })
    }

    #[test]
    fn facts_of_a_version_and_the_previous_publisher() {
        let facts = parse_packument(&packument(), "2.0.0", INTEGRITY, Some("1.0.0")).unwrap();
        assert_eq!(facts.published_at, "2026-09-01T00:00:00.000Z");
        assert_eq!(facts.license.as_deref(), Some("Apache-2.0"));
        assert_eq!(facts.publisher.as_deref(), Some("mallory"));
        assert_eq!(facts.maintainers, vec!["alice", "mallory"]);
        assert!(facts.provenance);
        assert_eq!(facts.previous_publisher.as_deref(), Some("alice"));
        let wire = format!("{facts:?}");
        assert!(!wire.contains("@example.com"), "{wire}");
    }

    #[test]
    fn object_licenses_and_missing_provenance() {
        let mut doc = packument();
        doc["versions"]["1.0.0"]["dist"]["integrity"] = serde_json::json!(INTEGRITY);
        let facts = parse_packument(&doc, "1.0.0", INTEGRITY, None).unwrap();
        assert_eq!(facts.license.as_deref(), Some("MIT"));
        assert!(!facts.provenance);
        assert!(facts.maintainers.is_empty());
        assert!(facts.previous_publisher.is_none());
    }

    #[test]
    fn integrity_mismatch_and_missing_facts_are_refused() {
        let err = parse_packument(&packument(), "2.0.0", "sha512-other", None).unwrap_err();
        assert!(err.contains("integrity"), "{err}");
        assert!(parse_packument(&packument(), "3.0.0", INTEGRITY, None).is_err());
        let mut doc = packument();
        doc["time"]["2.0.0"] = serde_json::json!("not a date");
        assert!(parse_packument(&doc, "2.0.0", INTEGRITY, None)
            .unwrap_err()
            .contains("publication time"));
        let mut doc = packument();
        doc["time"].as_object_mut().unwrap().remove("2.0.0");
        assert!(parse_packument(&doc, "2.0.0", INTEGRITY, None).is_err());
    }

    #[test]
    fn registry_text_is_capped() {
        let mut doc = packument();
        doc["versions"]["2.0.0"]["_npmUser"]["name"] = serde_json::json!("x".repeat(1000));
        let facts = parse_packument(&doc, "2.0.0", INTEGRITY, None).unwrap();
        assert_eq!(facts.publisher.unwrap().len(), MAX_REGISTRY_TEXT_CHARS);
    }

    #[test]
    fn packument_urls_escape_the_scope_and_refuse_bad_names() {
        assert_eq!(
            packument_url("@scope/pkg").unwrap(),
            format!("{}@scope%2Fpkg", consts::CUSTOM_MCP_NPM_REGISTRY)
        );
        assert_eq!(
            packument_url("figma-developer-mcp").unwrap(),
            format!("{}figma-developer-mcp", consts::CUSTOM_MCP_NPM_REGISTRY)
        );
        for bad in ["../etc", "UPPER", "", "a b", "@scope/../x"] {
            assert!(packument_url(bad).is_err(), "{bad}");
        }
    }
}
