//! Custom MCP configuration types: the user-layer server entries and the MDM-layer `custom_mcp`
//! policy, with their validation.

use crate::consts;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// How much of the project directory a Custom MCP server sees at `/workspace`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMode {
    /// No project mount.
    #[default]
    None,
    /// Project mounted read-only.
    ReadOnly,
    /// Project mounted read-write.
    ReadWrite,
}

/// Whether the hub hands a Custom MCP server PII tokens or detokenized plaintext.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CustomPiiMode {
    /// Arguments keep their PII tokens.
    #[default]
    Tokens,
    /// Arguments are detokenized before the call.
    Plaintext,
}

/// MDM-layer Custom MCP policy (presence-is-lock), validated at boot and enforced by
/// `effective::resolve_effective`.
#[derive(Serialize, Deserialize, Debug, Default, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ManagedCustomMcpConfig {
    /// Force the feature on or off.
    pub enabled: Option<bool>,
    /// Force whether HTTP servers already running on the host may be added.
    pub host_servers_enabled: Option<bool>,
    /// npm scopes (`@scope`) packages may come from.
    pub allowed_scopes: Option<Vec<String>>,
    /// Hostnames (optionally `*.`-prefixed) a server may be granted egress to.
    pub allowed_domains: Option<Vec<String>>,
    /// Upper bound on a server's `/workspace` access.
    pub max_workspace_mode: Option<WorkspaceMode>,
    /// PII mode forced on every server.
    pub force_pii_mode: Option<CustomPiiMode>,
    /// Minimum age in days of a package release before it may be pinned.
    pub min_release_age_days: Option<u32>,
}

impl ManagedCustomMcpConfig {
    /// Fail-closed shape check of every MDM-set field; the error names the field and entry.
    pub fn validate(&self) -> anyhow::Result<()> {
        for scope in self.allowed_scopes.iter().flatten() {
            if !is_npm_scope(scope)? {
                anyhow::bail!(
                    "managed custom_mcp.allowed_scopes entry {scope:?} is not an npm scope \
                     (expected '@' followed by lowercase letters, digits, '-', '.', '_' or '~')"
                );
            }
        }
        for domain in self.allowed_domains.iter().flatten() {
            if !is_domain_pattern(domain)? {
                anyhow::bail!(
                    "managed custom_mcp.allowed_domains entry {domain:?} is not a lowercase \
                     hostname (optionally prefixed with '*.'; no scheme, port, path or IP literal)"
                );
            }
        }
        if let Some(days) = self.min_release_age_days {
            if days > consts::CUSTOM_MCP_MAX_MIN_RELEASE_AGE_DAYS {
                anyhow::bail!(
                    "managed custom_mcp.min_release_age_days {days} exceeds the maximum of {}",
                    consts::CUSTOM_MCP_MAX_MIN_RELEASE_AGE_DAYS
                );
            }
        }
        Ok(())
    }
}

fn cached_regex(
    cell: &'static std::sync::OnceLock<Result<regex::Regex, regex::Error>>,
    pattern: &str,
) -> anyhow::Result<&'static regex::Regex> {
    cell.get_or_init(|| regex::Regex::new(pattern))
        .as_ref()
        .map_err(|e| anyhow::anyhow!("invalid regex {pattern}: {e}"))
}

fn is_npm_scope(scope: &str) -> anyhow::Result<bool> {
    static RE: std::sync::OnceLock<Result<regex::Regex, regex::Error>> = std::sync::OnceLock::new();
    Ok(cached_regex(&RE, r"^@[a-z0-9\-~][a-z0-9\-._~]*$")?.is_match(scope))
}

fn is_domain_pattern(pattern: &str) -> anyhow::Result<bool> {
    static LABEL: std::sync::OnceLock<Result<regex::Regex, regex::Error>> =
        std::sync::OnceLock::new();
    let label = cached_regex(&LABEL, r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")?;
    let host = pattern.strip_prefix("*.").unwrap_or(pattern);
    if host.is_empty() || host.len() > 253 || host.parse::<std::net::IpAddr>().is_ok() {
        return Ok(false);
    }
    Ok(host.split('.').all(|l| label.is_match(l)))
}

impl WorkspaceMode {
    fn rank(self) -> u8 {
        match self {
            Self::None => 0,
            Self::ReadOnly => 1,
            Self::ReadWrite => 2,
        }
    }

    /// `true` when this mode grants more project access than `limit`.
    pub fn exceeds(self, limit: WorkspaceMode) -> bool {
        self.rank() > limit.rank()
    }
}

/// Package ecosystem a pinned Custom MCP server comes from.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Ecosystem {
    /// The public npm registry.
    Npm,
}

