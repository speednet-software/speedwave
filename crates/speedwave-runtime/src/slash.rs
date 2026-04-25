//! Slash command discovery for Claude Code.
//!
//! Runs `claude -p --verbose --output-format=stream-json --max-turns 1 -- /`
//! inside the project's Claude container and parses the first `system/init`
//! line to extract the authoritative list of slash commands, plugins, and
//! agents available in that session. Falls back to a hardcoded built-in list
//! when discovery times out or the container is unavailable.
//!
//! Discovery is cached per project (10-minute staleness cap) because running
//! `claude -p` costs a live API call (~$0.01–$0.25 per invocation). Callers
//! should invalidate the cache explicitly when `.claude/` changes or a plugin
//! is installed / removed.

use crate::consts;
use crate::runtime::ContainerRuntime;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Hard cap on how long we wait for the `system/init` line from Claude Code
/// before giving up and returning the hardcoded fallback.
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(60);

/// How long a cached discovery result remains valid before we re-run
/// discovery on the next call. Claude Code installs change rarely; 10
/// minutes is the sweet spot between freshness and cost.
const CACHE_STALENESS: Duration = Duration::from_secs(10 * 60);

/// Polling interval while waiting for the init line.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Indicates whether the discovery result came from Claude Code itself
/// (`Init`) or from the hardcoded fallback list (`Fallback`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiscoverySource {
    /// Discovered from the `system/init` event emitted by `claude -p`.
    Init,
    /// Returned the hardcoded fallback list because discovery timed out
    /// or the container was unavailable.
    Fallback,
}

/// Classification of a slash command, used by the UI to render an
/// appropriate badge ("skill", "cmd", "plugin:<name>", "agent", "built-in").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SlashKind {
    /// Built into Claude Code itself (`/help`, `/clear`, `/compact`, etc.).
    Builtin,
    /// A skill exposed via `.claude/skills/<name>/SKILL.md`.
    Skill,
    /// A command defined via `.claude/commands/<name>.md`.
    Command,
    /// A plugin-provided command or skill (prefixed in the command name).
    Plugin,
    /// A named subagent exposed through Claude Code.
    Agent,
}

/// One entry in the slash popover.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlashCommand {
    /// Command name exactly as Claude Code accepts it, without the leading
    /// slash.
    pub name: String,
    /// Human-readable one-liner, enriched from the command's on-disk
    /// frontmatter when possible.
    pub description: Option<String>,
    /// Hint shown after the command name when the user presses Tab or
    /// selects the entry (e.g. `[file]`).
    pub argument_hint: Option<String>,
    /// Classification used by the UI to render the badge.
    pub kind: SlashKind,
    /// Owning plugin name when `kind == Plugin`.
    pub plugin: Option<String>,
}

/// Full result returned by `discover_slash_commands`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlashDiscovery {
    /// Visible entries, already filtered and enriched.
    pub commands: Vec<SlashCommand>,
    /// Whether this discovery came from Claude Code or the fallback list.
    pub source: DiscoverySource,
}

/// Minimal container-enough project view for the discovery function.
///
/// Kept distinct from `config::ProjectUserEntry` so that callers can pass
/// whatever they already have (e.g. a resolved `ProjectUserEntry`).
#[derive(Debug, Clone)]
pub struct ProjectHandle {
    /// Project name as used in `speedwave_<name>_claude` container names.
    pub name: String,
    /// Absolute path to the project root, used to locate `<dir>/.claude/`.
    pub dir: PathBuf,
}

