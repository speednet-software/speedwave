//! Slash command discovery: parses the `system/init` line from `claude -p`
//! for commands, plugins, and agents (cached per project, single-flight per project).

use crate::consts;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Hard cap on how long we wait for the `system/init` line from Claude Code
/// before giving up and returning `DiscoverySource::Unavailable`.
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(60);

/// How long a cached discovery result stays valid before re-running discovery.
/// Claude Code installs change rarely; 10 minutes balances freshness and cost.
const CACHE_STALENESS: Duration = Duration::from_secs(10 * 60);

/// Indicates whether the discovery result came from Claude Code itself
/// (`Init`) or discovery could not run (`Unavailable`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiscoverySource {
    /// Discovered from the `system/init` event emitted by `claude -p`.
    Init,
    /// Discovery timed out or the container was down; no commands to show.
    Unavailable,
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
    /// Whether this discovery came from Claude Code or could not run.
    pub source: DiscoverySource,
}

/// Minimal project view for the discovery function.
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

// Public API

/// Discovers slash commands for `project`'s active Claude session. Returns a
/// cached result younger than [`CACHE_STALENESS`], else runs+caches discovery.
pub fn discover_slash_commands(
    runtime: &crate::runtime::LockedRuntime,
    project: &ProjectHandle,
) -> anyhow::Result<SlashDiscovery> {
    discover_slash_commands_with_timeout(runtime, project, DISCOVERY_TIMEOUT)
}

/// Test seam for [`discover_slash_commands`] with an injectable timeout.
/// A failed run is never cached (returns `Unavailable` fresh every time).
fn discover_slash_commands_with_timeout(
    runtime: &crate::runtime::LockedRuntime,
    project: &ProjectHandle,
    timeout: Duration,
) -> anyhow::Result<SlashDiscovery> {
    if let Some(cached) = cache_get(&project.name) {
        return Ok(cached);
    }

    let container = claude_container_name(&project.name);
    let outcome = lead_discovery(&project.name, || {
        run_discovery_with_timeout(runtime, &container, timeout).map_err(|e| e.to_string())
    });

    match outcome {
        Ok(raw) => {
            let discovery = enrich_and_filter(raw, &project.dir, consts::data_dir().as_path());
            cache_put(&project.name, discovery.clone());
            Ok(discovery)
        }
        Err(err) => {
            log::warn!("slash discovery failed for '{}': {err}", project.name);
            Ok(SlashDiscovery {
                commands: vec![],
                source: DiscoverySource::Unavailable,
            })
        }
    }
}

/// One in-flight discovery slot: the shared result and a condvar so
/// followers can wait without polling.
struct InFlightSlot {
    result: Mutex<Option<Result<RawDiscovery, String>>>,
    ready: std::sync::Condvar,
}

fn in_flight_map() -> &'static Mutex<HashMap<String, std::sync::Arc<InFlightSlot>>> {
    static MAP: OnceLock<Mutex<HashMap<String, std::sync::Arc<InFlightSlot>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Publishes a leader-failure on drop when the leader never published a
/// result (panic/cancel safety), then removes the slot from the map.
struct LeaderGuard<'a> {
    project: &'a str,
    slot: std::sync::Arc<InFlightSlot>,
}

impl Drop for LeaderGuard<'_> {
    fn drop(&mut self) {
        {
            let mut res = match self.slot.result.lock() {
                Ok(r) => r,
                Err(p) => p.into_inner(),
            };
            if res.is_none() {
                *res = Some(Err("discovery leader failed".to_string()));
            }
        }
        self.slot.ready.notify_all();
        if let Ok(mut map) = in_flight_map().lock() {
            map.remove(self.project);
        }
    }
}