/// Pinned package the user approved; every field is consent digest input.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct CustomMcpLock {
    /// Ecosystem of `package`.
    pub ecosystem: Ecosystem,
    /// Package name.
    pub package: String,
    /// Exact package version.
    pub version: String,
    /// Registry integrity of the package tarball (`sha512-<base64>`).
    pub integrity: String,
    /// Hex sha256 of the Speedwave-generated lockfile.
    pub lockfile_sha256: String,
    /// Version of the server image template the build uses.
    pub template_version: u32,
    /// Image tag the server builds to.
    pub image_tag: String,
    /// Arguments the server starts with.
    #[serde(default)]
    pub args: Vec<String>,
    /// Names of the credential env keys the server reads.
    #[serde(default)]
    pub env_keys: Vec<String>,
    /// Publication time of the pinned version.
    pub published_at: String,
    /// Resolver `--before` cut-off the lockfile was produced with.
    pub before_date: String,
}

/// Where a Custom MCP server runs.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CustomMcpSource {
    /// A pinned npm package run in its own container.
    Npm {
        /// The approved pin.
        lock: CustomMcpLock,
    },
    /// An HTTP MCP endpoint already running on the host, reached through the Desktop relay.
    Host {
        /// Host loopback port.
        port: u16,
        /// HTTP path of the MCP endpoint.
        path: String,
    },
}

/// The user's decision on one upstream tool.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolDecisionState {
    /// The tool may be called.
    Allowed,
    /// The tool is denied.
    Blocked,
    /// The user has not decided yet.
    Pending,
}

/// A tool decision pinned to the definition it was made for.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct CustomToolDecision {
    /// Decision state.
    pub state: ToolDecisionState,
    /// `sha256:<hex>` of the definition the decision was made for.
    pub definition_hash: String,
}

/// An egress target `host:port`; the host is a lowercase hostname, never an IP literal.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct HostPort {
    host: String,
    port: u16,
}

impl HostPort {
    /// Parses and validates `host:port`.
    pub fn parse(value: &str) -> anyhow::Result<Self> {
        let (host, port) = value
            .rsplit_once(':')
            .ok_or_else(|| anyhow::anyhow!("egress target {value:?} is not host:port"))?;
        let port: u16 = port
            .parse()
            .ok()
            .filter(|p| *p != 0 && !port.starts_with('0'))
            .ok_or_else(|| anyhow::anyhow!("egress target {value:?} has an invalid port"))?;
        if host.starts_with("*.") || !is_domain_pattern(host)? {
            anyhow::bail!("egress target {value:?} must name a lowercase hostname");
        }
        Ok(Self {
            host: host.to_string(),
            port,
        })
    }

    /// Hostname part.
    pub fn host(&self) -> &str {
        &self.host
    }

    /// Port part.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// `true` when an MDM domain pattern (`example.com` exact, `*.example.com` any subdomain) admits the host.
    pub fn matches_pattern(&self, pattern: &str) -> bool {
        match pattern.strip_prefix("*.") {
            Some(suffix) => self
                .host
                .strip_suffix(suffix)
                .is_some_and(|head| head.len() > 1 && head.ends_with('.')),
            None => self.host == pattern,
        }
    }
}

impl std::fmt::Display for HostPort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.host, self.port)
    }
}

impl TryFrom<String> for HostPort {
    type Error = anyhow::Error;
    fn try_from(value: String) -> anyhow::Result<Self> {
        Self::parse(&value)
    }
}

impl From<HostPort> for String {
    fn from(value: HostPort) -> Self {
        value.to_string()
    }
}

