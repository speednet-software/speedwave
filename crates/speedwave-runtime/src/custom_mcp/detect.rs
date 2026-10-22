//! Reads a repository's `.mcp.json` into Custom MCP proposals: nothing runs, no `${VAR}` is
//! expanded, env values are never read back, and every repository string is length-capped.

use super::model;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

/// File name a repository proposes MCP servers in.
pub const MCP_JSON_FILE: &str = ".mcp.json";

/// Largest `.mcp.json` the scan reads.
pub const MAX_MCP_JSON_BYTES: u64 = 64 * 1024;

/// Most proposals one scan returns; further entries are ignored.
pub const MAX_PROPOSALS: usize = 64;

/// Longest repository string (key, argument, command, host) a proposal carries, in characters.
pub const MAX_TEXT_CHARS: usize = 256;

const MAX_ARGS: usize = 64;
const MAX_ENV_KEYS: usize = 64;

const BUILT_IN_NPM_PACKAGES: &[(&str, &str)] = &[
    ("@modelcontextprotocol/server-github", "github"),
    ("@modelcontextprotocol/server-gitlab", "gitlab"),
    ("@modelcontextprotocol/server-slack", "slack"),
    ("@playwright/mcp", "playwright"),
    ("@upstash/context7-mcp", "context7"),
];

/// What a `.mcp.json` entry asks to run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProposalSource {
    /// `npx <package>[@<version>]`.
    Npm {
        /// npm package name.
        package: String,
        /// Exact version, `None` when the entry names no exact version.
        version: Option<String>,
    },
    /// A remote HTTP server (`url`), not supported in this phase.
    Remote {
        /// Host of the URL only; the path and query may carry credentials.
        host: String,
    },
    /// Anything else.
    Unsupported {
        /// The command the entry runs, length-capped.
        command: String,
    },
}

/// Whether a proposal can go to review as is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    /// An npm package with an exact version.
    Ready,
    /// An npm package without an exact version; the user picks one.
    NeedsExactVersion,
    /// A remote server; unsupported for now.
    Remote,
    /// Neither npm nor remote.
    Unsupported,
}

/// One server a repository proposes. Every string is repository text: untrusted, length-capped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Proposal {
    /// The `mcpServers` key.
    pub key: String,
    /// A valid server name derived from the key, if one can be.
    pub suggested_name: Option<String>,
    /// What the entry runs.
    pub source: ProposalSource,
    /// Readiness for review.
    pub status: ProposalStatus,
    /// Server arguments after the package, as written (never expanded).
    pub args: Vec<String>,
    /// Valid env names the entry sets; values are never read back.
    pub env_keys: Vec<String>,
    /// Env names refused because Speedwave sets them or they are malformed.
    pub refused_env_keys: Vec<String>,
    /// A built-in integration that covers the same package.
    pub builtin_integration: Option<String>,
    /// Why the entry cannot be used as is, when it cannot.
    pub reason: Option<String>,
}

fn cap(text: &str) -> String {
    text.chars().take(MAX_TEXT_CHARS).collect()
}

/// Reads `<project_dir>/.mcp.json`: `Ok(empty)` when absent; refuses a symlink, a non-file and a
/// file over [`MAX_MCP_JSON_BYTES`].
pub fn scan_project_dir(project_dir: &Path) -> anyhow::Result<Vec<Proposal>> {
    let path = project_dir.join(MCP_JSON_FILE);
    match crate::fs_perms::read_regular_file_no_follow_capped(&path, MAX_MCP_JSON_BYTES) {
        Ok(None) => Ok(Vec::new()),
        Ok(Some(text)) => parse_mcp_json(&text),
        Err(e) => anyhow::bail!("{MCP_JSON_FILE} cannot be read: {e}"),
    }
}

/// Parses `.mcp.json` text into proposals in key order.
pub fn parse_mcp_json(text: &str) -> anyhow::Result<Vec<Proposal>> {
    let doc: Value = serde_json::from_str(text)
        .map_err(|e| anyhow::anyhow!("{MCP_JSON_FILE} is not valid JSON: {e}"))?;
    let servers = match doc.get("mcpServers") {
        None => return Ok(Vec::new()),
        Some(Value::Object(map)) => map,
        Some(_) => anyhow::bail!("{MCP_JSON_FILE} mcpServers must be an object"),
    };
    let mut keys: Vec<&String> = servers.keys().collect();
    keys.sort();
    Ok(keys
        .into_iter()
        .take(MAX_PROPOSALS)
        .filter_map(|key| servers.get(key).map(|entry| proposal_for(key, entry)))
        .collect())
}