/// Runs `run` at most once per `project` across concurrent callers; other
/// callers block on the leader's result instead of re-running discovery.
fn lead_discovery(
    project: &str,
    run: impl FnOnce() -> Result<RawDiscovery, String>,
) -> Result<RawDiscovery, String> {
    let (slot, is_leader) = {
        let mut map = in_flight_map().lock().unwrap_or_else(|p| p.into_inner());
        match map.get(project) {
            Some(slot) => (std::sync::Arc::clone(slot), false),
            None => {
                let slot = std::sync::Arc::new(InFlightSlot {
                    result: Mutex::new(None),
                    ready: std::sync::Condvar::new(),
                });
                map.insert(project.to_string(), std::sync::Arc::clone(&slot));
                (slot, true)
            }
        }
    };
    if is_leader {
        let guard = LeaderGuard {
            project,
            slot: std::sync::Arc::clone(&slot),
        };
        let outcome = run();
        *guard.slot.result.lock().unwrap_or_else(|p| p.into_inner()) = Some(outcome.clone());
        guard.slot.ready.notify_all();
        drop(guard);
        outcome
    } else {
        let mut res = slot.result.lock().unwrap_or_else(|p| p.into_inner());
        while res.is_none() {
            res = slot.ready.wait(res).unwrap_or_else(|p| p.into_inner());
        }
        res.clone()
            .unwrap_or_else(|| Err("discovery leader failed".to_string()))
    }
}

/// Invalidates the cached discovery for one project. Call on plugin
/// install/remove, active-project change, or an explicit refresh.
pub fn invalidate_cache(project_name: &str) {
    match cache().lock() {
        Ok(mut map) => {
            map.remove(project_name);
        }
        Err(e) => log_cache_poisoned("invalidate_cache", &e),
    }
}

/// Invalidates every cached discovery. Useful on factory reset and at
/// the end of tests that share process state.
pub fn invalidate_all_caches() {
    match cache().lock() {
        Ok(mut map) => map.clear(),
        Err(e) => log_cache_poisoned("invalidate_all_caches", &e),
    }
}

/// True when trimmed `text` is exactly `/` — the slash-menu trigger. SSOT for
/// the "lone slash" rule (mirrored in TS composer `canSubmit`).
pub fn is_bare_slash(text: &str) -> bool {
    text.trim() == "/"
}

/// Logs a poisoned-mutex condition at `warn!`; the cache update is skipped.
fn log_cache_poisoned<G>(site: &str, err: &std::sync::PoisonError<G>) {
    log::warn!("slash discovery cache mutex poisoned at {site}: {err}; cache update skipped");
}

// Cache

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
    let mut map = match cache().lock() {
        Ok(map) => map,
        Err(e) => {
            log_cache_poisoned("cache_get", &e);
            return None;
        }
    };
    let entry = map.get(project_name)?;
    if entry.stored_at.elapsed() < CACHE_STALENESS {
        Some(entry.discovery.clone())
    } else {
        map.remove(project_name);
        None
    }
}

fn cache_put(project_name: &str, discovery: SlashDiscovery) {
    match cache().lock() {
        Ok(mut map) => {
            map.insert(
                project_name.to_string(),
                CachedDiscovery {
                    stored_at: Instant::now(),
                    discovery,
                },
            );
        }
        Err(e) => log_cache_poisoned("cache_put", &e),
    }
}

// Discovery (running claude -p and parsing the init event)

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

/// Runs `claude -p ... -- /` in `container` and returns the first parsed
/// `system/init` event. Test-only; production uses `run_discovery_with_timeout`.
#[cfg(test)]
fn run_discovery(
    runtime: &crate::runtime::LockedRuntime,
    container: &str,
) -> anyhow::Result<RawDiscovery> {
    run_discovery_with_timeout(runtime, container, DISCOVERY_TIMEOUT)
}

/// Reader events: one parsed init, EOF with the line count seen, or an IO error.
enum ReaderEvent {
    Init(RawDiscovery),
    Eof { saw_lines: bool },
    Err(std::io::Error),
}