/// One user-approved (or proposed) Custom MCP server in `ProjectUserEntry.custom_mcp`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct CustomMcpEntry {
    /// User toggle.
    pub enabled: bool,
    /// Where the server runs.
    pub source: CustomMcpSource,
    /// Tool decisions keyed by upstream tool name (hot-updated, outside the consent digest).
    #[serde(default)]
    pub tools: BTreeMap<String, CustomToolDecision>,
    /// Approved egress targets (hot-updated, outside the consent digest).
    #[serde(default)]
    pub allowed_domains: Vec<HostPort>,
    /// PII mode of tool arguments.
    #[serde(default)]
    pub pii_mode: CustomPiiMode,
    /// Project access at `/workspace`.
    #[serde(default)]
    pub workspace_mode: WorkspaceMode,
    /// `true` when a repository file proposed the server.
    #[serde(default)]
    pub proposed_by_repo: bool,
    /// When the user approved the server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_at: Option<String>,
    /// Consent digest recorded at approval; absent means not approved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consent_digest: Option<String>,
}

/// Hub service id of a Custom MCP server name.
pub fn service_id(name: &str) -> String {
    format!("{}{name}", consts::CUSTOM_MCP_SERVICE_PREFIX)
}

const RESERVED_SERVER_NAMES: &[&str] = &["guard", consts::CUSTOM_RELAY_LOCK_DIR];

/// Validates a Custom MCP server name: `^[a-z][a-z0-9-]{0,30}$`, no trailing or doubled hyphen,
/// no `-up`/`-egress` suffix, and none of the reserved `guard`, `relay`, `relay-*`.
pub fn validate_server_name(name: &str) -> anyhow::Result<()> {
    static RE: std::sync::OnceLock<Result<regex::Regex, regex::Error>> = std::sync::OnceLock::new();
    if !cached_regex(&RE, r"^[a-z][a-z0-9-]{0,30}$")?.is_match(name) {
        anyhow::bail!(
            "custom MCP server name {name:?} must start with a lowercase letter and use at most \
             31 lowercase letters, digits or '-'"
        );
    }
    if name.ends_with('-') || name.contains("--") {
        anyhow::bail!("custom MCP server name {name:?} must not end in or double a '-'");
    }
    if name.ends_with("-up") || name.ends_with("-egress") {
        anyhow::bail!("custom MCP server name {name:?} must not end in -up or -egress");
    }
    if RESERVED_SERVER_NAMES.contains(&name)
        || name.starts_with(consts::CUSTOM_RELAY_SERVER_DIR_PREFIX)
    {
        anyhow::bail!("custom MCP server name {name:?} is reserved");
    }
    Ok(())
}

/// `true` for a valid npm package name: optional `@scope/`, lowercase URL-safe, at most 214 bytes,
/// no leading `.` or `_`.
pub fn is_npm_package_name(name: &str) -> anyhow::Result<bool> {
    static RE: std::sync::OnceLock<Result<regex::Regex, regex::Error>> = std::sync::OnceLock::new();
    let bare = cached_regex(&RE, r"^[a-z0-9\-~][a-z0-9\-._~]*$")?;
    if name.is_empty() || name.len() > 214 {
        return Ok(false);
    }
    match name.strip_prefix('@') {
        Some(scoped) => match scoped.split_once('/') {
            Some((scope, rest)) => Ok(is_npm_scope(&format!("@{scope}"))? && bare.is_match(rest)),
            None => Ok(false),
        },
        None => Ok(bare.is_match(name)),
    }
}

/// `@scope` of a scoped npm package name, `None` for an unscoped one.
pub fn npm_scope(package: &str) -> Option<&str> {
    if !package.starts_with('@') {
        return None;
    }
    package.split_once('/').map(|(scope, _)| scope)
}

/// Validates an exact semver version: no range, tag, `v` prefix or surrounding whitespace.
pub fn validate_exact_version(version: &str) -> anyhow::Result<()> {
    match semver::Version::parse(version) {
        Ok(parsed) if parsed.to_string() == version => Ok(()),
        _ => anyhow::bail!("{version:?} is not an exact semver version"),
    }
}