impl ProjectHandle {
    /// Builds a handle from the public fields we already store in configs.
    pub fn new(name: impl Into<String>, dir: impl Into<PathBuf>) -> Self {
        Self {
            name: name.into(),
            dir: dir.into(),
        }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Discovers the slash commands available in `project`'s active Claude
/// session.
///
/// Returns a cached result when one is present and younger than
/// [`CACHE_STALENESS`]; otherwise runs discovery and caches the result.
/// Fallback results are cached too so that a stopped container does not
/// trigger repeated 60-second timeouts on every keystroke.
pub fn discover_slash_commands(
    runtime: &dyn ContainerRuntime,
    project: &ProjectHandle,
) -> anyhow::Result<SlashDiscovery> {
    if let Some(cached) = cache_get(&project.name) {
        return Ok(cached);
    }

    let container = claude_container_name(&project.name);
    let discovery = match run_discovery(runtime, &container) {
        Ok(raw) => enrich_and_filter(raw, &project.dir),
        Err(err) => {
            log::warn!(
                "slash discovery failed for '{}': {err}; returning hardcoded fallback",
                project.name
            );
            fallback_discovery()
        }
    };

    cache_put(&project.name, discovery.clone());
    Ok(discovery)
}

/// Invalidates the cached discovery for a single project. Call this when
/// a plugin is installed / removed, when the active project changes, or
/// when the user explicitly asks for a refresh.
pub fn invalidate_cache(project_name: &str) {
    if let Ok(mut map) = cache().lock() {
        map.remove(project_name);
    }
}

/// Invalidates every cached discovery. Useful on factory reset and at
/// the end of tests that share process state.
pub fn invalidate_all_caches() {
    if let Ok(mut map) = cache().lock() {
        map.clear();
    }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/// Cache entry tracks when the discovery was stored so we can expire it.
#[derive(Clone)]
struct CachedDiscovery {
    stored_at: Instant,
    discovery: SlashDiscovery,
}

fn cache() -> &'static Mutex<HashMap<String, CachedDiscovery>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedDiscovery>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_get(project_name: &str) -> Option<SlashDiscovery> {
    let mut map = cache().lock().ok()?;
    let entry = map.get(project_name)?;
    if entry.stored_at.elapsed() < CACHE_STALENESS {
        Some(entry.discovery.clone())
    } else {
        map.remove(project_name);
        None
    }
}

fn cache_put(project_name: &str, discovery: SlashDiscovery) {
    if let Ok(mut map) = cache().lock() {
        map.insert(
            project_name.to_string(),
            CachedDiscovery {
                stored_at: Instant::now(),
                discovery,
            },
        );
    }
}

// ---------------------------------------------------------------------------
// Discovery (running claude -p and parsing the init event)
// ---------------------------------------------------------------------------

/// Raw payload extracted from the first `system/init` line emitted by
/// `claude -p`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct RawDiscovery {
    slash_commands: Vec<String>,
    plugins: Vec<PluginEntry>,
    agents: Vec<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct PluginEntry {
    name: String,
    path: Option<PathBuf>,
}

/// Parses a single stream-json line and returns `Some(RawDiscovery)` when
/// it is the init event; otherwise `None` so the caller keeps waiting.
fn parse_init_line(line: &str) -> Option<RawDiscovery> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    let obj = value.as_object()?;
    if obj.get("type")?.as_str()? != "system" {
        return None;
    }
    if obj.get("subtype")?.as_str()? != "init" {
        return None;
    }

    let slash_commands = obj
        .get("slash_commands")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let plugins = obj
        .get("plugins")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|plugin| {
                    let pobj = plugin.as_object()?;
                    let name = pobj.get("name")?.as_str()?.to_string();
                    let path = pobj.get("path").and_then(|p| p.as_str()).map(PathBuf::from);
                    Some(PluginEntry { name, path })
                })
                .collect()
        })
        .unwrap_or_default();

    let agents = obj
        .get("agents")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    Some(RawDiscovery {
        slash_commands,
        plugins,
        agents,
    })
}