fn run_discovery_with_timeout(
    runtime: &crate::runtime::LockedRuntime,
    container: &str,
    timeout: Duration,
) -> anyhow::Result<RawDiscovery> {
    let instance_id = crate::session::new_instance_id();
    let marker_argv = crate::session::instance_env_argv(&instance_id);
    let claude_argv = [
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
    let argv: Vec<&str> = marker_argv
        .iter()
        .map(String::as_str)
        .chain(claude_argv.iter().copied())
        .collect();

    let mut cmd = runtime.container_exec_piped(container, &argv)?;
    let start = Instant::now();
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("claude -p: stdout not captured"))?;

    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut lines = std::io::BufReader::new(stdout).lines();
        let mut saw_lines = false;
        for line in &mut lines {
            match line {
                Ok(l) => {
                    saw_lines = true;
                    if let Some(parsed) = parse_init_line(&l) {
                        let _ = tx.send(ReaderEvent::Init(parsed));
                        return;
                    }
                }
                Err(e) => {
                    let _ = tx.send(ReaderEvent::Err(e));
                    return;
                }
            }
        }
        let _ = tx.send(ReaderEvent::Eof { saw_lines });
    });

    match rx.recv_timeout(timeout) {
        Ok(ReaderEvent::Init(parsed)) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            Ok(parsed)
        }
        Ok(ReaderEvent::Eof { saw_lines }) => {
            let status = child.wait();
            let _ = reader.join();
            if saw_lines {
                anyhow::bail!("no system/init event in stdout before EOF");
            }
            let code = status
                .ok()
                .and_then(|s| s.code())
                .map_or_else(|| "unknown".to_string(), |c| c.to_string());
            anyhow::bail!(
                "exited without output (exit status {code} after {}ms)",
                start.elapsed().as_millis()
            );
        }
        Ok(ReaderEvent::Err(e)) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            Err(anyhow::Error::new(e).context("claude -p: read failed"))
        }
        Err(_) => {
            reap_in_container_bounded(runtime, container, &instance_id);
            let _ = child.kill();
            let _ = child.wait();
            // The reap kills by env marker, not by pipe fd: if the in-container
            // process still holds the write end, the reader never sees EOF and
            // joining would hang again. Wait briefly, then detach instead of blocking.
            if rx.recv_timeout(Duration::from_secs(2)).is_ok() {
                let _ = reader.join();
            } else {
                log::warn!(
                    "discovery reap: reader thread detached for '{container}' \
                     (in-container process may still hold the output pipe)"
                );
            }
            anyhow::bail!("timed out after {}s with no init", timeout.as_secs())
        }
    }
}

/// Reap the in-container claude by marker (host kill alone does not propagate);
/// the reap exec itself is bounded to 5s and then killed.
fn reap_in_container_bounded(
    runtime: &crate::runtime::LockedRuntime,
    container: &str,
    instance_id: &str,
) {
    let reap_argv = crate::session::kill_by_instance_command(instance_id);
    let argv: Vec<&str> = reap_argv.iter().map(String::as_str).collect();
    let Ok(mut cmd) = runtime.container_exec_piped(container, &argv) else {
        log::warn!("discovery reap: exec build failed for '{container}'");
        return;
    };
    let Ok(mut reap) = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        log::warn!("discovery reap: spawn failed for '{container}'");
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match reap.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = reap.kill();
                let _ = reap.wait();
                log::warn!("discovery reap: bounded kill after 5s for '{container}'");
                return;
            }
        }
    }
}