fn is_hex_digest(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `true` for `sha256:<64 lowercase hex>`, the definition hash form the guard accepts.
pub fn is_definition_hash(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(|hex| is_hex_digest(hex, 64))
}

/// Validates a user-supplied env name: env-shaped, and none Speedwave sets itself
/// ([`consts::RESERVED_ENV_KEYS`], the Custom MCP forbidden names and prefixes, `LD_*`, `DYLD_*`).
pub fn validate_env_key(key: &str) -> anyhow::Result<()> {
    static RE: std::sync::OnceLock<Result<regex::Regex, regex::Error>> = std::sync::OnceLock::new();
    if !cached_regex(&RE, r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")?.is_match(key) {
        anyhow::bail!("env key {key:?} is not a valid environment variable name");
    }
    let upper = key.to_ascii_uppercase();
    let reserved = consts::RESERVED_ENV_KEYS
        .iter()
        .chain(consts::CUSTOM_MCP_FORBIDDEN_ENV_KEYS)
        .any(|k| *k == upper)
        || ["LD_", "DYLD_"]
            .iter()
            .chain(consts::CUSTOM_MCP_FORBIDDEN_ENV_PREFIXES)
            .any(|p| upper.starts_with(p));
    if reserved {
        anyhow::bail!("env key {key:?} is set by Speedwave and cannot be supplied");
    }
    Ok(())
}

const MAX_ARGS: usize = 64;
const MAX_ARG_BYTES: usize = 1024;
const MAX_UPSTREAM_TOOL_NAME_BYTES: usize = 512;

fn validate_lock(lock: &CustomMcpLock) -> anyhow::Result<()> {
    if !is_npm_package_name(&lock.package)? {
        anyhow::bail!("{:?} is not a valid npm package name", lock.package);
    }
    validate_exact_version(&lock.version)?;
    if !is_sha512_integrity(&lock.integrity) {
        anyhow::bail!("package integrity must be a sha512 subresource integrity value");
    }
    if !is_hex_digest(&lock.lockfile_sha256, 64) {
        anyhow::bail!("lockfile_sha256 must be 64 lowercase hex characters");
    }
    for (field, value) in [
        ("image_tag", &lock.image_tag),
        ("published_at", &lock.published_at),
        ("before_date", &lock.before_date),
    ] {
        if value.is_empty()
            || value.len() > 256
            || value.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            anyhow::bail!("lock field {field} is empty, too long or contains whitespace");
        }
    }
    if lock.args.len() > MAX_ARGS {
        anyhow::bail!("a server takes at most {MAX_ARGS} arguments");
    }
    if lock
        .args
        .iter()
        .any(|a| a.len() > MAX_ARG_BYTES || a.chars().any(char::is_control))
    {
        anyhow::bail!(
            "server arguments must be at most {MAX_ARG_BYTES} bytes without control characters"
        );
    }
    let mut seen = std::collections::BTreeSet::new();
    for key in &lock.env_keys {
        validate_env_key(key)?;
        if !seen.insert(key.to_ascii_uppercase()) {
            anyhow::bail!("env key {key:?} is listed twice");
        }
    }
    Ok(())
}

/// `true` for a `sha512-<base64 of 64 bytes>` subresource integrity value.
pub fn is_sha512_integrity(value: &str) -> bool {
    use base64::Engine;
    value.strip_prefix("sha512-").is_some_and(|b64| {
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .is_ok_and(|bytes| bytes.len() == 64)
    })
}

/// Validates a host server's endpoint: port 1..=65535, path starting with `/` without query,
/// fragment or whitespace.
pub fn validate_host_endpoint(port: u16, path: &str) -> anyhow::Result<()> {
    if port == 0 {
        anyhow::bail!("host server port must be between 1 and 65535");
    }
    if !path.starts_with('/')
        || path.len() > 1024
        || path
            .chars()
            .any(|c| c == '?' || c == '#' || c.is_whitespace() || c.is_control())
    {
        anyhow::bail!(
            "host server path must start with '/' and contain no '?', '#', whitespace or control \
             characters"
        );
    }
    Ok(())
}