fn suggested_name(key: &str) -> Option<String> {
    let mut name = String::new();
    for c in key.chars().flat_map(char::to_lowercase) {
        let c = if c.is_ascii_lowercase() || c.is_ascii_digit() {
            c
        } else {
            '-'
        };
        if c == '-' && (name.is_empty() || name.ends_with('-')) {
            continue;
        }
        name.push(c);
    }
    let name = name.trim_start_matches(|c: char| c.is_ascii_digit() || c == '-');
    let name: String = name.chars().take(31).collect();
    let name = name.trim_end_matches('-').to_string();
    model::validate_server_name(&name).ok().map(|()| name)
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .take(MAX_ARGS)
                .map(cap)
                .collect()
        })
        .unwrap_or_default()
}

fn env_keys(entry: &Value) -> (Vec<String>, Vec<String>) {
    let mut accepted = Vec::new();
    let mut refused = Vec::new();
    let Some(env) = entry.get("env").and_then(Value::as_object) else {
        return (accepted, refused);
    };
    for key in env.keys().take(MAX_ENV_KEYS) {
        if model::validate_env_key(key).is_ok() {
            accepted.push(key.clone());
        } else {
            refused.push(cap(key));
        }
    }
    (accepted, refused)
}

fn split_package_spec(spec: &str) -> (&str, Option<&str>) {
    let search_from = usize::from(spec.starts_with('@'));
    match spec[search_from..].find('@') {
        Some(at) => {
            let at = at + search_from;
            (&spec[..at], Some(&spec[at + 1..]))
        }
        None => (spec, None),
    }
}

fn is_npx(command: &str) -> bool {
    let base = command.rsplit(['/', '\\']).next().unwrap_or(command);
    matches!(base, "npx" | "npx.cmd")
}

fn builtin_for(package: &str) -> Option<String> {
    BUILT_IN_NPM_PACKAGES
        .iter()
        .find(|(p, _)| *p == package)
        .map(|(_, key)| (*key).to_string())
}

