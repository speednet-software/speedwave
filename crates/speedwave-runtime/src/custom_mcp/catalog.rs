//! The hub's raw tool catalog of a Custom MCP server (`<audit>/tool-catalog-custom-<name>.json`),
//! read as untrusted text: strict shape, size cap, definition hashes recomputed here.

use super::model::{self, CustomToolDecision, ToolDecisionState};
use super::policy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Catalog schema version the hub writes (hub `TOOL_CATALOG_SCHEMA`).
pub const TOOL_CATALOG_SCHEMA: u32 = 1;

/// Largest catalog file the hub writes and Desktop reads (hub `MAX_TOOL_CATALOG_BYTES`).
pub const MAX_TOOL_CATALOG_BYTES: u64 = 1024 * 1024;

/// File name prefix of a hub tool catalog (hub `toolCatalogFileName`).
pub const TOOL_CATALOG_FILE_PREFIX: &str = "tool-catalog-";

const MAX_CATALOG_TOOLS: usize = 1000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogFile {
    schema: u32,
    service: String,
    #[serde(rename = "written_at")]
    _written_at: String,
    tools: Vec<CatalogFileTool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogFileTool {
    name: String,
    upstream_name: Option<String>,
    description: String,
    #[serde(rename = "inputSchema")]
    input_schema: Value,
    annotations: Value,
    #[serde(rename = "outputSchema", default)]
    output_schema: Value,
    #[serde(rename = "state")]
    _state: Option<String>,
}

/// One tool as the guard exposed it, with the hash Desktop computed for its upstream definition.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogTool {
    /// Name the hub sees (the guard's `mapToolNames` result).
    pub exposed_name: String,
    /// Name the server itself uses; tool decisions are keyed by it.
    pub upstream_name: String,
    /// The upstream definition `{name, description, inputSchema, annotations, outputSchema}`.
    pub definition: Value,
    /// `sha256:<hex>` of [`Self::definition`].
    pub definition_hash: String,
}

impl CatalogTool {
    /// The `readOnlyHint` annotation, when the server declares one (unverified).
    pub fn read_only_hint(&self) -> Option<bool> {
        self.definition
            .get("annotations")
            .and_then(|a| a.get("readOnlyHint"))
            .and_then(Value::as_bool)
    }

    /// Sanitized description cut to `max_chars` characters.
    pub fn description_preview(&self, max_chars: usize) -> String {
        let raw = self
            .definition
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("");
        policy::sanitize_description(raw)
            .chars()
            .take(max_chars)
            .collect()
    }
}

/// What the user sees for one tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolState {
    /// No decision yet.
    Pending,
    /// Allowed for the current definition.
    Allowed,
    /// Blocked for the current definition.
    Blocked,
    /// The definition changed since the decision; blocked until reviewed again.
    Changed,
}

/// The state of a tool whose current definition hashes to `current_hash`.
pub fn tool_state(decision: Option<&CustomToolDecision>, current_hash: &str) -> ToolState {
    match decision {
        None => ToolState::Pending,
        Some(d) if d.definition_hash != current_hash => ToolState::Changed,
        Some(d) => match d.state {
            ToolDecisionState::Allowed => ToolState::Allowed,
            ToolDecisionState::Blocked => ToolState::Blocked,
            ToolDecisionState::Pending => ToolState::Pending,
        },
    }
}

/// `<data_dir>/audit/<project>/tool-catalog-custom-<name>.json`; validates both names.
pub fn catalog_path_in(data_dir: &Path, project: &str, name: &str) -> anyhow::Result<PathBuf> {
    crate::validation::validate_project_name(project)?;
    model::validate_server_name(name)?;
    Ok(crate::audit::audit_dir_in(data_dir, project).join(format!(
        "{TOOL_CATALOG_FILE_PREFIX}{}.json",
        model::service_id(name)
    )))
}