impl CustomMcpEntry {
    /// Validates every field of the entry stored under `name`; the error names the first problem.
    pub fn validate(&self, name: &str) -> anyhow::Result<()> {
        validate_server_name(name)?;
        match &self.source {
            CustomMcpSource::Npm { lock } => validate_lock(lock)?,
            CustomMcpSource::Host { port, path } => validate_host_endpoint(*port, path)?,
        }
        for (tool, decision) in &self.tools {
            if tool.is_empty() || tool.len() > MAX_UPSTREAM_TOOL_NAME_BYTES {
                anyhow::bail!("tool names must be 1..={MAX_UPSTREAM_TOOL_NAME_BYTES} bytes");
            }
            if !is_definition_hash(&decision.definition_hash) {
                anyhow::bail!("tool {tool:?} has an invalid definition hash");
            }
        }
        if let Some(digest) = &self.consent_digest {
            if !is_hex_digest(digest, 64) {
                anyhow::bail!("consent_digest must be 64 lowercase hex characters");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    fn with_scopes(scopes: &[&str]) -> ManagedCustomMcpConfig {
        ManagedCustomMcpConfig {
            allowed_scopes: Some(scopes.iter().map(|s| s.to_string()).collect()),
            ..Default::default()
        }
    }

    fn with_domains(domains: &[&str]) -> ManagedCustomMcpConfig {
        ManagedCustomMcpConfig {
            allowed_domains: Some(domains.iter().map(|s| s.to_string()).collect()),
            ..Default::default()
        }
    }

    #[test]
    fn empty_policy_is_valid() {
        assert!(ManagedCustomMcpConfig::default().validate().is_ok());
        assert!(with_scopes(&[]).validate().is_ok());
        assert!(with_domains(&[]).validate().is_ok());
    }

    #[test]
    fn enums_use_snake_case_wire_names() {
        let modes: Vec<WorkspaceMode> =
            serde_json::from_str(r#"["none","read_only","read_write"]"#).unwrap();
        assert_eq!(
            modes,
            vec![
                WorkspaceMode::None,
                WorkspaceMode::ReadOnly,
                WorkspaceMode::ReadWrite
            ]
        );
        let pii: Vec<CustomPiiMode> = serde_json::from_str(r#"["tokens","plaintext"]"#).unwrap();
        assert_eq!(pii, vec![CustomPiiMode::Tokens, CustomPiiMode::Plaintext]);
        assert!(serde_json::from_str::<WorkspaceMode>(r#""ReadWrite""#).is_err());
        assert!(serde_json::from_str::<WorkspaceMode>(r#""rw""#).is_err());
        assert!(serde_json::from_str::<CustomPiiMode>(r#""Tokens""#).is_err());
    }

    #[test]
    fn valid_scopes_pass() {
        assert!(
            with_scopes(&["@acme", "@a", "@0x", "@my-org", "@org.name_x~y", "@~tilde"])
                .validate()
                .is_ok()
        );
    }

    #[test]
    fn invalid_scopes_fail_naming_the_field() {
        for bad in [
            "",
            "@",
            "acme",
            "@Acme",
            "@.acme",
            "@_acme",
            "@acme/pkg",
            "@ac me",
            " @acme",
            "@acme\n",
            "@acme\u{7}",
            "@zażółć",
            "@acme*",
        ] {
            let err = with_scopes(&["@ok", bad])
                .validate()
                .unwrap_err()
                .to_string();
            assert!(
                err.contains("custom_mcp.allowed_scopes"),
                "scope {bad:?} must fail naming the field, got: {err}"
            );
        }
    }

    #[test]
    fn scope_error_escapes_control_characters() {
        let err = with_scopes(&["@a\r\nb"])
            .validate()
            .unwrap_err()
            .to_string();
        assert!(!err.contains('\r') && !err.contains('\n'), "got: {err:?}");
    }

    #[test]
    fn valid_domains_pass() {
        let max_label = "a".repeat(63);
        let long_host = [max_label.as_str(); 3].join(".") + ".abcdefghijklmnopqrstuvwxyz";
        assert!(long_host.len() <= 253);
        assert!(with_domains(&[
            "example.com",
            "*.example.com",
            "api.github.com",
            "localhost",
            "xn--zcaa.pl",
            "a-b.c0",
            max_label.as_str(),
            long_host.as_str(),
        ])
        .validate()
        .is_ok());
    }

    #[test]
    fn invalid_domains_fail_naming_the_field() {
        let too_long_label = "a".repeat(64);
        let max_label = "a".repeat(63);
        let too_long_host = [max_label.as_str(); 4].join(".") + ".com";
        for bad in [
            "",
            "*.",
            "*",
            "*example.com",
            "a.*.example.com",
            "**.example.com",
            "Example.com",
            "https://example.com",
            "example.com:443",
            "example.com/path",
            "user@example.com",
            "example..com",
            ".example.com",
            "example.com.",
            "-example.com",
            "example-.com",
            "exa mple.com",
            "example.com\n",
            "zażółć.pl",
            "10.0.0.1",
            "*.10.0.0.1",
            "::1",
            "[::1]",
            too_long_label.as_str(),
            too_long_host.as_str(),
        ] {
            let err = with_domains(&["ok.example", bad])
                .validate()
                .unwrap_err()
                .to_string();
            assert!(
                err.contains("custom_mcp.allowed_domains"),
                "domain {bad:?} must fail naming the field, got: {err}"
            );
        }
    }

    #[test]
    fn release_age_is_bounded() {
        let at = |days| ManagedCustomMcpConfig {
            min_release_age_days: Some(days),
            ..Default::default()
        };
        assert!(at(0).validate().is_ok());
        assert!(at(consts::CUSTOM_MCP_MAX_MIN_RELEASE_AGE_DAYS)
            .validate()
            .is_ok());
        let err = at(consts::CUSTOM_MCP_MAX_MIN_RELEASE_AGE_DAYS + 1)
            .validate()
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("custom_mcp.min_release_age_days"),
            "got: {err}"
        );
        assert!(at(u32::MAX).validate().is_err());
    }

    #[test]
    fn first_invalid_field_fails_even_when_others_are_valid() {
        let cfg = ManagedCustomMcpConfig {
            enabled: Some(true),
            host_servers_enabled: Some(false),
            allowed_scopes: Some(vec!["@acme".into()]),
            allowed_domains: Some(vec!["api.example.com".into()]),
            max_workspace_mode: Some(WorkspaceMode::ReadOnly),
            force_pii_mode: Some(CustomPiiMode::Tokens),
            min_release_age_days: Some(4000),
        };
        let err = cfg.validate().unwrap_err().to_string();
        assert!(err.contains("min_release_age_days"), "got: {err}");
    }

    fn entry() -> CustomMcpEntry {
        crate::custom_mcp::policy::tests::npm_entry()
    }

    fn with_lock(f: impl FnOnce(&mut CustomMcpLock)) -> CustomMcpEntry {
        let mut e = entry();
        if let CustomMcpSource::Npm { lock } = &mut e.source {
            f(lock);
        }
        e
    }

    #[test]
    fn server_names_follow_the_service_id_rules() {
        let max = format!("a{}", "b".repeat(30));
        for ok in ["figma", "a", "figma-desk", "f1", "a-b-c", max.as_str()] {
            assert!(validate_server_name(ok).is_ok(), "{ok}");
        }
        let too_long = format!("a{}", "b".repeat(31));
        for bad in [
            "",
            "1figma",
            "-figma",
            "Figma",
            "fig_ma",
            "fig.ma",
            "figma-",
            "fig--ma",
            "figma-up",
            "figma-egress",
            "zażółć",
            "figma\n",
            too_long.as_str(),
        ] {
            assert!(validate_server_name(bad).is_err(), "{bad:?}");
        }
        assert!(validate_server_name("up").is_ok());
        assert!(validate_server_name("egress").is_ok());
        assert!(validate_server_name("guards").is_ok());
        assert!(validate_server_name("my-guard").is_ok());
        assert!(validate_server_name("relayed").is_ok());
        for reserved in ["guard", "relay", "relay-port", "relay-figma"] {
            let err = validate_server_name(reserved).unwrap_err().to_string();
            assert!(err.contains("reserved"), "{reserved}: {err}");
        }
        assert_eq!(service_id("figma"), "custom-figma");
    }

    #[test]
    fn npm_package_names_follow_npm_rules() {
        let long = "a".repeat(214);
        for ok in [
            "figma-developer-mcp",
            "@acme/mcp",
            "@a/b",
            "a.b_c~d",
            long.as_str(),
        ] {
            assert!(is_npm_package_name(ok).unwrap(), "{ok}");
        }
        let too_long = "a".repeat(215);
        for bad in [
            "",
            ".hidden",
            "_private",
            "Upper",
            "@acme",
            "@acme/",
            "@/pkg",
            "@Acme/pkg",
            "a b",
            "a/b",
            "@a/b/c",
            "pkg?x",
            "../pkg",
            "zażółć",
            too_long.as_str(),
        ] {
            assert!(!is_npm_package_name(bad).unwrap(), "{bad:?}");
        }
        assert_eq!(npm_scope("@acme/mcp"), Some("@acme"));
        assert_eq!(npm_scope("mcp"), None);
        assert_eq!(npm_scope("@broken"), None);
    }

    #[test]
    fn only_exact_versions_pass() {
        for ok in ["0.6.1", "1.0.0-beta.1", "2.0.0+build.5", "10.20.30"] {
            assert!(validate_exact_version(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "latest",
            "^1.0.0",
            "~1.0.0",
            "1.x",
            "1",
            "1.0",
            "v1.0.0",
            "=1.0.0",
            ">=1.0.0",
            " 1.0.0",
            "1.0.0 ",
            "1.0.0 || 2.0.0",
            "01.0.0",
        ] {
            assert!(validate_exact_version(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn host_ports_parse_and_round_trip_as_strings() {
        let hp = HostPort::parse("api.figma.com:443").unwrap();
        assert_eq!((hp.host(), hp.port()), ("api.figma.com", 443));
        assert_eq!(
            serde_json::to_value(&hp).unwrap(),
            serde_json::json!("api.figma.com:443")
        );
        let back: HostPort =
            serde_json::from_value(serde_json::json!("api.figma.com:443")).unwrap();
        assert_eq!(back, hp);
        for bad in [
            "api.figma.com",
            "api.figma.com:",
            "api.figma.com:0",
            "api.figma.com:65536",
            "api.figma.com:0443",
            "api.figma.com:-1",
            "*.figma.com:443",
            "10.0.0.1:443",
            "[::1]:443",
            "API.figma.com:443",
            ":443",
            "a b:443",
        ] {
            assert!(HostPort::parse(bad).is_err(), "{bad:?}");
            assert!(serde_json::from_value::<HostPort>(serde_json::json!(bad)).is_err());
        }
    }

    #[test]
    fn domain_patterns_match_exact_hosts_or_strict_subdomains() {
        let hp = HostPort::parse("api.figma.com:443").unwrap();
        assert!(hp.matches_pattern("api.figma.com"));
        assert!(hp.matches_pattern("*.figma.com"));
        assert!(!hp.matches_pattern("figma.com"));
        assert!(!hp.matches_pattern("*.api.figma.com"));
        let apex = HostPort::parse("figma.com:443").unwrap();
        assert!(!apex.matches_pattern("*.figma.com"));
        let lookalike = HostPort::parse("evilfigma.com:443").unwrap();
        assert!(!lookalike.matches_pattern("*.figma.com"));
    }

    #[test]
    fn workspace_modes_are_ordered_by_access() {
        assert!(WorkspaceMode::ReadWrite.exceeds(WorkspaceMode::ReadOnly));
        assert!(WorkspaceMode::ReadOnly.exceeds(WorkspaceMode::None));
        assert!(!WorkspaceMode::ReadOnly.exceeds(WorkspaceMode::ReadOnly));
        assert!(!WorkspaceMode::None.exceeds(WorkspaceMode::ReadWrite));
        assert_eq!(WorkspaceMode::default(), WorkspaceMode::None);
        assert_eq!(CustomPiiMode::default(), CustomPiiMode::Tokens);
    }

    #[test]
    fn a_valid_entry_validates() {
        assert!(entry().validate("figma").is_ok());
        let host = CustomMcpEntry {
            source: CustomMcpSource::Host {
                port: 3845,
                path: "/mcp".into(),
            },
            ..entry()
        };
        assert!(host.validate("figma-desk").is_ok());
    }

    #[test]
    fn invalid_entries_fail_validation() {
        let cases: Vec<(&str, CustomMcpEntry)> = vec![
            ("package", with_lock(|l| l.package = "Bad".into())),
            ("version", with_lock(|l| l.version = "^1.0.0".into())),
            (
                "integrity sha1",
                with_lock(|l| l.integrity = "sha1-AAAA".into()),
            ),
            (
                "integrity length",
                with_lock(|l| l.integrity = "sha512-AAAA".into()),
            ),
            (
                "lockfile",
                with_lock(|l| l.lockfile_sha256 = "A".repeat(64)),
            ),
            ("image", with_lock(|l| l.image_tag = String::new())),
            ("before", with_lock(|l| l.before_date = "2026 10 01".into())),
            ("arg control", with_lock(|l| l.args = vec!["a\nb".into()])),
            ("arg size", with_lock(|l| l.args = vec!["a".repeat(1025)])),
            ("arg count", with_lock(|l| l.args = vec!["a".into(); 65])),
            ("env shape", with_lock(|l| l.env_keys = vec!["1BAD".into()])),
            (
                "env reserved",
                with_lock(|l| l.env_keys = vec!["node_options".into()]),
            ),
            (
                "env proxy",
                with_lock(|l| l.env_keys = vec!["HTTPS_PROXY".into()]),
            ),
            (
                "env npm",
                with_lock(|l| l.env_keys = vec!["NPM_CONFIG_REGISTRY".into()]),
            ),
            (
                "env ld",
                with_lock(|l| l.env_keys = vec!["LD_DEBUG".into()]),
            ),
            (
                "env spw",
                with_lock(|l| l.env_keys = vec!["SPW_LAUNCHER_ENTRY".into()]),
            ),
            (
                "env dup",
                with_lock(|l| l.env_keys = vec!["KEY".into(), "key".into()]),
            ),
            (
                "host port",
                CustomMcpEntry {
                    source: CustomMcpSource::Host {
                        port: 0,
                        path: "/".into(),
                    },
                    ..entry()
                },
            ),
            (
                "host query",
                CustomMcpEntry {
                    source: CustomMcpSource::Host {
                        port: 1,
                        path: "/mcp?x=1".into(),
                    },
                    ..entry()
                },
            ),
            (
                "host fragment",
                CustomMcpEntry {
                    source: CustomMcpSource::Host {
                        port: 1,
                        path: "/mcp#x".into(),
                    },
                    ..entry()
                },
            ),
            (
                "host relative",
                CustomMcpEntry {
                    source: CustomMcpSource::Host {
                        port: 1,
                        path: "mcp".into(),
                    },
                    ..entry()
                },
            ),
            (
                "host crlf",
                CustomMcpEntry {
                    source: CustomMcpSource::Host {
                        port: 1,
                        path: "/mcp\r\nX: y".into(),
                    },
                    ..entry()
                },
            ),
            (
                "host space",
                CustomMcpEntry {
                    source: CustomMcpSource::Host {
                        port: 1,
                        path: "/m cp".into(),
                    },
                    ..entry()
                },
            ),
            (
                "digest",
                CustomMcpEntry {
                    consent_digest: Some("xyz".into()),
                    ..entry()
                },
            ),
        ];
        for (what, e) in cases {
            assert!(e.validate("figma").is_err(), "{what} must be rejected");
        }
        let mut bad_tool = entry();
        bad_tool.tools.insert(
            "get".into(),
            CustomToolDecision {
                state: ToolDecisionState::Allowed,
                definition_hash: "sha256:ABC".into(),
            },
        );
        assert!(bad_tool.validate("figma").is_err());
        let mut empty_tool = entry();
        empty_tool.tools.insert(
            String::new(),
            CustomToolDecision {
                state: ToolDecisionState::Pending,
                definition_hash: format!("sha256:{}", "a".repeat(64)),
            },
        );
        assert!(empty_tool.validate("figma").is_err());
        assert!(entry().validate("figma-up").is_err());
    }

    #[test]
    fn entry_wire_shape_is_tagged_and_tolerates_unknown_fields() {
        let json = serde_json::json!({
            "enabled": true,
            "source": {"kind": "host", "port": 3845, "path": "/mcp", "future": 1},
            "tools": {"get_file": {"state": "allowed", "definition_hash": format!("sha256:{}", "a".repeat(64))}},
            "allowed_domains": ["api.figma.com:443"],
            "future_field": {"x": 1}
        });
        let parsed: CustomMcpEntry = serde_json::from_value(json).unwrap();
        assert_eq!(
            parsed.source,
            CustomMcpSource::Host {
                port: 3845,
                path: "/mcp".into()
            }
        );
        assert_eq!(parsed.pii_mode, CustomPiiMode::Tokens);
        assert_eq!(parsed.workspace_mode, WorkspaceMode::None);
        assert!(!parsed.proposed_by_repo);
        assert!(parsed.consent_digest.is_none());
        let out = serde_json::to_value(&parsed).unwrap();
        assert_eq!(out["source"]["kind"], "host");
        assert_eq!(out["tools"]["get_file"]["state"], "allowed");
        assert!(out.get("consent_digest").is_none());
        let npm = serde_json::to_value(entry()).unwrap();
        assert_eq!(npm["source"]["kind"], "npm");
        assert_eq!(npm["source"]["lock"]["ecosystem"], "npm");
        assert!(serde_json::from_value::<CustomMcpEntry>(
            serde_json::json!({"enabled": true, "source": {"kind": "pypi"}})
        )
        .is_err());
        assert!(serde_json::from_value::<CustomMcpEntry>(serde_json::json!({
            "enabled": true,
            "source": {"kind": "host", "port": 70000, "path": "/"}
        }))
        .is_err());
    }
}
