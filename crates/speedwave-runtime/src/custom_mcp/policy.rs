//! Custom MCP digests and policy files: the canonical JSON and definition hash shared with the
//! TypeScript tool gate, the consent digest, and the guard `policy.json` / egress `egress.json`
//! writers.

use super::model::{self, CustomMcpEntry, CustomMcpSource, HostPort, ToolDecisionState};
use super::paths::{self, ServerSubdir};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;

const CONSENT_DIGEST_DOMAIN: &str = "speedwave.custom-mcp.consent/1";

/// Maximum UTF-8 byte length of a tool description after sanitizing (mcp-shared `MAX_DESCRIPTION_BYTES`).
pub const MAX_DESCRIPTION_BYTES: usize = 1024;

/// Guard policy schema version the guard accepts.
pub const GUARD_POLICY_VERSION: u32 = 1;

/// Default cap on a serialized tool result (mcp-shared `DEFAULT_MAX_RESULT_BYTES`).
pub const DEFAULT_MAX_RESULT_BYTES: u64 = 262_144;

/// Ceiling of `maxResultBytes` the guard accepts.
pub const MAX_RESULT_BYTES_CEILING: u64 = 16 * 1024 * 1024;

/// Largest guard policy file the guard reads (custom-guard `MAX_POLICY_BYTES`).
pub const MAX_GUARD_POLICY_BYTES: usize = 8 * 1024 * 1024;

/// Egress config schema version the egress proxy accepts.
pub const EGRESS_CONFIG_VERSION: u32 = 1;

const MAX_UPSTREAM_TOOL_NAME_BYTES: usize = 512;

fn is_stripped_description_char(c: char) -> bool {
    matches!(c,
        '\u{0}'..='\u{8}'
        | '\u{B}'..='\u{1F}'
        | '\u{7F}'..='\u{9F}'
        | '\u{61C}'
        | '\u{200B}'..='\u{200F}'
        | '\u{202A}'..='\u{202E}'
        | '\u{2060}'
        | '\u{2066}'..='\u{2069}'
        | '\u{FEFF}')
}

/// Mirrors mcp-shared `sanitizeDescription`: strips C0 controls except tab and newline, DEL, C1,
/// bidi and zero-width characters, then cuts to [`MAX_DESCRIPTION_BYTES`] on a code point boundary.
pub fn sanitize_description(description: &str) -> String {
    let mut out = String::with_capacity(description.len().min(MAX_DESCRIPTION_BYTES));
    for c in description
        .chars()
        .filter(|c| !is_stripped_description_char(*c))
    {
        if out.len() + c.len_utf8() > MAX_DESCRIPTION_BYTES {
            break;
        }
        out.push(c);
    }
    out
}

/// Mirrors mcp-shared `definitionHash`: `sha256:<hex>` over the canonical JSON of
/// `{name, description (sanitized, "" when absent), inputSchema|null, annotations|null,
/// outputSchema|null}`.
pub fn definition_hash(tool: &Value) -> anyhow::Result<String> {
    let name = tool
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("tool definition has no string name"))?;
    let description = match tool.get("description") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => sanitize_description(s),
        Some(_) => anyhow::bail!("tool definition {name:?} has a non-string description"),
    };
    let field = |key: &str| match tool.get(key) {
        None => Value::Null,
        Some(v) => v.clone(),
    };
    let document = serde_json::json!({
        "name": name,
        "description": description,
        "inputSchema": field("inputSchema"),
        "annotations": field("annotations"),
        "outputSchema": field("outputSchema"),
    });
    Ok(format!(
        "sha256:{}",
        sha256_hex(&canonical_json(&document)?)
    ))
}

/// Whether the guard talks to a containerized npm server or a host server through the relay.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GuardMode {
    /// npm package in its own container.
    Npm,
    /// HTTP server on the host.
    Host,
}

impl GuardMode {
    /// The mode a server source runs in.
    pub fn of(source: &CustomMcpSource) -> Self {
        match source {
            CustomMcpSource::Npm { .. } => Self::Npm,
            CustomMcpSource::Host { .. } => Self::Host,
        }
    }
}

/// Hub timeout class a guard policy may assign to a tool.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GuardTimeoutClass {
    /// The hub's standard timeout.
    Standard,
    /// The hub's long timeout.
    Long,
}

/// One tool of a guard policy, keyed by its upstream name.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuardToolPolicy {
    /// The user's decision.
    pub state: ToolDecisionState,
    /// `sha256:<hex>` of the definition the decision was made for.
    pub def_hash: String,
    /// Exposed name the decision was made for (mcp-shared `mapToolNames`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exposed_name: Option<String>,
    /// Approved upstream definition (`name` = the map key), served while the upstream is down.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition: Option<Value>,
    /// Hub defer-loading flag (guard default true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defer_loading: Option<bool>,
    /// Hub timeout class (guard default standard).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_class: Option<GuardTimeoutClass>,
}