/// Runs `claude -p --verbose --output-format=stream-json --max-turns 1 -- /`
/// inside `container`, reads stdout line by line, and returns the first
/// parsed `system/init` event. Kills the child as soon as that line is
/// captured so we do not pay for a full turn.
fn run_discovery(runtime: &dyn ContainerRuntime, container: &str) -> anyhow::Result<RawDiscovery> {
    let args = [
        consts::CLAUDE_BINARY,
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--max-turns",
        "1",
        "--",
        "/",
    ];

    let mut cmd = runtime.container_exec_piped(container, &args)?;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("claude -p: stdout not captured"))?;

    let start = Instant::now();
    let mut reader = BufReader::new(stdout);
    let mut buf = String::new();
    let mut result: Option<RawDiscovery> = None;
    let mut got_line = false;

    while start.elapsed() < DISCOVERY_TIMEOUT {
        buf.clear();
        match reader.read_line(&mut buf) {
            Ok(0) => break, // EOF — process exited without init
            Ok(_) => {
                got_line = true;
                if let Some(parsed) = parse_init_line(&buf) {
                    result = Some(parsed);
                    break;
                }
            }
            Err(err) => {
                let kind = err.kind();
                if kind == std::io::ErrorKind::WouldBlock
                    || kind == std::io::ErrorKind::TimedOut
                    || kind == std::io::ErrorKind::Interrupted
                {
                    std::thread::sleep(POLL_INTERVAL);
                    continue;
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(anyhow::Error::new(err).context("claude -p: read_line failed"));
            }
        }
    }

    // Always kill the child — even on success we do not want a lingering
    // turn. Ignore kill errors (process may already have exited).
    let _ = child.kill();
    let _ = child.wait();

    match result {
        Some(parsed) => Ok(parsed),
        None => {
            if got_line {
                anyhow::bail!("claude -p: no system/init event in stdout before timeout");
            }
            anyhow::bail!(
                "claude -p: no output received within {}s",
                DISCOVERY_TIMEOUT.as_secs()
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Enrichment and filtering
// ---------------------------------------------------------------------------

/// Frontmatter fields we care about. All fields are optional so missing or
/// malformed frontmatter degrades gracefully.
#[derive(Debug, Default, Clone, Deserialize)]
struct SlashFrontmatter {
    description: Option<String>,
    #[serde(rename = "argument-hint")]
    argument_hint: Option<String>,
    /// When explicitly `false`, the entry is hidden from the popover
    /// (it is model-only). Missing or `true` keeps it visible.
    #[serde(rename = "user-invocable")]
    user_invocable: Option<bool>,
}

/// Turns raw discovery into a filtered, enriched, sorted `SlashDiscovery`.
fn enrich_and_filter(raw: RawDiscovery, project_dir: &Path) -> SlashDiscovery {
    let personal_dir = personal_claude_dir();
    let mut commands: Vec<SlashCommand> = Vec::new();

    for name in raw.slash_commands {
        let (clean_name, plugin) = split_plugin_prefix(&name);
        let mut kind = classify_kind(clean_name, plugin.as_deref(), &raw.agents);

        let (frontmatter, origin) = lookup_frontmatter(
            clean_name,
            plugin.as_deref(),
            project_dir,
            personal_dir.as_deref(),
            &raw.plugins,
        );

        // Promote Command -> Skill when the matching file lived under a
        // skills/ directory. Plugin-prefixed entries keep SlashKind::Plugin
        // (the badge already communicates the source).
        if matches!(origin, Some(FrontmatterOrigin::Skill)) && kind == SlashKind::Command {
            kind = SlashKind::Skill;
        }

        // Skills with `user-invocable: false` are hidden. Note that
        // `disable-model-invocation: true` is the *opposite* flag and MUST
        // NOT hide the entry — vibe-kanban mixes these up, we do not.
        if matches!(frontmatter.user_invocable, Some(false)) {
            continue;
        }

        commands.push(SlashCommand {
            name: name.clone(),
            description: frontmatter.description.map(|d| d.trim().to_string()),
            argument_hint: frontmatter.argument_hint,
            kind,
            plugin,
        });
    }

    for agent in raw.agents {
        // Agents sometimes appear both as slash_commands and in `agents`
        // (e.g. `/agent-name`). Avoid duplicates by key lookup.
        if commands.iter().any(|c| c.name == agent) {
            continue;
        }
        commands.push(SlashCommand {
            name: agent,
            description: None,
            argument_hint: None,
            kind: SlashKind::Agent,
            plugin: None,
        });
    }

    commands.sort_by(|a, b| a.name.cmp(&b.name));

    SlashDiscovery {
        commands,
        source: DiscoverySource::Init,
    }
}

/// Splits a command name on the first `:` into `(bare_name, plugin)`.
/// Returns `(name, None)` when there is no plugin prefix.
fn split_plugin_prefix(name: &str) -> (&str, Option<String>) {
    match name.split_once(':') {
        Some((plugin, bare)) if !plugin.is_empty() && !bare.is_empty() => {
            (bare, Some(plugin.to_string()))
        }
        _ => (name, None),
    }
}

/// Classifies a command name based on built-in list, plugin prefix, and
/// `agents` presence. Default `Command` is the safest fallback; the UI
/// renders `cmd` for it which matches Claude Code's own terminology.
fn classify_kind(name: &str, plugin: Option<&str>, agents: &[String]) -> SlashKind {
    if plugin.is_some() {
        return SlashKind::Plugin;
    }
    if agents.iter().any(|a| a == name) {
        return SlashKind::Agent;
    }
    if is_builtin_name(name) {
        return SlashKind::Builtin;
    }
    // Heuristic: if the on-disk file lives under `skills/`, treat it as
    // a skill; otherwise Command. We don't have that info here, but the
    // lookup function below records which directory matched — we refine
    // the classification via a second pass below if needed. For the
    // simple case (no frontmatter, no plugin prefix, not a known
    // built-in, not an agent) `Command` is the correct default.
    SlashKind::Command
}

fn is_builtin_name(name: &str) -> bool {
    matches!(
        name,
        "help"
            | "clear"
            | "compact"
            | "resume"
            | "cost"
            | "context"
            | "memory"
            | "model"
            | "config"
            | "review"
            | "exit"
            | "logout"
            | "login"
    )
}

/// Searches, in priority order, for the on-disk frontmatter of a slash
/// command and returns the first hit. Silently returns an empty
/// frontmatter when nothing matches.
///
/// Priority: project `.claude/skills` → project `.claude/commands` →
/// personal `~/.claude/skills` → personal `~/.claude/commands` →
/// plugin-provided paths.
///
/// Returns the parsed frontmatter and a hint for whether the matched file
/// lives under `skills/` (so the caller can promote `Command` → `Skill` in
/// `classify_kind`) — `None` when no file matched.
fn lookup_frontmatter(
    name: &str,
    plugin: Option<&str>,
    project_dir: &Path,
    personal_dir: Option<&Path>,
    plugins: &[PluginEntry],
) -> (SlashFrontmatter, Option<FrontmatterOrigin>) {
    let mut candidates: Vec<(PathBuf, FrontmatterOrigin)> = Vec::new();

    for base in [
        project_dir.join(".claude"),
        project_dir.join("claude-resources"),
    ] {
        push_skill_candidates(&base, name, &mut candidates);
    }
    if let Some(personal) = personal_dir {
        push_skill_candidates(personal, name, &mut candidates);
    }
    if let Some(plugin_name) = plugin {
        for plugin_entry in plugins.iter().filter(|p| p.name == plugin_name) {
            if let Some(path) = &plugin_entry.path {
                push_skill_candidates(path, name, &mut candidates);
            }
        }
    }
    // Fallback: scan every plugin path for a matching skill/command even
    // when the command had no explicit plugin prefix (e.g. for plugins
    // whose skills are exposed without namespacing). Skip plugins already
    // scanned above to avoid duplicate file reads.
    let already_scanned: Option<&str> = plugin;
    for plugin_entry in plugins {
        if Some(plugin_entry.name.as_str()) == already_scanned {
            continue;
        }
        if let Some(path) = &plugin_entry.path {
            push_skill_candidates(path, name, &mut candidates);
        }
    }

    for (candidate, origin) in candidates {
        match std::fs::read_to_string(&candidate) {
            Ok(contents) => {
                if let Some(fm) = parse_frontmatter(&contents) {
                    return (fm, Some(origin));
                }
                // The file exists but has no parseable frontmatter — still a
                // hit for kind classification purposes.
                return (SlashFrontmatter::default(), Some(origin));
            }
            Err(err) => {
                if err.kind() != std::io::ErrorKind::NotFound {
                    log::debug!(
                        "slash: read_to_string('{}') failed: {err}",
                        candidate.display()
                    );
                }
            }
        }
    }

    (SlashFrontmatter::default(), None)
}

/// Whether the matching file lived under a `skills/` directory or a `commands/` directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrontmatterOrigin {
    Skill,
    Command,
}

fn push_skill_candidates(base: &Path, name: &str, out: &mut Vec<(PathBuf, FrontmatterOrigin)>) {
    out.push((
        base.join("skills").join(name).join("SKILL.md"),
        FrontmatterOrigin::Skill,
    ));
    out.push((
        base.join("commands").join(format!("{name}.md")),
        FrontmatterOrigin::Command,
    ));
}

/// Returns the user's personal `.claude/` directory when the home
/// directory can be resolved; `None` otherwise.
fn personal_claude_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude"))
}

/// Parses YAML frontmatter bounded by `---` delimiters at the top of the
/// file. Returns `None` when there is no frontmatter block or the YAML
/// is malformed.
fn parse_frontmatter(contents: &str) -> Option<SlashFrontmatter> {
    let trimmed = contents.trim_start_matches('\u{feff}');
    let mut lines = trimmed.lines();
    let first = lines.next()?;
    if first.trim() != "---" {
        return None;
    }
    let mut yaml = String::new();
    for line in lines {
        if line.trim() == "---" {
            return serde_yaml_ng::from_str::<SlashFrontmatter>(&yaml).ok();
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
    None
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

fn fallback_discovery() -> SlashDiscovery {
    let names = [
        "help", "clear", "compact", "resume", "cost", "context", "memory",
    ];
    let commands = names
        .iter()
        .map(|name| SlashCommand {
            name: (*name).to_string(),
            description: Some(fallback_description(name).to_string()),
            argument_hint: None,
            kind: SlashKind::Builtin,
            plugin: None,
        })
        .collect();

    SlashDiscovery {
        commands,
        source: DiscoverySource::Fallback,
    }
}

fn fallback_description(name: &str) -> &'static str {
    match name {
        "help" => "Show available commands",
        "clear" => "Clear the conversation",
        "compact" => "Compact the conversation to save context",
        "resume" => "Resume the previous conversation",
        "cost" => "Show the current session's cost",
        "context" => "Show the current context window usage",
        "memory" => "Open the project memory panel",
        _ => "",
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn claude_container_name(project: &str) -> String {
    format!("{}_{}_claude", consts::compose_prefix(), project)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::process::Command;

    /// Mock runtime returns a canned stream-json script for `container_exec_piped`.
    struct MockRuntime {
        script: String,
    }

    impl MockRuntime {
        fn new(script: &str) -> Self {
            Self {
                script: script.to_string(),
            }
        }
    }

    impl ContainerRuntime for MockRuntime {
        fn compose_up(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn compose_down(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn compose_ps(&self, _: &str) -> anyhow::Result<Vec<Value>> {
            Ok(vec![])
        }
        fn container_exec(&self, _: &str, _: &[&str]) -> Command {
            Command::new("true")
        }
        fn container_exec_piped(&self, _: &str, _: &[&str]) -> anyhow::Result<Command> {
            let mut cmd = Command::new("sh");
            cmd.env("SW_TEST_SCRIPT", &self.script)
                .args(["-c", "printf '%s' \"$SW_TEST_SCRIPT\""]);
            Ok(cmd)
        }
        fn is_available(&self) -> bool {
            true
        }
        fn ensure_ready(&self) -> anyhow::Result<()> {
            Ok(())
        }
        fn build_image(&self, _: &str, _: &str, _: &str, _: &[(&str, &str)]) -> anyhow::Result<()> {
            Ok(())
        }
        fn container_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
            Ok(String::new())
        }
        fn compose_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
            Ok(String::new())
        }
        fn compose_up_recreate(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn image_exists(&self, _: &str) -> anyhow::Result<bool> {
            Ok(true)
        }
    }

    /// Runtime that always errors on piped exec — simulates a stopped container.
    struct FailingRuntime;

    impl ContainerRuntime for FailingRuntime {
        fn compose_up(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn compose_down(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn compose_ps(&self, _: &str) -> anyhow::Result<Vec<Value>> {
            Ok(vec![])
        }
        fn container_exec(&self, _: &str, _: &[&str]) -> Command {
            Command::new("true")
        }
        fn container_exec_piped(&self, _: &str, _: &[&str]) -> anyhow::Result<Command> {
            anyhow::bail!("container not running")
        }
        fn is_available(&self) -> bool {
            false
        }
        fn ensure_ready(&self) -> anyhow::Result<()> {
            anyhow::bail!("runtime not ready")
        }
        fn build_image(&self, _: &str, _: &str, _: &str, _: &[(&str, &str)]) -> anyhow::Result<()> {
            Ok(())
        }
        fn container_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
            Ok(String::new())
        }
        fn compose_logs(&self, _: &str, _: u32) -> anyhow::Result<String> {
            Ok(String::new())
        }
        fn compose_up_recreate(&self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn image_exists(&self, _: &str) -> anyhow::Result<bool> {
            Ok(false)
        }
    }

    fn sample_init_json() -> String {
        serde_json::json!({
            "type": "system",
            "subtype": "init",
            "slash_commands": ["help", "clear", "compact", "my-skill", "redmine:ticket"],
            "plugins": [{"name": "redmine", "path": "/opt/plugins/redmine", "source": "user"}],
            "agents": ["code-review"]
        })
        .to_string()
    }

    fn unique_project_name(suffix: &str) -> String {
        format!(
            "slash-test-{}-{suffix}-{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        )
    }

    #[test]
    fn parse_init_line_accepts_valid_event() {
        let parsed = parse_init_line(&sample_init_json()).expect("init event");
        assert!(parsed.slash_commands.iter().any(|n| n == "help"));
        assert_eq!(parsed.plugins.len(), 1);
        assert_eq!(parsed.plugins[0].name, "redmine");
        assert_eq!(
            parsed.plugins[0].path.as_deref(),
            Some(Path::new("/opt/plugins/redmine"))
        );
        assert_eq!(parsed.agents, vec!["code-review".to_string()]);
    }

    #[test]
    fn parse_init_line_rejects_non_init_event() {
        let other = serde_json::json!({
            "type": "assistant",
            "message": {"role": "assistant"}
        })
        .to_string();
        assert!(parse_init_line(&other).is_none());
    }

    #[test]
    fn parse_init_line_rejects_malformed_json() {
        assert!(parse_init_line("not json at all").is_none());
        assert!(parse_init_line("{\"type\":\"system\"").is_none());
    }

    #[test]
    fn parse_init_line_missing_optional_fields_is_tolerated() {
        let bare = serde_json::json!({
            "type": "system",
            "subtype": "init"
        })
        .to_string();
        let parsed = parse_init_line(&bare).expect("bare init should parse");
        assert!(parsed.slash_commands.is_empty());
        assert!(parsed.plugins.is_empty());
        assert!(parsed.agents.is_empty());
    }

    #[test]
    fn parse_frontmatter_handles_simple_block() {
        let src = "---\n\
                   description: Short desc\n\
                   argument-hint: '[file]'\n\
                   ---\n\
                   body text\n";
        let fm = parse_frontmatter(src).expect("frontmatter present");
        assert_eq!(fm.description.as_deref(), Some("Short desc"));
        assert_eq!(fm.argument_hint.as_deref(), Some("[file]"));
        assert_eq!(fm.user_invocable, None);
    }

    #[test]
    fn parse_frontmatter_handles_multiline_description() {
        let src = "---\ndescription: |\n  First line\n  Second line\n---\nbody\n";
        let fm = parse_frontmatter(src).expect("frontmatter present");
        assert!(fm.description.as_deref().unwrap().contains("First line"));
        assert!(fm.description.as_deref().unwrap().contains("Second line"));
    }

    #[test]
    fn parse_frontmatter_handles_utf8_content() {
        let src = "---\n\
                   description: \"ćżź — zażółć gęślą jaźń\"\n\
                   ---\n\
                   body\n";
        let fm = parse_frontmatter(src).expect("frontmatter present");
        assert!(fm.description.as_deref().unwrap().contains("zażółć"));
    }

    #[test]
    fn parse_frontmatter_respects_user_invocable_false() {
        let src = "---\n\
                   description: hidden skill\n\
                   user-invocable: false\n\
                   ---\n";
        let fm = parse_frontmatter(src).expect("frontmatter present");
        assert_eq!(fm.user_invocable, Some(false));
    }

    #[test]
    fn parse_frontmatter_returns_none_without_block() {
        assert!(parse_frontmatter("# Title only\n").is_none());
        assert!(parse_frontmatter("").is_none());
        assert!(parse_frontmatter("---\nno closing delimiter\n").is_none());
    }

    #[test]
    fn parse_frontmatter_ignores_bom() {
        let src = "\u{feff}---\ndescription: with bom\n---\nbody\n";
        let fm = parse_frontmatter(src).expect("frontmatter present");
        assert_eq!(fm.description.as_deref(), Some("with bom"));
    }

    #[test]
    fn split_plugin_prefix_splits_on_first_colon() {
        assert_eq!(
            split_plugin_prefix("redmine:ticket"),
            ("ticket", Some("redmine".to_string()))
        );
        assert_eq!(split_plugin_prefix("plain"), ("plain", None));
        assert_eq!(split_plugin_prefix(":leading"), (":leading", None));
        assert_eq!(split_plugin_prefix("trailing:"), ("trailing:", None));
    }

    #[test]
    fn is_builtin_name_matches_expected_list() {
        assert!(is_builtin_name("help"));
        assert!(is_builtin_name("clear"));
        assert!(is_builtin_name("model"));
        assert!(!is_builtin_name("my-skill"));
    }

    #[test]
    fn fallback_discovery_returns_minimal_builtins() {
        let d = fallback_discovery();
        assert_eq!(d.source, DiscoverySource::Fallback);
        assert!(d.commands.iter().any(|c| c.name == "help"));
        assert!(d.commands.iter().all(|c| c.kind == SlashKind::Builtin));
    }

    #[test]
    fn enrich_merges_agents_and_sorts() {
        let raw = RawDiscovery {
            slash_commands: vec!["help".into(), "zzz-skill".into(), "aaa-skill".into()],
            plugins: vec![],
            agents: vec!["code-review".into()],
        };
        let tmp = tempfile::tempdir().unwrap();
        let d = enrich_and_filter(raw, tmp.path());
        let names: Vec<&str> = d.commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["aaa-skill", "code-review", "help", "zzz-skill"]);
    }

    #[test]
    fn enrich_filters_user_invocable_false() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".claude/skills/hidden");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nuser-invocable: false\ndescription: model-only\n---\nbody\n",
        )
        .unwrap();

        let raw = RawDiscovery {
            slash_commands: vec!["hidden".into(), "visible".into()],
            ..RawDiscovery::default()
        };
        let d = enrich_and_filter(raw, tmp.path());
        let names: Vec<&str> = d.commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["visible"]);
    }

    #[test]
    fn enrich_keeps_disable_model_invocation_true() {
        // vibe-kanban filters these out — we must NOT.
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".claude/skills/user-only");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\ndescription: user only\ndisable-model-invocation: true\n---\nbody\n",
        )
        .unwrap();

        let raw = RawDiscovery {
            slash_commands: vec!["user-only".into()],
            ..RawDiscovery::default()
        };
        let d = enrich_and_filter(raw, tmp.path());
        assert_eq!(d.commands.len(), 1);
        assert_eq!(d.commands[0].name, "user-only");
        assert_eq!(d.commands[0].description.as_deref(), Some("user only"));
    }

    #[test]
    fn enrich_prefers_project_skill_over_personal() {
        // We can redirect personal_dir via HOME only if we first ensure the
        // test does not run concurrently with others touching HOME. Instead,
        // we verify priority by writing a project skill and checking we
        // picked up its description.
        let tmp = tempfile::tempdir().unwrap();
        let project_skill = tmp.path().join(".claude/skills/myskill");
        std::fs::create_dir_all(&project_skill).unwrap();
        std::fs::write(
            project_skill.join("SKILL.md"),
            "---\ndescription: from project\n---\n",
        )
        .unwrap();

        let raw = RawDiscovery {
            slash_commands: vec!["myskill".into()],
            ..RawDiscovery::default()
        };
        let d = enrich_and_filter(raw, tmp.path());
        assert_eq!(d.commands.len(), 1);
        assert_eq!(d.commands[0].description.as_deref(), Some("from project"));
    }

    #[test]
    fn enrich_classifies_plugin_and_agent_correctly() {
        let tmp = tempfile::tempdir().unwrap();
        let raw = RawDiscovery {
            slash_commands: vec!["redmine:ticket".into(), "code-review".into(), "help".into()],
            plugins: vec![PluginEntry {
                name: "redmine".into(),
                path: None,
            }],
            agents: vec!["code-review".into()],
        };
        let d = enrich_and_filter(raw, tmp.path());
        let by_name: HashMap<&str, &SlashCommand> =
            d.commands.iter().map(|c| (c.name.as_str(), c)).collect();

        assert_eq!(by_name["redmine:ticket"].kind, SlashKind::Plugin);
        assert_eq!(by_name["redmine:ticket"].plugin.as_deref(), Some("redmine"));
        assert_eq!(by_name["code-review"].kind, SlashKind::Agent);
        assert_eq!(by_name["help"].kind, SlashKind::Builtin);
    }

    #[test]
    fn enrich_deduplicates_agents_that_appear_in_slash_commands() {
        let raw = RawDiscovery {
            slash_commands: vec!["reviewer".into()],
            plugins: vec![],
            agents: vec!["reviewer".into()],
        };
        let tmp = tempfile::tempdir().unwrap();
        let d = enrich_and_filter(raw, tmp.path());
        assert_eq!(d.commands.len(), 1);
    }

    #[test]
    fn run_discovery_parses_mock_init_stream() {
        let script = format!("{}\n", sample_init_json());
        let runtime = MockRuntime::new(&script);
        let raw = run_discovery(&runtime, "test-container").expect("init parsed");
        assert!(raw.slash_commands.iter().any(|n| n == "help"));
        assert_eq!(raw.plugins.len(), 1);
    }

    #[test]
    fn run_discovery_fails_when_no_init_line() {
        let script = "just some text\nmore noise\n".to_string();
        let runtime = MockRuntime::new(&script);
        let err = run_discovery(&runtime, "test-container").expect_err("should fail");
        let msg = err.to_string();
        assert!(msg.contains("no system/init") || msg.contains("no output"));
    }

    #[test]
    fn run_discovery_fails_when_container_not_running() {
        let runtime = FailingRuntime;
        let err = run_discovery(&runtime, "test-container").expect_err("should fail");
        assert!(err.to_string().contains("container not running"));
    }

    #[test]
    fn discover_slash_commands_returns_fallback_when_container_unavailable() {
        invalidate_all_caches();
        let project = ProjectHandle::new(unique_project_name("fallback"), std::env::temp_dir());
        let runtime = FailingRuntime;
        let d = discover_slash_commands(&runtime, &project).unwrap();
        assert_eq!(d.source, DiscoverySource::Fallback);
        assert!(d.commands.iter().any(|c| c.name == "help"));
    }

    #[test]
    fn discover_slash_commands_caches_results() {
        invalidate_all_caches();
        let script = format!("{}\n", sample_init_json());
        let project = ProjectHandle::new(unique_project_name("cache"), std::env::temp_dir());
        let runtime = MockRuntime::new(&script);

        let first = discover_slash_commands(&runtime, &project).unwrap();
        assert_eq!(first.source, DiscoverySource::Init);
        assert!(first.commands.iter().any(|c| c.name == "my-skill"));

        // Switching to a failing runtime would normally return fallback,
        // but the cached Init result must be returned instead.
        let failing = FailingRuntime;
        let second = discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(second.source, DiscoverySource::Init);
        assert_eq!(first, second);

        invalidate_cache(&project.name);
        // After invalidation, the failing runtime must produce Fallback.
        let third = discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(third.source, DiscoverySource::Fallback);
    }

    #[test]
    fn parse_init_line_ignores_trailing_whitespace() {
        let src = format!("   {}   \n", sample_init_json());
        assert!(parse_init_line(&src).is_some());
    }

    #[test]
    fn personal_claude_dir_resolves_to_home() {
        // The function just concatenates `HOME/.claude`; as long as HOME
        // is set to a non-empty path the result is Some.
        let home = dirs::home_dir();
        let personal = personal_claude_dir();
        assert_eq!(home.map(|h| h.join(".claude")), personal);
    }

    #[test]
    fn classify_kind_prefers_plugin_then_agent_then_builtin_then_command() {
        let agents = vec!["my-agent".to_string()];
        assert_eq!(
            classify_kind("anything", Some("p"), &agents),
            SlashKind::Plugin
        );
        assert_eq!(classify_kind("my-agent", None, &agents), SlashKind::Agent);
        assert_eq!(classify_kind("help", None, &agents), SlashKind::Builtin);
        assert_eq!(classify_kind("other", None, &agents), SlashKind::Command);
    }

    #[test]
    fn lookup_frontmatter_uses_plugin_path_when_provided() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tmp.path().join("plugin-x");
        let skill_dir = plugin_dir.join("skills").join("tool");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\ndescription: from plugin\n---\n",
        )
        .unwrap();

        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        let plugins = vec![PluginEntry {
            name: "plugin-x".into(),
            path: Some(plugin_dir.clone()),
        }];

        let (fm, origin) = lookup_frontmatter("tool", Some("plugin-x"), &project_dir, None, &plugins);
        assert_eq!(fm.description.as_deref(), Some("from plugin"));
        assert_eq!(origin, Some(FrontmatterOrigin::Skill));
    }

    #[test]
    fn skills_origin_promotes_command_to_skill_kind() {
        // A bare /tool name (no plugin prefix, not in agents/builtins) lands
        // under the project's .claude/skills/<name>/SKILL.md — it must
        // surface in the UI with kind=Skill, not the default kind=Command.
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        let skill_dir = project.join(".claude/skills/tool");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\ndescription: a project skill\n---\n",
        )
        .unwrap();

        let raw = RawDiscovery {
            slash_commands: vec!["tool".into()],
            plugins: vec![],
            agents: vec![],
        };
        let discovery = enrich_and_filter(raw, &project);
        assert_eq!(discovery.commands.len(), 1);
        assert_eq!(discovery.commands[0].kind, SlashKind::Skill);
    }
}