/// Parses catalog text for server `name`: the exact hub shape, the right service, unique
/// upstream names; every definition hash is recomputed.
pub fn parse_catalog(text: &str, name: &str) -> anyhow::Result<Vec<CatalogTool>> {
    let file: CatalogFile = serde_json::from_str(text)
        .map_err(|e| anyhow::anyhow!("the tool catalog is malformed: {e}"))?;
    if file.schema != TOOL_CATALOG_SCHEMA {
        anyhow::bail!(
            "the tool catalog has schema {}, expected {TOOL_CATALOG_SCHEMA}",
            file.schema
        );
    }
    if file.service != model::service_id(name) {
        anyhow::bail!("the tool catalog belongs to another service");
    }
    if file.tools.len() > MAX_CATALOG_TOOLS {
        anyhow::bail!("the tool catalog lists more than {MAX_CATALOG_TOOLS} tools");
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut tools = Vec::with_capacity(file.tools.len());
    for tool in file.tools {
        let upstream = tool
            .upstream_name
            .ok_or_else(|| anyhow::anyhow!("a catalog tool has no upstream name"))?;
        if upstream.is_empty() || upstream.len() > 512 {
            anyhow::bail!("a catalog tool has an invalid upstream name");
        }
        if !policy::is_valid_tool_name(&tool.name) {
            anyhow::bail!("a catalog tool has an invalid exposed name");
        }
        if !seen.insert(upstream.clone()) {
            anyhow::bail!("the tool catalog lists an upstream tool twice");
        }
        let definition = serde_json::json!({
            "name": upstream,
            "description": tool.description,
            "inputSchema": tool.input_schema,
            "annotations": tool.annotations,
            "outputSchema": tool.output_schema,
        });
        let definition_hash = policy::definition_hash(&definition)?;
        tools.push(CatalogTool {
            exposed_name: tool.name,
            upstream_name: upstream,
            definition,
            definition_hash,
        });
    }
    Ok(tools)
}

/// Reads the catalog of server `name`: `Ok(None)` when the hub has not written one; an error for
/// a symlink, a file over [`MAX_TOOL_CATALOG_BYTES`], or a malformed or torn file.
pub fn read_catalog(
    data_dir: &Path,
    project: &str,
    name: &str,
) -> anyhow::Result<Option<Vec<CatalogTool>>> {
    let path = catalog_path_in(data_dir, project, name)?;
    match crate::fs_perms::read_regular_file_no_follow_capped(&path, MAX_TOOL_CATALOG_BYTES) {
        Ok(None) => Ok(None),
        Ok(Some(text)) => parse_catalog(&text, name).map(Some),
        Err(e) => anyhow::bail!("the tool catalog cannot be read: {e}"),
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn catalog_json(name: &str, tools: &[(&str, &str, &str)]) -> String {
        serde_json::json!({
            "schema": 1,
            "service": model::service_id(name),
            "written_at": "2026-10-08T10:00:00.000Z",
            "tools": tools.iter().map(|(exposed, upstream, description)| serde_json::json!({
                "name": exposed,
                "upstream_name": upstream,
                "description": description,
                "inputSchema": {"type": "object", "properties": {}},
                "annotations": {"readOnlyHint": true},
                "state": "pending",
            })).collect::<Vec<_>>(),
        })
        .to_string()
    }

    pub(crate) fn write_catalog(data_dir: &Path, project: &str, name: &str, text: &str) {
        let path = catalog_path_in(data_dir, project, name).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn hashes_are_recomputed_from_the_upstream_definition() {
        let tools = parse_catalog(
            &catalog_json("figma", &[("get_file", "get-file", "Fetch a file")]),
            "figma",
        )
        .unwrap();
        assert_eq!(tools.len(), 1);
        let t = &tools[0];
        assert_eq!(t.exposed_name, "get_file");
        assert_eq!(t.upstream_name, "get-file");
        let expected = policy::definition_hash(&serde_json::json!({
            "name": "get-file",
            "description": "Fetch a file",
            "inputSchema": {"type": "object", "properties": {}},
            "annotations": {"readOnlyHint": true},
        }))
        .unwrap();
        assert_eq!(t.definition_hash, expected);
        assert_eq!(t.read_only_hint(), Some(true));
    }

    #[test]
    fn output_schema_is_part_of_the_definition_and_its_hash() {
        let mut doc: Value =
            serde_json::from_str(&catalog_json("figma", &[("t", "t", "d")])).unwrap();
        let without = parse_catalog(&doc.to_string(), "figma").unwrap();
        doc["tools"][0]["outputSchema"] =
            serde_json::json!({"type": "object", "properties": {"id": {"type": "string"}}});
        let with = parse_catalog(&doc.to_string(), "figma").unwrap();
        assert_eq!(
            with[0].definition["outputSchema"],
            doc["tools"][0]["outputSchema"]
        );
        assert_eq!(
            with[0].definition_hash,
            policy::definition_hash(&with[0].definition).unwrap()
        );
        assert_ne!(with[0].definition_hash, without[0].definition_hash);
        doc["tools"][0]["outputSchema"] = serde_json::json!({"type": "object"});
        let changed = parse_catalog(&doc.to_string(), "figma").unwrap();
        assert_ne!(changed[0].definition_hash, with[0].definition_hash);
    }

    #[test]
    fn an_absent_or_null_output_schema_hashes_as_null() {
        let good = catalog_json("figma", &[("t", "t", "d")]);
        let absent = parse_catalog(&good, "figma").unwrap();
        assert_eq!(absent[0].definition["outputSchema"], Value::Null);
        let mut doc: Value = serde_json::from_str(&good).unwrap();
        doc["tools"][0]["outputSchema"] = Value::Null;
        let null = parse_catalog(&doc.to_string(), "figma").unwrap();
        assert_eq!(null[0].definition_hash, absent[0].definition_hash);
        let mut bare = absent[0].definition.clone();
        bare.as_object_mut().unwrap().remove("outputSchema");
        assert_eq!(
            policy::definition_hash(&bare).unwrap(),
            absent[0].definition_hash
        );
    }

    #[test]
    fn a_changed_description_changes_the_hash() {
        let a = parse_catalog(&catalog_json("figma", &[("t", "t", "one")]), "figma").unwrap();
        let b = parse_catalog(&catalog_json("figma", &[("t", "t", "two")]), "figma").unwrap();
        assert_ne!(a[0].definition_hash, b[0].definition_hash);
    }

    #[test]
    fn description_preview_is_sanitized_and_capped() {
        let tools = parse_catalog(
            &catalog_json("figma", &[("t", "t", "a\u{202E}b\u{200B}c")]),
            "figma",
        )
        .unwrap();
        assert_eq!(tools[0].description_preview(200), "abc");
        let long = "é".repeat(500);
        let tools = parse_catalog(&catalog_json("figma", &[("t", "t", &long)]), "figma").unwrap();
        assert_eq!(tools[0].description_preview(200).chars().count(), 200);
    }

    #[test]
    fn state_follows_the_decision_and_its_hash() {
        let hash = format!("sha256:{}", "a".repeat(64));
        let other = format!("sha256:{}", "b".repeat(64));
        let decision = |state| CustomToolDecision {
            state,
            definition_hash: hash.clone(),
        };
        assert_eq!(tool_state(None, &hash), ToolState::Pending);
        assert_eq!(
            tool_state(Some(&decision(ToolDecisionState::Allowed)), &hash),
            ToolState::Allowed
        );
        assert_eq!(
            tool_state(Some(&decision(ToolDecisionState::Blocked)), &hash),
            ToolState::Blocked
        );
        assert_eq!(
            tool_state(Some(&decision(ToolDecisionState::Pending)), &hash),
            ToolState::Pending
        );
        assert_eq!(
            tool_state(Some(&decision(ToolDecisionState::Allowed)), &other),
            ToolState::Changed
        );
        assert_eq!(
            tool_state(Some(&decision(ToolDecisionState::Blocked)), &other),
            ToolState::Changed
        );
    }

    #[test]
    fn malformed_catalogs_are_refused() {
        let good = catalog_json("figma", &[("t", "t", "d")]);
        assert!(parse_catalog(&good, "other").is_err());
        assert!(parse_catalog(&good[..good.len() / 2], "figma").is_err());
        let mut doc: Value = serde_json::from_str(&good).unwrap();
        doc["schema"] = serde_json::json!(2);
        assert!(parse_catalog(&doc.to_string(), "figma").is_err());
        let mut doc: Value = serde_json::from_str(&good).unwrap();
        doc["extra"] = serde_json::json!(1);
        assert!(parse_catalog(&doc.to_string(), "figma").is_err());
        let mut doc: Value = serde_json::from_str(&good).unwrap();
        doc["tools"][0]["output_schema"] = serde_json::json!({"type": "object"});
        assert!(parse_catalog(&doc.to_string(), "figma").is_err());
        let mut doc: Value = serde_json::from_str(&good).unwrap();
        doc["tools"][0]["upstream_name"] = Value::Null;
        assert!(parse_catalog(&doc.to_string(), "figma").is_err());
        let mut doc: Value = serde_json::from_str(&good).unwrap();
        doc["tools"][0]["name"] = serde_json::json!("bad name!");
        assert!(parse_catalog(&doc.to_string(), "figma").is_err());
        let twice = catalog_json("figma", &[("a", "t", "d"), ("b", "t", "d")]);
        assert!(parse_catalog(&twice, "figma").is_err());
    }

    #[test]
    fn read_tolerates_absence_and_refuses_oversize() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_catalog(tmp.path(), "acme", "figma").unwrap().is_none());
        write_catalog(
            tmp.path(),
            "acme",
            "figma",
            &catalog_json("figma", &[("t", "t", "d")]),
        );
        assert_eq!(
            read_catalog(tmp.path(), "acme", "figma")
                .unwrap()
                .unwrap()
                .len(),
            1
        );
        let big = " ".repeat(MAX_TOOL_CATALOG_BYTES as usize + 1);
        write_catalog(tmp.path(), "acme", "figma", &big);
        assert!(read_catalog(tmp.path(), "acme", "figma").is_err());
        assert!(catalog_path_in(tmp.path(), "acme", "../x").is_err());
    }

    #[test]
    fn catalog_limits_match_the_hub_writer() {
        let ts = include_str!("../../../../mcp-servers/hub/src/tool-catalog.ts");
        assert!(
            ts.contains(&format!(
                "export const TOOL_CATALOG_SCHEMA = {TOOL_CATALOG_SCHEMA};"
            )),
            "hub TOOL_CATALOG_SCHEMA drifted"
        );
        assert!(
            ts.contains("export const MAX_TOOL_CATALOG_BYTES = 1024 * 1024;")
                && MAX_TOOL_CATALOG_BYTES == 1024 * 1024,
            "hub MAX_TOOL_CATALOG_BYTES drifted"
        );
        assert!(
            ts.contains(&format!("`{TOOL_CATALOG_FILE_PREFIX}${{service}}.json`")),
            "hub toolCatalogFileName drifted"
        );
    }
}