/// The guard's `policy.json`, re-read by the guard on every request.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuardPolicy {
    /// Schema version, [`GUARD_POLICY_VERSION`].
    pub version: u32,
    /// Hub service id; must equal the guard's `SPW_CUSTOM_SERVER`.
    pub service: String,
    /// Upstream mode; must equal the guard's `SPW_CUSTOM_MODE`.
    pub mode: GuardMode,
    /// Consent digest of the approval (informational for the guard).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consent_digest: Option<String>,
    /// Upper bound on a serialized tool result, in bytes.
    pub max_result_bytes: u64,
    /// Tools keyed by upstream name.
    pub tools: BTreeMap<String, GuardToolPolicy>,
}

impl GuardPolicy {
    /// An empty policy for server `name` (no tools: the guard lists nothing and denies every call).
    pub fn empty(name: &str, mode: GuardMode, consent_digest: Option<String>) -> Self {
        Self {
            version: GUARD_POLICY_VERSION,
            service: model::service_id(name),
            mode,
            consent_digest,
            max_result_bytes: DEFAULT_MAX_RESULT_BYTES,
            tools: BTreeMap::new(),
        }
    }

    /// Checks everything the guard's parser checks, so a written policy is never one it rejects.
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.version != GUARD_POLICY_VERSION {
            anyhow::bail!("guard policy version must be {GUARD_POLICY_VERSION}");
        }
        let name = self
            .service
            .strip_prefix(crate::consts::CUSTOM_MCP_SERVICE_PREFIX)
            .ok_or_else(|| anyhow::anyhow!("guard policy service must be a custom- service id"))?;
        model::validate_server_name(name)?;
        if self.max_result_bytes == 0 || self.max_result_bytes > MAX_RESULT_BYTES_CEILING {
            anyhow::bail!("guard policy maxResultBytes must be in 1..={MAX_RESULT_BYTES_CEILING}");
        }
        if let Some(digest) = &self.consent_digest {
            if digest.len() != 64
                || !digest
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            {
                anyhow::bail!("guard policy consentDigest must be 64 lowercase hex characters");
            }
        }
        for (upstream, tool) in &self.tools {
            if upstream.is_empty() || upstream.len() > MAX_UPSTREAM_TOOL_NAME_BYTES {
                anyhow::bail!(
                    "guard policy tool names must be 1..={MAX_UPSTREAM_TOOL_NAME_BYTES} bytes"
                );
            }
            if !model::is_definition_hash(&tool.def_hash) {
                anyhow::bail!("guard policy tool {upstream:?} has an invalid defHash");
            }
            if let Some(exposed) = &tool.exposed_name {
                if !is_valid_tool_name(exposed) {
                    anyhow::bail!("guard policy tool {upstream:?} has an invalid exposedName");
                }
            }
            if let Some(definition) = &tool.definition {
                if definition.get("name").and_then(Value::as_str) != Some(upstream.as_str())
                    || !definition.is_object()
                {
                    anyhow::bail!(
                        "guard policy tool {upstream:?} carries a definition named differently"
                    );
                }
            }
        }
        Ok(())
    }
}

/// Mirrors mcp-shared `validateToolName`: `^[a-zA-Z0-9_-]+$`, shorter than 100 characters.
pub fn is_valid_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() < 100
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The egress proxy's `egress.json`, re-read on every CONNECT.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EgressConfig {
    /// Schema version, [`EGRESS_CONFIG_VERSION`].
    pub version: u32,
    /// Allowed `host:port` targets, sorted and deduplicated.
    pub allow: Vec<HostPort>,
}

impl EgressConfig {
    /// An egress config allowing exactly `targets`.
    pub fn new(targets: &[HostPort]) -> Self {
        let mut allow = targets.to_vec();
        allow.sort();
        allow.dedup();
        Self {
            version: EGRESS_CONFIG_VERSION,
            allow,
        }
    }
}

/// Writes `<data_dir>/custom-mcp/<project>/<name>/guard/policy.json` atomically (0o600, every
/// directory level 0o700), after checking the policy belongs to `name` and passes [`GuardPolicy::validate`].
pub fn write_guard_policy(
    data_dir: &Path,
    project: &str,
    name: &str,
    policy: &GuardPolicy,
) -> anyhow::Result<()> {
    if policy.service != model::service_id(name) {
        anyhow::bail!(
            "guard policy for {} cannot be written for server {name}",
            policy.service
        );
    }
    policy.validate()?;
    let content = serde_json::to_string_pretty(policy)?;
    if content.len() > MAX_GUARD_POLICY_BYTES {
        anyhow::bail!(
            "guard policy for {name} is {} bytes, above the {MAX_GUARD_POLICY_BYTES}-byte limit",
            content.len()
        );
    }
    let dir = paths::ensure_subdir_in(data_dir, project, name, ServerSubdir::Guard)?;
    crate::fs_perms::write_restricted_file_atomic(
        &dir.join(crate::consts::CUSTOM_MCP_GUARD_POLICY_FILE),
        &content,
    )
}