// Enrichment and filtering

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
/// Default-deny: a name with no provenance anywhere (plugin/agent/native/on-disk) is dropped.
fn enrich_and_filter(raw: RawDiscovery, project_dir: &Path, data_dir: &Path) -> SlashDiscovery {
    let personal_dir = personal_claude_dir();
    let mut commands: Vec<SlashCommand> = Vec::new();

    for name in raw.slash_commands {
        let (clean_name, plugin) = split_plugin_prefix(&name);
        let is_agent = raw.agents.iter().any(|a| a == clean_name);

        // Native allowlist hit (and not shadowed by a plugin/agent name): badge,
        // description and the show-filter come straight from the allowlist entry.
        if plugin.is_none() && !is_agent {
            if let Some(native) = crate::native_slash::native_command(clean_name) {
                if native.show {
                    commands.push(SlashCommand {
                        name: name.clone(),
                        description: Some(native.description.to_string()),
                        argument_hint: None,
                        kind: native.badge,
                        plugin: None,
                    });
                }
                continue;
            }
        }

        let kind = classify_kind(clean_name, plugin.as_deref(), &raw.agents);
        let (frontmatter, origin) = lookup_frontmatter(
            clean_name,
            plugin.as_deref(),
            project_dir,
            personal_dir.as_deref(),
            &raw.plugins,
        );

        // Plugin-prefixed and agent-matched names are kept even without an
        // on-disk hit; everything else needs project/personal/plugin OR
        // integration-resource provenance (default-deny for unknown natives).
        let (frontmatter, kind) = if plugin.is_some() || is_agent {
            (frontmatter, kind)
        } else if let Some(origin) = origin {
            let kind = if origin == FrontmatterOrigin::Skill {
                SlashKind::Skill
            } else {
                SlashKind::Command
            };
            (frontmatter, kind)
        } else if let Some((fm, origin)) = lookup_integration_frontmatter(clean_name, data_dir) {
            let kind = if origin == FrontmatterOrigin::Skill {
                SlashKind::Skill
            } else {
                SlashKind::Command
            };
            (fm, kind)
        } else {
            continue;
        };

        // Hide on `user-invocable: false` only, never `disable-model-invocation`;
        // this applies uniformly across every source, integration skills included.
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
        // Skip agents already present as slash_commands.
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

/// Classifies a command by plugin prefix, `agents` presence, and the native
/// allowlist. Default `Command` is the safest fallback (UI renders `cmd`).
fn classify_kind(name: &str, plugin: Option<&str>, agents: &[String]) -> SlashKind {
    if plugin.is_some() {
        return SlashKind::Plugin;
    }
    if agents.iter().any(|a| a == name) {
        return SlashKind::Agent;
    }
    if let Some(native) = crate::native_slash::native_command(name) {
        return native.badge;
    }
    // Default; refined to Skill by enrich_and_filter when the file is under skills/.
    SlashKind::Command
}

/// Returns the first on-disk frontmatter hit and its origin (`None` when no
/// file matched). Priority: project skills/commands → personal → plugin paths.
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
    // Scan remaining plugin paths for unprefixed skills/commands.
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
                // File exists without parseable frontmatter — still a kind hit.
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

/// Resolves `name` under `<data_dir>/claude-resources/<type>/integrations/<name>/`,
/// mirroring the entrypoint symlink layout.
fn lookup_integration_frontmatter(
    name: &str,
    data_dir: &Path,
) -> Option<(SlashFrontmatter, FrontmatterOrigin)> {
    let base = data_dir.join("claude-resources");
    let candidates = [
        (
            base.join("skills")
                .join("integrations")
                .join(name)
                .join("SKILL.md"),
            FrontmatterOrigin::Skill,
        ),
        (
            base.join("commands")
                .join("integrations")
                .join(format!("{name}.md")),
            FrontmatterOrigin::Command,
        ),
    ];

    for (candidate, origin) in candidates {
        match std::fs::read_to_string(&candidate) {
            Ok(contents) => {
                return Some((parse_frontmatter(&contents).unwrap_or_default(), origin));
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

    None
}

/// Returns the user's personal `.claude/` directory when the home
/// directory can be resolved; `None` otherwise.
fn personal_claude_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude"))
}

/// Parses YAML frontmatter bounded by `---` delimiters at the file top.
/// Returns `None` when the block is absent or the YAML is malformed.
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

// Helpers

fn claude_container_name(project: &str) -> String {
    format!("{}_{}_claude", consts::compose_prefix(), project)
}

// Tests

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code asserts via unwrap/expect"
)]
mod tests {
    use super::*;
    use crate::runtime::mock_runtime::MockRuntimeBuilder;

    #[test]
    fn is_bare_slash_matches_lone_slash_with_surrounding_whitespace() {
        assert!(is_bare_slash("/"));
        assert!(is_bare_slash("  /  "));
        assert!(is_bare_slash("\n/\t"));
    }

    #[test]
    fn is_bare_slash_rejects_real_commands_and_text() {
        // A real slash command and ordinary text are messages, not the trigger.
        assert!(!is_bare_slash("/code-review"));
        assert!(!is_bare_slash("/clear"));
        assert!(!is_bare_slash("what is 2/3?"));
        assert!(!is_bare_slash("hej"));
    }

    #[test]
    fn is_bare_slash_rejects_empty() {
        // Empty is blank, not the slash trigger — callers handle blank separately.
        assert!(!is_bare_slash(""));
        assert!(!is_bare_slash("   "));
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
    fn enrich_merges_agents_and_sorts() {
        let tmp = tempfile::tempdir().unwrap();
        let data_tmp = tempfile::tempdir().unwrap();
        for skill in ["zzz-skill", "aaa-skill"] {
            let skill_dir = tmp.path().join(".claude/skills").join(skill);
            std::fs::create_dir_all(&skill_dir).unwrap();
            std::fs::write(skill_dir.join("SKILL.md"), "---\ndescription: d\n---\n").unwrap();
        }
        let raw = RawDiscovery {
            slash_commands: vec!["clear".into(), "zzz-skill".into(), "aaa-skill".into()],
            plugins: vec![],
            agents: vec!["code-review".into()],
        };
        let d = enrich_and_filter(raw, tmp.path(), data_tmp.path());
        let names: Vec<&str> = d.commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["aaa-skill", "clear", "code-review", "zzz-skill"]
        );
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

        let visible_dir = tmp.path().join(".claude/skills/visible");
        std::fs::create_dir_all(&visible_dir).unwrap();
        std::fs::write(
            visible_dir.join("SKILL.md"),
            "---\ndescription: shown\n---\nbody\n",
        )
        .unwrap();

        let raw = RawDiscovery {
            slash_commands: vec!["hidden".into(), "visible".into()],
            ..RawDiscovery::default()
        };
        let data_tmp = tempfile::tempdir().unwrap();
        let d = enrich_and_filter(raw, tmp.path(), data_tmp.path());
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
        let data_tmp = tempfile::tempdir().unwrap();
        let d = enrich_and_filter(raw, tmp.path(), data_tmp.path());
        assert_eq!(d.commands.len(), 1);
        assert_eq!(d.commands[0].name, "user-only");
        assert_eq!(d.commands[0].description.as_deref(), Some("user only"));
    }

    #[test]
    fn enrich_prefers_project_skill_over_personal() {
        // Verify priority via a project skill's description (no HOME redirect).
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
        let data_tmp = tempfile::tempdir().unwrap();
        let d = enrich_and_filter(raw, tmp.path(), data_tmp.path());
        assert_eq!(d.commands.len(), 1);
        assert_eq!(d.commands[0].description.as_deref(), Some("from project"));
    }

    #[test]
    fn enrich_classifies_plugin_and_agent_correctly() {
        let tmp = tempfile::tempdir().unwrap();
        let data_tmp = tempfile::tempdir().unwrap();
        let raw = RawDiscovery {
            slash_commands: vec![
                "redmine:ticket".into(),
                "code-review".into(),
                "clear".into(),
            ],
            plugins: vec![PluginEntry {
                name: "redmine".into(),
                path: None,
            }],
            agents: vec!["code-review".into()],
        };
        let d = enrich_and_filter(raw, tmp.path(), data_tmp.path());
        let by_name: HashMap<&str, &SlashCommand> =
            d.commands.iter().map(|c| (c.name.as_str(), c)).collect();

        assert_eq!(by_name["redmine:ticket"].kind, SlashKind::Plugin);
        assert_eq!(by_name["redmine:ticket"].plugin.as_deref(), Some("redmine"));
        assert_eq!(by_name["code-review"].kind, SlashKind::Agent);
        assert_eq!(by_name["clear"].kind, SlashKind::Builtin);
    }

    #[test]
    fn enrich_deduplicates_agents_that_appear_in_slash_commands() {
        let raw = RawDiscovery {
            slash_commands: vec!["reviewer".into()],
            plugins: vec![],
            agents: vec!["reviewer".into()],
        };
        let tmp = tempfile::tempdir().unwrap();
        let data_tmp = tempfile::tempdir().unwrap();
        let d = enrich_and_filter(raw, tmp.path(), data_tmp.path());
        assert_eq!(d.commands.len(), 1);
    }

    #[test]
    fn run_discovery_parses_mock_init_stream() {
        let script = format!("{}\n", sample_init_json());
        let (runtime, _) = MockRuntimeBuilder::new()
            .with_exec_piped_script(&script)
            .build();
        let raw = run_discovery(&runtime, "test-container").expect("init parsed");
        assert!(raw.slash_commands.iter().any(|n| n == "help"));
        assert_eq!(raw.plugins.len(), 1);
    }

    #[test]
    fn run_discovery_reports_exited_without_output_with_status_and_elapsed() {
        let (runtime, _) = MockRuntimeBuilder::new().with_exec_piped_script("").build();
        let start = std::time::Instant::now();
        let err = run_discovery(&runtime, "test-container").expect_err("should fail");
        let msg = err.to_string();
        assert!(msg.starts_with("exited without output"), "got: {msg}");
        assert!(msg.contains("exit status"), "got: {msg}");
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn run_discovery_reports_no_init_when_lines_never_match() {
        let (runtime, _) = MockRuntimeBuilder::new()
            .with_exec_piped_script("noise\nmore noise\n")
            .build();
        let err = run_discovery(&runtime, "test-container").expect_err("should fail");
        assert!(err.to_string().starts_with("no system/init"), "got: {err}");
    }

    #[test]
    fn run_discovery_passes_spawn_errors_through() {
        let (runtime, _) = MockRuntimeBuilder::new()
            .with_exec_piped_error("container not running")
            .build();
        let err = run_discovery(&runtime, "test-container").expect_err("should fail");
        assert!(err.to_string().contains("container not running"));
    }

    #[test]
    fn run_discovery_stamps_instance_marker_in_argv() {
        let (runtime, handles) = MockRuntimeBuilder::new()
            .with_exec_piped_script("noise\n")
            .build();
        let _ = run_discovery(&runtime, "test-container");
        let calls = handles.exec_calls.lock().unwrap();
        assert_eq!(calls[0].argv[0], "env");
        assert!(calls[0].argv[1].starts_with("SPW_SESSION_INSTANCE_ID="));
    }

    #[test]
    fn run_discovery_times_out_reaps_and_joins_under_deadline() {
        let (runtime, handles) = MockRuntimeBuilder::new()
            .with_exec_piped_hang(30)
            .with_exec_piped_script("")
            .build();
        let start = std::time::Instant::now();
        let err = run_discovery_with_timeout(
            &runtime,
            "test-container",
            std::time::Duration::from_millis(100),
        )
        .expect_err("must time out");
        assert!(err.to_string().starts_with("timed out"), "got: {err}");
        assert!(
            start.elapsed() < std::time::Duration::from_secs(5),
            "reap/join must be bounded"
        );
        let calls = handles.exec_calls.lock().unwrap();
        assert_eq!(calls.len(), 2, "spawn + reap expected, got {calls:?}");
        let reap_argv = calls[1].argv.join(" ");
        assert!(
            reap_argv.contains("SPW_SESSION_INSTANCE_ID"),
            "reap must target the marker: {reap_argv}"
        );
    }

    #[test]
    fn run_discovery_detaches_blocked_reader_when_pipe_survives_kill() {
        let (runtime, handles) = MockRuntimeBuilder::new()
            .with_exec_piped_orphan_hang(30)
            .with_exec_piped_script("")
            .build();
        let start = std::time::Instant::now();
        let err = run_discovery_with_timeout(
            &runtime,
            "test-container",
            std::time::Duration::from_millis(100),
        )
        .expect_err("must time out even when the pipe survives the kill");
        assert!(err.to_string().starts_with("timed out"), "got: {err}");
        assert!(
            start.elapsed() < std::time::Duration::from_secs(5),
            "must not hang on an orphaned reader thread"
        );
        let calls = handles.exec_calls.lock().unwrap();
        assert_eq!(calls.len(), 2, "spawn + reap expected, got {calls:?}");
    }

    #[test]
    fn failed_discovery_returns_unavailable_and_is_never_cached() {
        invalidate_all_caches();
        let project = ProjectHandle::new(unique_project_name("nocache"), std::env::temp_dir());
        let (failing, handles) = MockRuntimeBuilder::new()
            .with_exec_piped_error("container not running")
            .build();
        let first = discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(first.source, DiscoverySource::Unavailable);
        assert!(first.commands.is_empty());
        let second = discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(second.source, DiscoverySource::Unavailable);
        assert_eq!(
            handles.exec_calls.lock().unwrap().len(),
            2,
            "no failure caching"
        );
    }

    #[test]
    fn discover_slash_commands_caches_results() {
        invalidate_all_caches();
        let script = format!("{}\n", sample_init_json());
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".claude/skills/my-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\ndescription: a test skill\n---\n",
        )
        .unwrap();
        let project = ProjectHandle::new(unique_project_name("cache"), tmp.path());
        let (runtime, _) = MockRuntimeBuilder::new()
            .with_exec_piped_script(&script)
            .build();

        let first = discover_slash_commands(&runtime, &project).unwrap();
        assert_eq!(first.source, DiscoverySource::Init);
        assert!(first.commands.iter().any(|c| c.name == "my-skill"));

        // A failing runtime must still return the cached Init result.
        let (failing, _) = MockRuntimeBuilder::new()
            .with_exec_piped_error("container not running")
            .build();
        let second = discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(second.source, DiscoverySource::Init);
        assert_eq!(first, second);

        invalidate_cache(&project.name);
        // After invalidation, the failing runtime must produce Unavailable.
        let third = discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(third.source, DiscoverySource::Unavailable);
    }

    #[test]
    fn parse_init_line_ignores_trailing_whitespace() {
        let src = format!("   {}   \n", sample_init_json());
        assert!(parse_init_line(&src).is_some());
    }

    #[test]
    fn personal_claude_dir_resolves_to_home() {
        // Result is `HOME/.claude` whenever HOME resolves.
        let home = dirs::home_dir();
        let personal = personal_claude_dir();
        assert_eq!(home.map(|h| h.join(".claude")), personal);
    }

    #[test]
    fn classify_kind_prefers_plugin_then_agent_then_native_then_command() {
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

        let (fm, origin) =
            lookup_frontmatter("tool", Some("plugin-x"), &project_dir, None, &plugins);
        assert_eq!(fm.description.as_deref(), Some("from plugin"));
        assert_eq!(origin, Some(FrontmatterOrigin::Skill));
    }

    #[test]
    fn concurrent_discovery_runs_exactly_one_exec_and_shares_the_result() {
        invalidate_all_caches();
        let project = unique_project_name("single-flight");
        // One-shot hang (2s) gates the leader long enough for followers to attach;
        // 300ms injected timeout keeps the whole test far under the sleep.
        let (runtime, handles) = MockRuntimeBuilder::new()
            .with_exec_piped_hang(2)
            .with_exec_piped_script("")
            .build();
        let rt = &runtime;
        let results: Vec<_> = std::thread::scope(|s| {
            let hs: Vec<_> = (0..4)
                .map(|_| {
                    s.spawn(|| {
                        let handle = ProjectHandle::new(&project, std::env::temp_dir());
                        discover_slash_commands_with_timeout(
                            rt,
                            &handle,
                            std::time::Duration::from_millis(300),
                        )
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let sources: Vec<_> = results.iter().map(|r| r.as_ref().unwrap().source).collect();
        assert!(sources.iter().all(|s| *s == DiscoverySource::Unavailable));
        let spawn_calls = handles
            .exec_calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.argv.iter().any(|a| a == consts::CLAUDE_BINARY))
            .count();
        assert_eq!(spawn_calls, 1, "followers must share the leader's run");
    }

    #[test]
    fn leader_panic_publishes_error_instead_of_deadlocking_followers() {
        // Real synchronization, not a sleep race: the leader's closure signals
        // `started_tx` right before blocking on `release_rx`, so the main thread
        // only spawns the follower after `lead_discovery` has synchronously
        // inserted the slot (see `lead_discovery`) - the follower is thus
        // guaranteed to attach to a live slot instead of racing to become a
        // second leader. Dropping `release_tx` then unblocks the leader's
        // `recv()`, which panics.
        let project = unique_project_name("panic");
        let p2 = project.clone();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
        let leader = std::thread::spawn(move || {
            let _ = lead_discovery(&p2, move || {
                let _ = started_tx.send(());
                let _ = release_rx.recv();
                panic!("boom")
            });
        });
        started_rx
            .recv()
            .expect("leader must signal it has started");
        let follower_project = project.clone();
        let follower =
            std::thread::spawn(move || lead_discovery(&follower_project, || unreachable!()));
        drop(release_tx);
        assert!(leader.join().is_err(), "leader must have panicked");
        let res = follower.join().unwrap();
        assert_eq!(res.unwrap_err(), "discovery leader failed");
    }

    #[test]
    fn skills_origin_promotes_command_to_skill_kind() {
        // A bare name under .claude/skills/ must surface as kind=Skill.
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
        let data_tmp = tempfile::tempdir().unwrap();
        let discovery = enrich_and_filter(raw, &project, data_tmp.path());
        assert_eq!(discovery.commands.len(), 1);
        assert_eq!(discovery.commands[0].kind, SlashKind::Skill);
    }

    #[test]
    fn enrich_shows_visible_native_with_allowlist_description() {
        let raw = RawDiscovery {
            slash_commands: vec!["clear".into()],
            ..RawDiscovery::default()
        };
        let tmp = tempfile::tempdir().unwrap();
        let data_tmp = tempfile::tempdir().unwrap();
        let d = enrich_and_filter(raw, tmp.path(), data_tmp.path());
        assert_eq!(d.commands.len(), 1);
        assert_eq!(d.commands[0].kind, SlashKind::Builtin);
        assert!(!d.commands[0]
            .description
            .as_deref()
            .unwrap_or_default()
            .is_empty());
    }

    #[test]
    fn enrich_drops_hidden_native() {
        let raw = RawDiscovery {
            slash_commands: vec!["doctor".into()],
            ..RawDiscovery::default()
        };
        let tmp = tempfile::tempdir().unwrap();
        let data_tmp = tempfile::tempdir().unwrap();
        let d = enrich_and_filter(raw, tmp.path(), data_tmp.path());
        assert!(d.commands.is_empty());
    }

    #[test]
    fn enrich_drops_unknown_unprefixed_unresolved_name() {
        let raw = RawDiscovery {
            slash_commands: vec!["mystery-cmd".into()],
            ..RawDiscovery::default()
        };
        let tmp = tempfile::tempdir().unwrap();
        let data_tmp = tempfile::tempdir().unwrap();
        let d = enrich_and_filter(raw, tmp.path(), data_tmp.path());
        assert!(d.commands.is_empty());
    }

    #[test]
    fn enrich_keeps_plugin_prefixed_and_agents() {
        let raw = RawDiscovery {
            slash_commands: vec!["redmine:ticket".into()],
            plugins: vec![PluginEntry {
                name: "redmine".into(),
                path: None,
            }],
            agents: vec!["my-agent".into()],
        };
        let tmp = tempfile::tempdir().unwrap();
        let data_tmp = tempfile::tempdir().unwrap();
        let d = enrich_and_filter(raw, tmp.path(), data_tmp.path());
        let names: Vec<&str> = d.commands.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"redmine:ticket"));
        assert!(names.contains(&"my-agent"));
        let by_name: HashMap<&str, &SlashCommand> =
            d.commands.iter().map(|c| (c.name.as_str(), c)).collect();
        assert_eq!(by_name["redmine:ticket"].kind, SlashKind::Plugin);
        assert_eq!(by_name["my-agent"].kind, SlashKind::Agent);
    }

    #[test]
    fn enrich_hides_integration_skill_declaring_user_invocable_false() {
        let data_tmp = tempfile::tempdir().unwrap();
        let skill_dir = data_tmp
            .path()
            .join("claude-resources/skills/integrations/redmine");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\ndescription: redmine skill\nuser-invocable: false\n---\n",
        )
        .unwrap();

        let raw = RawDiscovery {
            slash_commands: vec!["redmine".into()],
            ..RawDiscovery::default()
        };
        let tmp = tempfile::tempdir().unwrap();
        let d = enrich_and_filter(raw, tmp.path(), data_tmp.path());
        assert!(d.commands.is_empty());
    }

    #[test]
    fn enrich_shows_integration_skill_without_user_invocable_key() {
        let data_tmp = tempfile::tempdir().unwrap();
        let skill_dir = data_tmp
            .path()
            .join("claude-resources/skills/integrations/redmine");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\ndescription: redmine skill\n---\n",
        )
        .unwrap();

        let raw = RawDiscovery {
            slash_commands: vec!["redmine".into()],
            ..RawDiscovery::default()
        };
        let tmp = tempfile::tempdir().unwrap();
        let d = enrich_and_filter(raw, tmp.path(), data_tmp.path());
        assert_eq!(d.commands.len(), 1);
        assert_eq!(d.commands[0].kind, SlashKind::Skill);
        assert_eq!(d.commands[0].description.as_deref(), Some("redmine skill"));
    }
}