fn proposal_for(key: &str, entry: &Value) -> Proposal {
    let (env_keys, refused_env_keys) = env_keys(entry);
    let mut proposal = Proposal {
        key: cap(key),
        suggested_name: suggested_name(key),
        source: ProposalSource::Unsupported {
            command: String::new(),
        },
        status: ProposalStatus::Unsupported,
        args: Vec::new(),
        env_keys,
        refused_env_keys,
        builtin_integration: None,
        reason: None,
    };
    if let Some(url) = entry.get("url").and_then(Value::as_str) {
        let host = url::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(cap))
            .unwrap_or_default();
        proposal.source = ProposalSource::Remote { host };
        proposal.status = ProposalStatus::Remote;
        proposal.reason = Some("remote MCP servers are not supported yet".to_string());
        return proposal;
    }
    let command = entry.get("command").and_then(Value::as_str).unwrap_or("");
    proposal.source = ProposalSource::Unsupported {
        command: cap(command),
    };
    if !is_npx(command) {
        proposal.reason = Some(if command.is_empty() {
            "the entry names neither a command nor a url".to_string()
        } else {
            "only npm packages started with npx are supported".to_string()
        });
        return proposal;
    }
    let args = string_list(entry.get("args"));
    let mut rest = args
        .iter()
        .skip_while(|a| matches!(a.as_str(), "-y" | "--yes" | "-q" | "--quiet"));
    let Some(spec) = rest.next() else {
        proposal.reason = Some("npx is given no package".to_string());
        return proposal;
    };
    if spec.starts_with('-') {
        proposal.reason = Some(format!("npx option {spec:?} is not supported"));
        return proposal;
    }
    let (package, version) = split_package_spec(spec);
    if !model::is_npm_package_name(package).unwrap_or(false) {
        proposal.reason = Some(format!("{package:?} is not a valid npm package name"));
        return proposal;
    }
    let exact = version.filter(|v| model::validate_exact_version(v).is_ok());
    proposal.status = if exact.is_some() {
        ProposalStatus::Ready
    } else {
        ProposalStatus::NeedsExactVersion
    };
    proposal.source = ProposalSource::Npm {
        package: package.to_string(),
        version: exact.map(str::to_string),
    };
    proposal.args = rest.cloned().collect();
    proposal.builtin_integration = builtin_for(package);
    proposal
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    fn one(json: &str) -> Proposal {
        let mut all = parse_mcp_json(json).unwrap();
        assert_eq!(all.len(), 1, "{all:?}");
        all.remove(0)
    }

    #[test]
    fn npx_with_an_exact_version_is_ready() {
        let p = one(
            r#"{"mcpServers":{"Figma":{"command":"npx","args":["-y","figma-developer-mcp@0.6.1","--stdio"],"env":{"FIGMA_API_KEY":"secret-value"}}}}"#,
        );
        assert_eq!(p.key, "Figma");
        assert_eq!(p.suggested_name.as_deref(), Some("figma"));
        assert_eq!(
            p.source,
            ProposalSource::Npm {
                package: "figma-developer-mcp".to_string(),
                version: Some("0.6.1".to_string())
            }
        );
        assert_eq!(p.status, ProposalStatus::Ready);
        assert_eq!(p.args, vec!["--stdio".to_string()]);
        assert_eq!(p.env_keys, vec!["FIGMA_API_KEY".to_string()]);
        assert!(p.reason.is_none());
    }

    #[test]
    fn env_values_are_never_returned() {
        let json = r#"{"mcpServers":{"x":{"command":"npx","args":["pkg@1.0.0"],"env":{"TOKEN_A":"sk-live-very-secret","B":"${HOME}"}}}}"#;
        let p = one(json);
        let wire = serde_json::to_string(&p).unwrap();
        assert!(!wire.contains("sk-live-very-secret"), "{wire}");
        assert!(!wire.contains("${HOME}"), "{wire}");
        assert_eq!(p.env_keys, vec!["B".to_string(), "TOKEN_A".to_string()]);
    }

    #[test]
    fn variables_in_arguments_are_kept_verbatim() {
        let p = one(
            r#"{"mcpServers":{"x":{"command":"npx","args":["pkg@1.0.0","--token","${API_TOKEN}","$HOME/x"]}}}"#,
        );
        assert_eq!(p.args, vec!["--token", "${API_TOKEN}", "$HOME/x"]);
    }

    #[test]
    fn scoped_packages_and_missing_versions() {
        let p = one(r#"{"mcpServers":{"lin":{"command":"npx","args":["@linear/mcp@1.2.3"]}}}"#);
        assert_eq!(
            p.source,
            ProposalSource::Npm {
                package: "@linear/mcp".to_string(),
                version: Some("1.2.3".to_string())
            }
        );
        for spec in ["@linear/mcp", "@linear/mcp@latest", "pkg@^1.2.0", "pkg"] {
            let json =
                format!(r#"{{"mcpServers":{{"x":{{"command":"npx","args":["-y","{spec}"]}}}}}}"#);
            let p = one(&json);
            assert_eq!(p.status, ProposalStatus::NeedsExactVersion, "{spec}");
            assert!(
                matches!(p.source, ProposalSource::Npm { version: None, .. }),
                "{spec}"
            );
        }
    }

    #[test]
    fn remote_entries_expose_only_the_host() {
        let p = one(
            r#"{"mcpServers":{"remote":{"type":"http","url":"https://mcp.example.com/v1?apiKey=sk-123","headers":{"Authorization":"Bearer x"}}}}"#,
        );
        assert_eq!(
            p.source,
            ProposalSource::Remote {
                host: "mcp.example.com".to_string()
            }
        );
        assert_eq!(p.status, ProposalStatus::Remote);
        let wire = serde_json::to_string(&p).unwrap();
        assert!(
            !wire.contains("sk-123") && !wire.contains("Bearer"),
            "{wire}"
        );
    }

    #[test]
    fn other_commands_are_unsupported_with_a_reason() {
        let p = one(r#"{"mcpServers":{"py":{"command":"uvx","args":["mcp-atlassian"]}}}"#);
        assert_eq!(p.status, ProposalStatus::Unsupported);
        assert_eq!(
            p.source,
            ProposalSource::Unsupported {
                command: "uvx".to_string()
            }
        );
        assert!(p.reason.unwrap().contains("npx"));
        let p = one(r#"{"mcpServers":{"none":{}}}"#);
        assert!(p.reason.unwrap().contains("neither"));
        let p = one(r#"{"mcpServers":{"o":{"command":"npx","args":["-p","pkg@1.0.0","bin"]}}}"#);
        assert_eq!(p.status, ProposalStatus::Unsupported);
        let p = one(r#"{"mcpServers":{"o":{"command":"npx","args":["-y"]}}}"#);
        assert!(p.reason.unwrap().contains("no package"));
        let p = one(r#"{"mcpServers":{"o":{"command":"npx","args":["Bad Name@1.0.0"]}}}"#);
        assert!(p.reason.unwrap().contains("not a valid npm package"));
    }

    #[test]
    fn windows_npx_paths_count_as_npx() {
        let p = one(
            r#"{"mcpServers":{"w":{"command":"C:\\Program Files\\nodejs\\npx.cmd","args":["pkg@2.0.0"]}}}"#,
        );
        assert_eq!(p.status, ProposalStatus::Ready);
    }

    #[test]
    fn reserved_and_malformed_env_names_are_refused() {
        let p = one(
            r#"{"mcpServers":{"x":{"command":"npx","args":["pkg@1.0.0"],"env":{"HTTPS_PROXY":"x","NODE_OPTIONS":"x","bad name":"x","OK_KEY":"x"}}}}"#,
        );
        assert_eq!(p.env_keys, vec!["OK_KEY".to_string()]);
        assert_eq!(p.refused_env_keys.len(), 3, "{:?}", p.refused_env_keys);
    }

    #[test]
    fn repository_text_is_length_capped() {
        let long = "a".repeat(5000);
        let json = format!(
            r#"{{"mcpServers":{{"{long}":{{"command":"npx","args":["pkg@1.0.0","{long}"]}}}}}}"#
        );
        let p = one(&json);
        assert_eq!(p.key.chars().count(), MAX_TEXT_CHARS);
        assert_eq!(p.args[0].chars().count(), MAX_TEXT_CHARS);
        assert!(p.suggested_name.is_none() || p.suggested_name.unwrap().len() <= 31);
    }

    #[test]
    fn names_are_suggested_only_when_valid() {
        assert_eq!(
            suggested_name("My Figma_Server").as_deref(),
            Some("my-figma-server")
        );
        assert_eq!(suggested_name("42-linear").as_deref(), Some("linear"));
        assert_eq!(suggested_name("relay"), None);
        assert_eq!(suggested_name("guard"), None);
        assert_eq!(suggested_name("x-up"), None);
        assert_eq!(suggested_name("!!!"), None);
        assert_eq!(suggested_name("Żółw"), Some("w".to_string()));
    }

    #[test]
    fn built_in_packages_suggest_the_integration() {
        let p = one(r#"{"mcpServers":{"pw":{"command":"npx","args":["@playwright/mcp@0.0.40"]}}}"#);
        assert_eq!(p.builtin_integration.as_deref(), Some("playwright"));
        for (_, key) in BUILT_IN_NPM_PACKAGES {
            assert!(crate::consts::BUILT_IN_SERVICE_IDS.contains(key), "{key}");
        }
    }

    #[test]
    fn malformed_documents_are_errors_and_empty_ones_are_not() {
        assert!(parse_mcp_json("{not json").is_err());
        assert!(parse_mcp_json(r#"{"mcpServers":[]}"#).is_err());
        assert!(parse_mcp_json("{}").unwrap().is_empty());
        let mut many = serde_json::Map::new();
        for i in 0..(MAX_PROPOSALS + 10) {
            many.insert(format!("s{i:03}"), serde_json::json!({"command": "npx"}));
        }
        let json = serde_json::json!({ "mcpServers": many }).to_string();
        assert_eq!(parse_mcp_json(&json).unwrap().len(), MAX_PROPOSALS);
    }

    #[test]
    fn scan_reads_the_project_file_and_tolerates_its_absence() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(scan_project_dir(tmp.path()).unwrap().is_empty());
        std::fs::write(
            tmp.path().join(MCP_JSON_FILE),
            r#"{"mcpServers":{"a":{"command":"npx","args":["pkg@1.0.0"]}}}"#,
        )
        .unwrap();
        assert_eq!(scan_project_dir(tmp.path()).unwrap().len(), 1);
    }

    #[test]
    fn scan_refuses_an_oversized_file() {
        let tmp = tempfile::tempdir().unwrap();
        let padding = " ".repeat(MAX_MCP_JSON_BYTES as usize);
        std::fs::write(tmp.path().join(MCP_JSON_FILE), format!("{{}}{padding}")).unwrap();
        let err = scan_project_dir(tmp.path()).unwrap_err().to_string();
        assert!(err.contains("larger than"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn scan_refuses_a_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let target = elsewhere.path().join("real.json");
        std::fs::write(&target, r#"{"mcpServers":{}}"#).unwrap();
        std::os::unix::fs::symlink(&target, tmp.path().join(MCP_JSON_FILE)).unwrap();
        assert!(scan_project_dir(tmp.path()).is_err());
    }
}