/// Reads the guard policy of server `name`: `Ok(None)` when none was written; an error for a
/// symlink, a file over [`MAX_GUARD_POLICY_BYTES`] or one [`GuardPolicy::validate`] rejects.
pub fn read_guard_policy(
    data_dir: &Path,
    project: &str,
    name: &str,
) -> anyhow::Result<Option<GuardPolicy>> {
    let path = paths::subdir_in(data_dir, project, name, ServerSubdir::Guard)?
        .join(crate::consts::CUSTOM_MCP_GUARD_POLICY_FILE);
    let Some(text) =
        crate::fs_perms::read_regular_file_no_follow_capped(&path, MAX_GUARD_POLICY_BYTES as u64)
            .map_err(|e| anyhow::anyhow!("{e}"))?
    else {
        return Ok(None);
    };
    let policy: GuardPolicy = serde_json::from_str(&text)?;
    if policy.service != model::service_id(name) {
        anyhow::bail!("the guard policy of {name} belongs to {}", policy.service);
    }
    policy.validate()?;
    Ok(Some(policy))
}

/// Writes `<data_dir>/custom-mcp/<project>/<name>/egress/egress.json` atomically (0o600, every
/// directory level 0o700).
pub fn write_egress_config(
    data_dir: &Path,
    project: &str,
    name: &str,
    config: &EgressConfig,
) -> anyhow::Result<()> {
    if config.version != EGRESS_CONFIG_VERSION {
        anyhow::bail!("egress config version must be {EGRESS_CONFIG_VERSION}");
    }
    let content = serde_json::to_string_pretty(config)?;
    let dir = paths::ensure_subdir_in(data_dir, project, name, ServerSubdir::Egress)?;
    crate::fs_perms::write_restricted_file_atomic(
        &dir.join(crate::consts::CUSTOM_MCP_EGRESS_CONFIG_FILE),
        &content,
    )
}

/// Canonical JSON byte-identical to mcp-shared `canonicalJson`: object keys sorted by code point,
/// no whitespace, strings and numbers as JavaScript `JSON.stringify` writes them.
pub fn canonical_json(value: &Value) -> anyhow::Result<String> {
    let mut out = String::new();
    encode(value, &mut out)?;
    Ok(out)
}

fn encode(value: &Value, out: &mut String) -> anyhow::Result<()> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number(n)?),
        Value::String(s) => out.push_str(&serde_json::to_string(s)?),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                encode(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key)?);
                out.push(':');
                if let Some(member) = map.get(key) {
                    encode(member, out)?;
                }
            }
            out.push('}');
        }
    }
    Ok(())
}

fn js_number(n: &serde_json::Number) -> anyhow::Result<String> {
    let x = n
        .as_f64()
        .filter(|x| x.is_finite())
        .ok_or_else(|| anyhow::anyhow!("canonical JSON cannot encode the number {n}"))?;
    Ok(format_js_number(x))
}

fn format_js_number(x: f64) -> String {
    if x == 0.0 {
        return "0".to_string();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let scientific = format!("{:e}", x.abs());
    let (mantissa, exponent) = scientific
        .split_once('e')
        .unwrap_or((scientific.as_str(), "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        let (int, frac) = digits.split_at(n as usize);
        format!("{int}.{frac}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = if e >= 0 {
            format!("+{e}")
        } else {
            e.to_string()
        };
        let (first, rest) = digits.split_at(1);
        if rest.is_empty() {
            format!("{first}e{e}")
        } else {
            format!("{first}.{rest}e{e}")
        }
    };
    format!("{sign}{body}")
}

fn sha256_hex(text: &str) -> String {
    crate::bundle::bytes_to_hex(&Sha256::digest(text.as_bytes()))
}

/// Hex sha256 the user consents to: the source (every lock field, env key names sorted; a host
/// server's port and path), `workspace_mode` and `pii_mode`. Tool decisions, egress domains,
/// `enabled` and `approved_at` stay outside, so they hot-update without a new consent.
pub fn consent_digest(entry: &CustomMcpEntry) -> anyhow::Result<String> {
    let mut source = serde_json::to_value(&entry.source)?;
    if let Some(keys) = source
        .pointer_mut("/lock/env_keys")
        .and_then(Value::as_array_mut)
    {
        keys.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    }
    let document = serde_json::json!({
        "domain": CONSENT_DIGEST_DOMAIN,
        "source": source,
        "workspace_mode": entry.workspace_mode,
        "pii_mode": entry.pii_mode,
    });
    Ok(sha256_hex(&canonical_json(&document)?))
}

/// `true` when the entry carries a consent digest equal to the one recomputed from its fields.
pub fn is_approved(entry: &CustomMcpEntry) -> bool {
    match (&entry.consent_digest, consent_digest(entry)) {
        (Some(recorded), Ok(current)) => *recorded == current,
        _ => false,
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
pub(crate) mod tests {
    use super::*;
    use crate::custom_mcp::model::{
        CustomMcpLock, CustomMcpSource, CustomPiiMode, CustomToolDecision, Ecosystem, HostPort,
        ToolDecisionState, WorkspaceMode,
    };

    const FIXTURE: &str =
        include_str!("../../../../mcp-servers/shared/test/fixtures/definition-hash.json");

    pub(crate) fn npm_entry() -> CustomMcpEntry {
        CustomMcpEntry {
            enabled: true,
            source: CustomMcpSource::Npm {
                lock: CustomMcpLock {
                    ecosystem: Ecosystem::Npm,
                    package: "figma-developer-mcp".to_string(),
                    version: "0.6.1".to_string(),
                    integrity: format!("sha512-{}", "A".repeat(86) + "=="),
                    lockfile_sha256: "a".repeat(64),
                    template_version: 1,
                    image_tag: "speedwave-mcp-custom-figma:0.6.1-0123456789abcdef".to_string(),
                    args: vec!["--stdio".to_string()],
                    env_keys: vec!["FIGMA_API_KEY".to_string(), "FIGMA_TEAM".to_string()],
                    published_at: "2026-09-01T10:00:00.000Z".to_string(),
                    before_date: "2026-10-01T10:00:00.000Z".to_string(),
                },
            },
            tools: Default::default(),
            allowed_domains: Vec::new(),
            pii_mode: CustomPiiMode::Tokens,
            workspace_mode: WorkspaceMode::None,
            proposed_by_repo: false,
            approved_at: None,
            consent_digest: None,
        }
    }

    pub(crate) fn approved(mut entry: CustomMcpEntry) -> CustomMcpEntry {
        entry.approved_at = Some("2026-10-08T10:00:00Z".to_string());
        entry.consent_digest = Some(consent_digest(&entry).unwrap());
        entry
    }

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    #[test]
    fn canonical_json_matches_every_shared_vector() {
        let fixture = fixture();
        let vectors = fixture["canonicalJson"].as_array().unwrap();
        assert!(!vectors.is_empty());
        for v in vectors {
            assert_eq!(
                canonical_json(&v["input"]).unwrap(),
                v["canonical"].as_str().unwrap(),
                "vector {}",
                v["name"]
            );
        }
    }

    #[test]
    fn canonical_json_of_definition_vectors_matches_their_documents() {
        let fixture = fixture();
        for v in fixture["definitionHash"].as_array().unwrap() {
            let canonical = v["canonical"].as_str().unwrap();
            let reparsed: Value = serde_json::from_str(canonical).unwrap();
            assert_eq!(
                canonical_json(&reparsed).unwrap(),
                canonical,
                "vector {}",
                v["name"]
            );
        }
    }

    #[test]
    fn numbers_follow_javascript_formatting() {
        for (x, expected) in [
            (1.0, "1"),
            (-0.0, "0"),
            (0.5, "0.5"),
            (-12.25, "-12.25"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1.5e21, "1.5e+21"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (-2.5e-7, "-2.5e-7"),
            (123.456, "123.456"),
            (f64::MAX, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
            (9007199254740993.0, "9007199254740992"),
        ] {
            assert_eq!(format_js_number(x), expected, "{x:e}");
        }
    }

    #[test]
    fn integers_beyond_double_precision_round_like_javascript() {
        let v: Value =
            serde_json::from_str("[18446744073709551615, -9223372036854775808]").unwrap();
        assert_eq!(
            canonical_json(&v).unwrap(),
            "[18446744073709552000,-9223372036854776000]"
        );
    }

    #[test]
    fn canonical_json_is_independent_of_key_insertion_order() {
        let mut a = serde_json::Map::new();
        a.insert("z".into(), Value::from(1));
        a.insert("a".into(), Value::from(2));
        let mut b = serde_json::Map::new();
        b.insert("a".into(), Value::from(2));
        b.insert("z".into(), Value::from(1));
        assert_eq!(
            canonical_json(&Value::Object(a)).unwrap(),
            canonical_json(&Value::Object(b)).unwrap()
        );
    }

    #[test]
    fn consent_digest_is_deterministic_hex() {
        let entry = npm_entry();
        let d = consent_digest(&entry).unwrap();
        assert_eq!(d.len(), 64);
        assert!(d
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(d, consent_digest(&entry.clone()).unwrap());
    }

    #[test]
    fn consent_digest_ignores_env_key_order() {
        let a = npm_entry();
        let mut b = npm_entry();
        if let CustomMcpSource::Npm { lock } = &mut b.source {
            lock.env_keys.reverse();
        }
        assert_eq!(consent_digest(&a).unwrap(), consent_digest(&b).unwrap());
    }

    fn mutate_lock(f: impl FnOnce(&mut CustomMcpLock)) -> CustomMcpEntry {
        let mut entry = npm_entry();
        if let CustomMcpSource::Npm { lock } = &mut entry.source {
            f(lock);
        }
        entry
    }

    #[test]
    fn every_consented_input_changes_the_digest() {
        let base = consent_digest(&npm_entry()).unwrap();
        let variants: Vec<(&str, CustomMcpEntry)> = vec![
            ("package", mutate_lock(|l| l.package = "other-mcp".into())),
            ("version", mutate_lock(|l| l.version = "0.6.2".into())),
            (
                "integrity",
                mutate_lock(|l| l.integrity = format!("sha512-{}", "B".repeat(86) + "==")),
            ),
            (
                "lockfile",
                mutate_lock(|l| l.lockfile_sha256 = "b".repeat(64)),
            ),
            ("template", mutate_lock(|l| l.template_version = 2)),
            ("image", mutate_lock(|l| l.image_tag = "x:1".into())),
            ("args", mutate_lock(|l| l.args.push("--verbose".into()))),
            (
                "args order",
                mutate_lock(|l| l.args = vec!["b".into(), "a".into()]),
            ),
            ("env key", mutate_lock(|l| l.env_keys.push("EXTRA".into()))),
            (
                "published",
                mutate_lock(|l| l.published_at = "2026-09-02T10:00:00.000Z".into()),
            ),
            (
                "before",
                mutate_lock(|l| l.before_date = "2026-10-02T10:00:00.000Z".into()),
            ),
            (
                "pii",
                CustomMcpEntry {
                    pii_mode: CustomPiiMode::Plaintext,
                    ..npm_entry()
                },
            ),
            (
                "workspace",
                CustomMcpEntry {
                    workspace_mode: WorkspaceMode::ReadOnly,
                    ..npm_entry()
                },
            ),
            (
                "host",
                CustomMcpEntry {
                    source: CustomMcpSource::Host {
                        port: 3845,
                        path: "/mcp".into(),
                    },
                    ..npm_entry()
                },
            ),
        ];
        let mut seen = std::collections::BTreeSet::new();
        seen.insert(base);
        for (what, entry) in variants {
            assert!(
                seen.insert(consent_digest(&entry).unwrap()),
                "changing {what} must change the consent digest"
            );
        }
    }

    #[test]
    fn host_port_and_path_are_both_consented() {
        let host = |port, path: &str| CustomMcpEntry {
            source: CustomMcpSource::Host {
                port,
                path: path.into(),
            },
            ..npm_entry()
        };
        let a = consent_digest(&host(3845, "/mcp")).unwrap();
        assert_ne!(a, consent_digest(&host(3846, "/mcp")).unwrap());
        assert_ne!(a, consent_digest(&host(3845, "/sse")).unwrap());
    }

    #[test]
    fn hot_updated_fields_stay_outside_the_digest() {
        let base = consent_digest(&npm_entry()).unwrap();
        let mut entry = npm_entry();
        entry.enabled = false;
        entry.proposed_by_repo = true;
        entry.approved_at = Some("2030-01-01T00:00:00Z".into());
        entry.consent_digest = Some("f".repeat(64));
        entry.allowed_domains = vec![HostPort::parse("api.figma.com:443").unwrap()];
        entry.tools.insert(
            "get_file".into(),
            CustomToolDecision {
                state: ToolDecisionState::Allowed,
                definition_hash: format!("sha256:{}", "c".repeat(64)),
            },
        );
        assert_eq!(consent_digest(&entry).unwrap(), base);
    }

    #[test]
    fn approval_requires_a_matching_recorded_digest() {
        assert!(!is_approved(&npm_entry()));
        let entry = approved(npm_entry());
        assert!(is_approved(&entry));
        let mut tampered = entry.clone();
        tampered.pii_mode = CustomPiiMode::Plaintext;
        assert!(!is_approved(&tampered));
        let mut forged = entry;
        forged.consent_digest = Some("0".repeat(64));
        assert!(!is_approved(&forged));
    }

    const GUARD_FIXTURE: &str =
        include_str!("../../../../mcp-servers/shared/test/fixtures/guard-policy.json");

    #[test]
    fn definition_hash_matches_every_shared_vector() {
        let fixture = fixture();
        let vectors = fixture["definitionHash"].as_array().unwrap();
        assert!(vectors.len() >= 8);
        for v in vectors {
            assert_eq!(
                definition_hash(&v["tool"]).unwrap(),
                v["hash"].as_str().unwrap(),
                "vector {}",
                v["name"]
            );
            let canonical: Value = serde_json::from_str(v["canonical"].as_str().unwrap()).unwrap();
            let description = canonical["description"].as_str().unwrap();
            assert_eq!(
                sanitize_description(v["tool"]["description"].as_str().unwrap_or("")),
                description,
                "vector {}",
                v["name"]
            );
        }
    }

    #[test]
    fn sanitize_strips_controls_bidi_and_zero_width_but_keeps_tab_and_newline() {
        assert_eq!(
            sanitize_description(
                "a\u{0}b\tc\nd\re\u{7f}f\u{85}g\u{202e}h\u{2066}i\u{200b}j\u{feff}k\u{61c}l"
            ),
            "ab\tc\ndefghijkl"
        );
        assert_eq!(sanitize_description(""), "");
        assert_eq!(sanitize_description("zażółć 😀"), "zażółć 😀");
    }

    #[test]
    fn sanitize_cuts_on_a_code_point_boundary_and_is_idempotent() {
        let long = format!("a{}", "€".repeat(400));
        let cut = sanitize_description(&long);
        assert_eq!(cut.len(), 1 + 341 * 3);
        assert!(cut.len() <= MAX_DESCRIPTION_BYTES);
        assert_eq!(sanitize_description(&cut), cut);
        let exact = "x".repeat(MAX_DESCRIPTION_BYTES);
        assert_eq!(sanitize_description(&exact), exact);
        let over = "x".repeat(MAX_DESCRIPTION_BYTES + 1);
        assert_eq!(sanitize_description(&over).len(), MAX_DESCRIPTION_BYTES);
    }

    #[test]
    fn definition_hash_rejects_malformed_definitions() {
        assert!(definition_hash(&serde_json::json!({"inputSchema": {}})).is_err());
        assert!(definition_hash(&serde_json::json!({"name": 1})).is_err());
        assert!(definition_hash(&serde_json::json!({"name": "x", "description": 5})).is_err());
        let null_desc =
            definition_hash(&serde_json::json!({"name": "x", "description": null})).unwrap();
        let no_desc = definition_hash(&serde_json::json!({"name": "x"})).unwrap();
        assert_eq!(null_desc, no_desc);
        assert_ne!(
            no_desc,
            definition_hash(&serde_json::json!({"name": "x", "description": "d"})).unwrap()
        );
    }

    #[test]
    fn definition_hash_covers_the_output_schema() {
        let bare = definition_hash(&serde_json::json!({"name": "x"})).unwrap();
        assert_eq!(
            definition_hash(&serde_json::json!({"name": "x", "outputSchema": null})).unwrap(),
            bare
        );
        assert_ne!(
            definition_hash(&serde_json::json!({"name": "x", "outputSchema": {"type": "object"}}))
                .unwrap(),
            bare
        );
    }

    fn fixture_policy() -> GuardPolicy {
        let fixture = fixture();
        let vectors = fixture["definitionHash"].as_array().unwrap();
        let minimal = vectors[0]["tool"].clone();
        let full = vectors[1]["tool"].clone();
        let mut policy = GuardPolicy::empty(
            "figma",
            GuardMode::Npm,
            Some("0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0".into()),
        );
        policy.tools.insert(
            "get_file".into(),
            GuardToolPolicy {
                state: ToolDecisionState::Allowed,
                def_hash: definition_hash(&minimal).unwrap(),
                exposed_name: Some("get_file".into()),
                definition: Some(minimal),
                defer_loading: Some(true),
                timeout_class: Some(GuardTimeoutClass::Standard),
            },
        );
        policy.tools.insert(
            "post_comment".into(),
            GuardToolPolicy {
                state: ToolDecisionState::Blocked,
                def_hash: definition_hash(&full).unwrap(),
                exposed_name: Some("post_comment".into()),
                definition: Some(full),
                defer_loading: None,
                timeout_class: Some(GuardTimeoutClass::Long),
            },
        );
        policy.tools.insert(
            "search".into(),
            GuardToolPolicy {
                state: ToolDecisionState::Pending,
                def_hash: "sha256:3b6f9f1a4e6c2d8b7a5e4f3c2b1a0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c"
                    .into(),
                exposed_name: None,
                definition: None,
                defer_loading: None,
                timeout_class: None,
            },
        );
        policy
    }

    #[test]
    fn guard_policy_serializes_to_the_shared_golden_fixture() {
        let golden: Value = serde_json::from_str(GUARD_FIXTURE).unwrap();
        let policy = fixture_policy();
        policy.validate().unwrap();
        assert_eq!(serde_json::to_value(&policy).unwrap(), golden);
        let parsed: GuardPolicy = serde_json::from_value(golden).unwrap();
        assert_eq!(parsed, policy);
    }

    #[test]
    fn empty_policy_lists_no_tools_and_validates() {
        let policy = GuardPolicy::empty("figma-desk", GuardMode::Host, None);
        policy.validate().unwrap();
        assert_eq!(
            serde_json::to_value(&policy).unwrap(),
            serde_json::json!({
                "version": 1,
                "service": "custom-figma-desk",
                "mode": "host",
                "maxResultBytes": 262144,
                "tools": {}
            })
        );
        assert_eq!(GuardMode::of(&npm_entry().source), GuardMode::Npm);
    }

    #[test]
    fn invalid_guard_policies_fail_validation() {
        let base = fixture_policy();
        let mut cases: Vec<(&str, GuardPolicy)> = vec![
            (
                "version",
                GuardPolicy {
                    version: 2,
                    ..base.clone()
                },
            ),
            (
                "service prefix",
                GuardPolicy {
                    service: "figma".into(),
                    ..base.clone()
                },
            ),
            (
                "service name",
                GuardPolicy {
                    service: "custom-Figma".into(),
                    ..base.clone()
                },
            ),
            (
                "result zero",
                GuardPolicy {
                    max_result_bytes: 0,
                    ..base.clone()
                },
            ),
            (
                "result ceiling",
                GuardPolicy {
                    max_result_bytes: MAX_RESULT_BYTES_CEILING + 1,
                    ..base.clone()
                },
            ),
            (
                "digest",
                GuardPolicy {
                    consent_digest: Some("XYZ".into()),
                    ..base.clone()
                },
            ),
        ];
        let mut bad_hash = base.clone();
        bad_hash.tools.get_mut("get_file").unwrap().def_hash = "sha256:ABC".into();
        cases.push(("defHash", bad_hash));
        let mut bad_exposed = base.clone();
        bad_exposed.tools.get_mut("get_file").unwrap().exposed_name = Some("get.file".into());
        cases.push(("exposedName", bad_exposed));
        let mut long_exposed = base.clone();
        long_exposed.tools.get_mut("get_file").unwrap().exposed_name = Some("a".repeat(100));
        cases.push(("exposedName length", long_exposed));
        let mut renamed = base.clone();
        renamed.tools.get_mut("get_file").unwrap().definition =
            Some(serde_json::json!({"name": "other"}));
        cases.push(("definition name", renamed));
        let mut not_object = base.clone();
        not_object.tools.get_mut("get_file").unwrap().definition = Some(serde_json::json!("x"));
        cases.push(("definition shape", not_object));
        let mut empty_key = base.clone();
        let tool = empty_key.tools.remove("search").unwrap();
        empty_key.tools.insert(String::new(), tool);
        cases.push(("empty name", empty_key));
        for (what, policy) in cases {
            assert!(policy.validate().is_err(), "{what} must be rejected");
        }
        assert!(serde_json::from_value::<GuardPolicy>(serde_json::json!({
            "version": 1, "service": "custom-a", "mode": "npm", "maxResultBytes": 1, "tools": {}, "extra": 1
        }))
        .is_err());
    }

    #[test]
    fn tool_names_follow_the_hub_rule() {
        assert!(is_valid_tool_name("get_file-2"));
        assert!(is_valid_tool_name(&"a".repeat(99)));
        for bad in ["", "a.b", "a b", "zażółć", "a/b"] {
            assert!(!is_valid_tool_name(bad), "{bad:?}");
        }
        assert!(!is_valid_tool_name(&"a".repeat(100)));
    }

    fn guard_file(data: &Path) -> std::path::PathBuf {
        data.join("custom-mcp/acme/figma/guard/policy.json")
    }

    #[test]
    fn guard_policy_is_written_where_the_guard_mount_reads_it() {
        let tmp = tempfile::tempdir().unwrap();
        let policy = fixture_policy();
        write_guard_policy(tmp.path(), "acme", "figma", &policy).unwrap();
        let written: GuardPolicy =
            serde_json::from_str(&std::fs::read_to_string(guard_file(tmp.path())).unwrap())
                .unwrap();
        assert_eq!(written, policy);
        let mut next = policy.clone();
        next.tools.get_mut("post_comment").unwrap().state = ToolDecisionState::Allowed;
        write_guard_policy(tmp.path(), "acme", "figma", &next).unwrap();
        let rewritten: GuardPolicy =
            serde_json::from_str(&std::fs::read_to_string(guard_file(tmp.path())).unwrap())
                .unwrap();
        assert_eq!(rewritten, next);
        let siblings: Vec<_> = std::fs::read_dir(guard_file(tmp.path()).parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(siblings, vec![std::ffi::OsString::from("policy.json")]);
    }

    #[test]
    fn guard_policy_reads_back_what_was_written_and_refuses_bad_files() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_guard_policy(tmp.path(), "acme", "figma")
            .unwrap()
            .is_none());
        let policy = fixture_policy();
        write_guard_policy(tmp.path(), "acme", "figma", &policy).unwrap();
        assert_eq!(
            read_guard_policy(tmp.path(), "acme", "figma").unwrap(),
            Some(policy)
        );
        std::fs::write(guard_file(tmp.path()), "{not json").unwrap();
        assert!(read_guard_policy(tmp.path(), "acme", "figma").is_err());
        let other =
            serde_json::to_string(&GuardPolicy::empty("linear", GuardMode::Npm, None)).unwrap();
        std::fs::write(guard_file(tmp.path()), other).unwrap();
        assert!(read_guard_policy(tmp.path(), "acme", "figma").is_err());
        assert!(read_guard_policy(tmp.path(), "acme", "../x").is_err());
    }

    #[test]
    fn guard_policy_writes_refuse_mismatched_or_invalid_policies() {
        let tmp = tempfile::tempdir().unwrap();
        let other = GuardPolicy::empty("linear", GuardMode::Npm, None);
        assert!(write_guard_policy(tmp.path(), "acme", "figma", &other).is_err());
        let invalid = GuardPolicy {
            max_result_bytes: 0,
            ..GuardPolicy::empty("figma", GuardMode::Npm, None)
        };
        assert!(write_guard_policy(tmp.path(), "acme", "figma", &invalid).is_err());
        assert!(write_guard_policy(
            tmp.path(),
            "../x",
            "figma",
            &GuardPolicy::empty("figma", GuardMode::Npm, None)
        )
        .is_err());
        assert!(!tmp.path().join("custom-mcp").exists());
        let mut huge = GuardPolicy::empty("figma", GuardMode::Npm, None);
        let description = "d".repeat(1000);
        for i in 0..9000 {
            huge.tools.insert(
                format!("tool_{i}"),
                GuardToolPolicy {
                    state: ToolDecisionState::Pending,
                    def_hash: format!("sha256:{}", "a".repeat(64)),
                    exposed_name: None,
                    definition: Some(serde_json::json!({"name": format!("tool_{i}"), "description": description})),
                    defer_loading: None,
                    timeout_class: None,
                },
            );
        }
        let err = write_guard_policy(tmp.path(), "acme", "figma", &huge).unwrap_err();
        assert!(err.to_string().contains("byte limit"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn policy_files_are_owner_only_and_replace_a_planted_symlink() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside.json");
        std::fs::write(&outside, "keep").unwrap();
        let guard_dir = tmp.path().join("custom-mcp/acme/figma/guard");
        std::fs::create_dir_all(&guard_dir).unwrap();
        std::os::unix::fs::symlink(&outside, guard_dir.join("policy.json")).unwrap();

        write_guard_policy(tmp.path(), "acme", "figma", &fixture_policy()).unwrap();
        let target = guard_file(tmp.path());
        let meta = std::fs::symlink_metadata(&target).unwrap();
        assert!(
            meta.file_type().is_file(),
            "the symlink must be replaced, not followed"
        );
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
        for dir in [
            "custom-mcp",
            "custom-mcp/acme",
            "custom-mcp/acme/figma",
            "custom-mcp/acme/figma/guard",
        ] {
            let mode = std::fs::metadata(tmp.path().join(dir))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o700, "{dir}");
        }

        write_egress_config(tmp.path(), "acme", "figma", &EgressConfig::new(&[])).unwrap();
        let egress = tmp.path().join("custom-mcp/acme/figma/egress/egress.json");
        assert_eq!(
            std::fs::metadata(&egress).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn egress_config_is_sorted_deduplicated_and_starts_empty() {
        let tmp = tempfile::tempdir().unwrap();
        write_egress_config(tmp.path(), "acme", "figma", &EgressConfig::new(&[])).unwrap();
        let path = tmp.path().join("custom-mcp/acme/figma/egress/egress.json");
        let empty: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(empty, serde_json::json!({"version": 1, "allow": []}));

        let targets: Vec<HostPort> = [
            "cdn.figma.com:443",
            "api.figma.com:443",
            "cdn.figma.com:443",
        ]
        .iter()
        .map(|t| HostPort::parse(t).unwrap())
        .collect();
        write_egress_config(tmp.path(), "acme", "figma", &EgressConfig::new(&targets)).unwrap();
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            written,
            serde_json::json!({"version": 1, "allow": ["api.figma.com:443", "cdn.figma.com:443"]})
        );
        let bad = EgressConfig {
            version: 2,
            allow: Vec::new(),
        };
        assert!(write_egress_config(tmp.path(), "acme", "figma", &bad).is_err());
        assert!(serde_json::from_value::<EgressConfig>(
            serde_json::json!({"version": 1, "allow": ["10.0.0.1:443"]})
        )
        .is_err());
    }
}
