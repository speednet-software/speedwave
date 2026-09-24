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

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(60);

const CACHE_STALENESS: Duration = Duration::from_secs(10 * 60);

const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(30);

const FRONTMATTER_READ_LIMIT: u64 = 64 * 1024;

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
    /// Why discovery failed, when `source == Unavailable`. `None` on success.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reason: Option<String>,
}

/// Minimal project view for the discovery function.
#[derive(Debug, Clone)]
pub struct ProjectHandle {
    /// Project name as used in `speedwave_<name>_claude` container names.
    pub name: String,
    /// Absolute path to the project root, used to locate `<dir>/.claude/`.
    pub dir: PathBuf,
    /// Config keys of the plugins enabled for the project, whose resources the container links.
    pub enabled_plugins: Vec<String>,
}

impl ProjectHandle {
    /// Builds a handle from the public fields we already store in configs.
    pub fn new(name: impl Into<String>, dir: impl Into<PathBuf>) -> Self {
        Self {
            name: name.into(),
            dir: dir.into(),
            enabled_plugins: Vec::new(),
        }
    }

    /// Sets the enabled plugin keys (`ResolvedIntegrationsConfig::enabled_plugin_service_ids`).
    pub fn with_enabled_plugins(mut self, keys: Vec<String>) -> Self {
        self.enabled_plugins = keys;
        self
    }
}

/// Discovers slash commands for `project`'s active Claude session. Returns a
/// cached result younger than [`CACHE_STALENESS`], else runs+caches discovery.
pub fn discover_slash_commands(
    runtime: &crate::runtime::LockedRuntime,
    project: &ProjectHandle,
) -> anyhow::Result<SlashDiscovery> {
    discover_slash_commands_with_timeout(runtime, project, DISCOVERY_TIMEOUT)
}

fn discover_slash_commands_with_timeout(
    runtime: &crate::runtime::LockedRuntime,
    project: &ProjectHandle,
    timeout: Duration,
) -> anyhow::Result<SlashDiscovery> {
    if let Some(cached) = cache_get(&project.name) {
        return Ok(cached);
    }

    let generation = cache_generation(&project.name);
    let container = claude_container_name(&project.name);
    let outcome = lead_discovery(&project.name, || {
        run_discovery_with_timeout(runtime, &container, timeout).map_err(|e| e.to_string())
    });

    match outcome {
        Ok(raw) => {
            let discovery = enrich_and_filter(raw, project, consts::data_dir().as_path());
            cache_put(&project.name, generation, discovery.clone());
            Ok(discovery)
        }
        Err(err) => {
            log::warn!("slash discovery failed for '{}': {err}", project.name);
            let discovery = SlashDiscovery {
                commands: vec![],
                source: DiscoverySource::Unavailable,
                reason: Some(err),
            };
            cache_put(&project.name, generation, discovery.clone());
            Ok(discovery)
        }
    }
}

struct InFlightSlot {
    result: Mutex<Option<Result<RawDiscovery, String>>>,
    ready: std::sync::Condvar,
}

fn in_flight_map() -> &'static Mutex<HashMap<String, std::sync::Arc<InFlightSlot>>> {
    static MAP: OnceLock<Mutex<HashMap<String, std::sync::Arc<InFlightSlot>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

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
        follow_slot(&slot)
    }
}

fn follow_slot(slot: &InFlightSlot) -> Result<RawDiscovery, String> {
    let mut res = slot.result.lock().unwrap_or_else(|p| p.into_inner());
    while res.is_none() {
        res = slot.ready.wait(res).unwrap_or_else(|p| p.into_inner());
    }
    res.clone()
        .unwrap_or_else(|| Err("discovery leader failed".to_string()))
}

/// Drops the cached discovery for one project and retires any discovery in flight for it.
pub fn invalidate_cache(project_name: &str) {
    match cache().lock() {
        Ok(mut state) => {
            state.entries.remove(project_name);
            *state
                .generations
                .entry(project_name.to_string())
                .or_insert(0) += 1;
        }
        Err(e) => log_cache_poisoned("invalidate_cache", &e),
    }
}

/// True when trimmed `text` is exactly `/` — the slash-menu trigger. SSOT for
/// the "lone slash" rule (mirrored in TS `isBareSlash`, slash.service.ts;
/// consumed by composer `canSubmit` and `chat-state.service.ts`).
pub fn is_bare_slash(text: &str) -> bool {
    text.trim() == "/"
}

/// not `\s+` — a tab does not match), returning `(command, argument)`. SSOT for
/// control-chip shape, called by both live emission and history reconstruction.
pub fn parse_control_command(text: &str) -> Option<(&str, &str)> {
    let trimmed = text.trim();
    let (command, argument) = trimmed
        .strip_prefix("/model ")
        .map(|arg| ("model", arg))
        .or_else(|| trimmed.strip_prefix("/effort ").map(|arg| ("effort", arg)))?;
    let argument = argument.trim_start();
    if argument.is_empty() || argument.contains(char::is_whitespace) {
        return None;
    }
    Some((command, argument))
}

fn log_cache_poisoned<G>(site: &str, err: &std::sync::PoisonError<G>) {
    log::warn!("slash discovery cache mutex poisoned at {site}: {err}; cache update skipped");
}

#[derive(Clone)]
struct CachedDiscovery {
    stored_at: Instant,
    discovery: SlashDiscovery,
}

#[derive(Default)]
struct CacheState {
    entries: HashMap<String, CachedDiscovery>,
    generations: HashMap<String, u64>,
}

impl CacheState {
    fn generation(&self, project_name: &str) -> u64 {
        self.generations.get(project_name).copied().unwrap_or(0)
    }
}

fn cache() -> &'static Mutex<CacheState> {
    static CACHE: OnceLock<Mutex<CacheState>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(CacheState::default()))
}

fn cache_generation(project_name: &str) -> Option<u64> {
    match cache().lock() {
        Ok(state) => Some(state.generation(project_name)),
        Err(e) => {
            log_cache_poisoned("cache_generation", &e);
            None
        }
    }
}

fn ttl_for(discovery: &SlashDiscovery) -> Duration {
    match discovery.source {
        DiscoverySource::Init => CACHE_STALENESS,
        DiscoverySource::Unavailable => NEGATIVE_CACHE_TTL,
    }
}

fn cache_get(project_name: &str) -> Option<SlashDiscovery> {
    let mut state = match cache().lock() {
        Ok(state) => state,
        Err(e) => {
            log_cache_poisoned("cache_get", &e);
            return None;
        }
    };
    let entry = state.entries.get(project_name)?;
    if entry.stored_at.elapsed() < ttl_for(&entry.discovery) {
        Some(entry.discovery.clone())
    } else {
        state.entries.remove(project_name);
        None
    }
}

#[cfg(test)]
fn backdate_cache_entry(project_name: &str, age: Duration) {
    if let Ok(mut state) = cache().lock() {
        if let Some(entry) = state.entries.get_mut(project_name) {
            entry.stored_at -= age;
        }
    }
}

fn cache_put(project_name: &str, generation: Option<u64>, discovery: SlashDiscovery) {
    let Some(generation) = generation else {
        return;
    };
    match cache().lock() {
        Ok(mut state) => {
            if state.generation(project_name) != generation {
                log::debug!(
                    "slash discovery for '{project_name}' finished after its containers changed; \
                     result not cached"
                );
                return;
            }
            state.entries.insert(
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

#[cfg(test)]
fn run_discovery(
    runtime: &crate::runtime::LockedRuntime,
    container: &str,
) -> anyhow::Result<RawDiscovery> {
    run_discovery_with_timeout(runtime, container, DISCOVERY_TIMEOUT)
}

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
    let mut env_argv = crate::session::instance_env_argv(&instance_id);
    env_argv.push(format!(
        "ANTHROPIC_BASE_URL={}",
        consts::CLAUDE_OFFLINE_BASE_URL
    ));
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
    let argv: Vec<&str> = env_argv
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
            if rx.recv_timeout(Duration::from_secs(2)).is_ok() {
                let _ = reader.join();
            } else {
                log::warn!(
                    "discovery reap: reader thread handed to background joiner for '{container}' \
                     (in-container process may still hold the output pipe)"
                );
                spawn_background_joiner(reader, container.to_string());
            }
            anyhow::bail!("timed out after {}s with no init", timeout.as_secs())
        }
    }
}

#[cfg(test)]
fn background_joins_completed() -> &'static std::sync::atomic::AtomicUsize {
    static COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    &COUNT
}

fn spawn_background_joiner(reader: std::thread::JoinHandle<()>, container: String) {
    std::thread::spawn(move || {
        let _ = reader.join();
        log::debug!("discovery reap: background-joined reader thread for '{container}'");
        #[cfg(test)]
        background_joins_completed().fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
}

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

#[derive(Debug, Default, Clone, Deserialize)]
struct SlashFrontmatter {
    description: Option<String>,
    #[serde(rename = "argument-hint")]
    argument_hint: Option<String>,
    #[serde(rename = "user-invocable")]
    user_invocable: Option<bool>,
}

fn linked_resource_dirs(data_dir: &Path, enabled_plugins: &[String]) -> Vec<PathBuf> {
    crate::plugin::enabled_claude_resources_dirs(
        &crate::plugin::plugins_base_dir_in(data_dir),
        enabled_plugins,
    )
    .into_iter()
    .rev()
    .chain(std::iter::once(data_dir.join("claude-resources")))
    .collect()
}

fn enrich_and_filter(
    raw: RawDiscovery,
    project: &ProjectHandle,
    data_dir: &Path,
) -> SlashDiscovery {
    let project_dir = project.dir.as_path();
    let resource_dirs = linked_resource_dirs(data_dir, &project.enabled_plugins);
    let personal_dir = crate::claude_home::claude_config_dir(data_dir, &project.name);
    let mut commands: Vec<SlashCommand> = Vec::new();

    for name in raw.slash_commands {
        let (clean_name, plugin) = split_plugin_prefix(&name);
        let is_agent = raw.agents.iter().any(|a| a == clean_name);
        let native = if plugin.is_none() && !is_agent {
            crate::native_slash::native_command(clean_name)
        } else {
            None
        };

        if let Some(native) = native {
            let (on_disk, _origin) = lookup_frontmatter(
                clean_name,
                None,
                project_dir,
                &[],
                Some(personal_dir.as_path()),
                &raw.plugins,
            );
            if matches!(on_disk.user_invocable, Some(false)) {
                continue;
            }
            if native.show {
                let description = on_disk
                    .description
                    .map(|d| d.trim().to_string())
                    .or_else(|| Some(native.description.to_string()));
                commands.push(SlashCommand {
                    name: name.clone(),
                    description,
                    argument_hint: on_disk.argument_hint,
                    kind: native.badge,
                    plugin: None,
                });
            }
            continue;
        }

        let kind = classify_kind(clean_name, plugin.as_deref(), &raw.agents);
        let unprefixed = plugin.is_none();
        let (frontmatter, origin) = lookup_frontmatter(
            clean_name,
            plugin.as_deref(),
            project_dir,
            if unprefixed { &resource_dirs } else { &[] },
            unprefixed.then_some(personal_dir.as_path()),
            &raw.plugins,
        );

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
        reason: None,
    }
}

fn split_plugin_prefix(name: &str) -> (&str, Option<String>) {
    match name.split_once(':') {
        Some((plugin, bare)) if !plugin.is_empty() && !bare.is_empty() => {
            (bare, Some(plugin.to_string()))
        }
        _ => (name, None),
    }
}

fn classify_kind(name: &str, plugin: Option<&str>, agents: &[String]) -> SlashKind {
    if plugin.is_some() {
        return SlashKind::Plugin;
    }
    if agents.iter().any(|a| a == name) {
        return SlashKind::Agent;
    }
    SlashKind::Command
}

fn lookup_frontmatter(
    name: &str,
    plugin: Option<&str>,
    project_dir: &Path,
    resource_dirs: &[PathBuf],
    personal_dir: Option<&Path>,
    plugins: &[PluginEntry],
) -> (SlashFrontmatter, Option<FrontmatterOrigin>) {
    if !is_plain_name(name) {
        return (SlashFrontmatter::default(), None);
    }
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
    for resource_dir in resource_dirs {
        push_skill_candidates(resource_dir, name, &mut candidates);
    }
    if let Some(plugin_name) = plugin {
        for plugin_entry in plugins.iter().filter(|p| p.name == plugin_name) {
            if let Some(path) = &plugin_entry.path {
                push_skill_candidates(path, name, &mut candidates);
            }
        }
    }
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
        match read_frontmatter_head(&candidate) {
            Ok(contents) => {
                if let Some(fm) = parse_frontmatter(&contents) {
                    return (fm, Some(origin));
                }
                return (SlashFrontmatter::default(), Some(origin));
            }
            Err(err) => {
                if err.kind() != std::io::ErrorKind::NotFound {
                    log::debug!(
                        "cannot read slash command frontmatter from {}: {err}",
                        candidate.display()
                    );
                }
            }
        }
    }

    (SlashFrontmatter::default(), None)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrontmatterOrigin {
    Skill,
    Command,
}

fn is_plain_name(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none()
}

fn read_frontmatter_head(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    if !std::fs::metadata(path)?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    let mut head = Vec::new();
    std::fs::File::open(path)?
        .take(FRONTMATTER_READ_LIMIT)
        .read_to_end(&mut head)?;
    Ok(String::from_utf8_lossy(&head).into_owned())
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

fn lookup_integration_frontmatter(
    name: &str,
    data_dir: &Path,
) -> Option<(SlashFrontmatter, FrontmatterOrigin)> {
    if !is_plain_name(name) {
        return None;
    }
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
        match read_frontmatter_head(&candidate) {
            Ok(contents) => {
                return Some((parse_frontmatter(&contents).unwrap_or_default(), origin));
            }
            Err(err) => {
                if err.kind() != std::io::ErrorKind::NotFound {
                    log::debug!(
                        "cannot read slash command frontmatter from {}: {err}",
                        candidate.display()
                    );
                }
            }
        }
    }

    None
}

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

fn claude_container_name(project: &str) -> String {
    format!(
        "{}_{}_{}",
        consts::compose_prefix(),
        project,
        consts::CLAUDE_COMPOSE_SERVICE
    )
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code asserts via unwrap/expect"
)]
mod tests {
    use super::*;
    use crate::runtime::mock_runtime::{MockHandles, MockRuntimeBuilder};

    #[test]
    fn is_bare_slash_matches_lone_slash_with_surrounding_whitespace() {
        assert!(is_bare_slash("/"));
        assert!(is_bare_slash("  /  "));
        assert!(is_bare_slash("\n/\t"));
    }

    #[test]
    fn is_bare_slash_rejects_real_commands_and_text() {
        assert!(!is_bare_slash("/code-review"));
        assert!(!is_bare_slash("/clear"));
        assert!(!is_bare_slash("what is 2/3?"));
        assert!(!is_bare_slash("hej"));
    }

    #[test]
    fn is_bare_slash_rejects_empty() {
        assert!(!is_bare_slash(""));
        assert!(!is_bare_slash("   "));
    }

    #[test]
    fn is_bare_slash_matches_ts_mirror() {
        let src = include_str!("../../../desktop/src/src/app/chat/slash/slash.service.ts");
        let re = regex::Regex::new(
            r"export function isBareSlash\(text: string\): boolean \{\s*return text\.trim\(\) === '/';\s*\}",
        )
        .unwrap();
        assert!(
            re.is_match(src),
            "slash.service.ts::isBareSlash must stay `text.trim() === '/'` to match Rust is_bare_slash"
        );
    }

    #[test]
    fn is_bare_slash_doc_comment_names_its_actual_ts_mirror() {
        let src = include_str!("slash.rs");
        let lines: Vec<&str> = src.lines().collect();
        let doc_window = lines
            .windows(2)
            .find(|w| w[0].contains("SSOT for") && w[1].contains("lone slash"))
            .map(|w| format!("{} {}", w[0], w[1]))
            .expect("is_bare_slash doc comment must exist");
        assert!(
            doc_window.contains("isBareSlash"),
            "doc comment must name the real mirror (slash.service.ts::isBareSlash), \
             not composer canSubmit (canSubmit only consumes it): {doc_window:?}"
        );
    }

    #[test]
    fn parse_control_command_matches_model_with_argument() {
        assert_eq!(
            parse_control_command("/model claude-sonnet-5"),
            Some(("model", "claude-sonnet-5"))
        );
    }

    #[test]
    fn parse_control_command_matches_effort_with_argument() {
        assert_eq!(
            parse_control_command("/effort high"),
            Some(("effort", "high"))
        );
    }

    #[test]
    fn parse_control_command_trims_surrounding_whitespace() {
        assert_eq!(
            parse_control_command("  /model opus-4-8  "),
            Some(("model", "opus-4-8"))
        );
    }

    #[test]
    fn parse_control_command_accepts_unicode_argument() {
        assert_eq!(
            parse_control_command("/model modèle-🌊"),
            Some(("model", "modèle-🌊"))
        );
    }

    #[test]
    fn parse_control_command_rejects_extra_spaces_mid_argument() {
        assert_eq!(parse_control_command("/model claude sonnet"), None);
    }

    #[test]
    fn parse_control_command_rejects_multi_word_argument_generally() {
        assert_eq!(parse_control_command("/effort very high please"), None);
    }

    #[test]
    fn parse_control_command_rejects_unknown_command_name() {
        assert_eq!(parse_control_command("/modelx claude-sonnet-5"), None);
        assert_eq!(parse_control_command("/effortx high"), None);
    }

    #[test]
    fn parse_control_command_rejects_missing_argument() {
        assert_eq!(parse_control_command("/model"), None);
        assert_eq!(parse_control_command("/model "), None);
    }

    #[test]
    fn parse_control_command_rejects_plain_text_and_other_commands() {
        assert_eq!(parse_control_command("hello there"), None);
        assert_eq!(parse_control_command("/clear"), None);
        assert_eq!(parse_control_command("/help"), None);
    }

    #[test]
    fn parse_control_command_rejects_empty_and_bare_slash() {
        assert_eq!(parse_control_command(""), None);
        assert_eq!(parse_control_command("/"), None);
    }

    #[test]
    fn parse_control_command_matches_ts_is_control_shaped() {
        let src = include_str!("../../../desktop/src/src/app/chat/slash/slash.service.ts");
        let re = regex::Regex::new(
            r"const CONTROL_COMMAND_RE = /\^\\/\(model\|effort\) \+\(\\S\+\)\$/;",
        )
        .unwrap();
        assert!(
            re.is_match(src),
            "slash.service.ts::CONTROL_COMMAND_RE must stay `/^\\/(model|effort) +(\\S+)$/` \
             (literal space) to match Rust parse_control_command's `^/(model|effort) +\\S+$` shape"
        );
        let body_re = regex::Regex::new(
            r"export function isControlShaped\(text: string\): boolean \{\s*return CONTROL_COMMAND_RE\.test\(text\.trim\(\)\);\s*\}",
        )
        .unwrap();
        assert!(
            body_re.is_match(src),
            "slash.service.ts::isControlShaped must test CONTROL_COMMAND_RE against text.trim()"
        );
    }

    #[derive(Deserialize)]
    struct ControlShapeCase {
        input: String,
        is_control: bool,
    }

    #[test]
    fn parse_control_command_matches_shared_fixture_table() {
        let raw = include_str!("fixtures/control_command_shape.json");
        let cases: Vec<ControlShapeCase> =
            serde_json::from_str(raw).expect("fixture must be valid JSON");
        assert!(!cases.is_empty(), "fixture table must not be empty");
        for case in cases {
            let got = parse_control_command(&case.input).is_some();
            assert_eq!(
                got, case.is_control,
                "parse_control_command({:?}) = {got}, fixture expects is_control={}",
                case.input, case.is_control
            );
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
        let d = enrich_and_filter(raw, &test_project(tmp.path()), data_tmp.path());
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
        let d = enrich_and_filter(raw, &test_project(tmp.path()), data_tmp.path());
        let names: Vec<&str> = d.commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["visible"]);
    }

    #[test]
    fn enrich_keeps_disable_model_invocation_true() {
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
        let d = enrich_and_filter(raw, &test_project(tmp.path()), data_tmp.path());
        assert_eq!(d.commands.len(), 1);
        assert_eq!(d.commands[0].name, "user-only");
        assert_eq!(d.commands[0].description.as_deref(), Some("user only"));
    }

    #[test]
    fn enrich_prefers_project_skill_over_personal() {
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
        let d = enrich_and_filter(raw, &test_project(tmp.path()), data_tmp.path());
        assert_eq!(d.commands.len(), 1);
        assert_eq!(d.commands[0].description.as_deref(), Some("from project"));
    }

    #[test]
    fn enrich_native_hit_prefers_on_disk_description_over_allowlist() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".claude/skills/model");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\ndescription: my custom model picker\n---\n",
        )
        .unwrap();

        let raw = RawDiscovery {
            slash_commands: vec!["model".into()],
            ..RawDiscovery::default()
        };
        let data_tmp = tempfile::tempdir().unwrap();
        let d = enrich_and_filter(raw, &test_project(tmp.path()), data_tmp.path());
        assert_eq!(d.commands.len(), 1);
        assert_eq!(d.commands[0].name, "model");
        assert_eq!(d.commands[0].kind, SlashKind::Builtin);
        assert_eq!(
            d.commands[0].description.as_deref(),
            Some("my custom model picker"),
            "on-disk frontmatter must win over the native allowlist description"
        );
    }

    #[test]
    fn enrich_native_hit_falls_back_to_allowlist_description_without_on_disk_hit() {
        let tmp = tempfile::tempdir().unwrap();
        let raw = RawDiscovery {
            slash_commands: vec!["model".into()],
            ..RawDiscovery::default()
        };
        let data_tmp = tempfile::tempdir().unwrap();
        let d = enrich_and_filter(raw, &test_project(tmp.path()), data_tmp.path());
        assert_eq!(d.commands.len(), 1);
        assert_eq!(
            d.commands[0].description.as_deref(),
            Some("Show or switch the model for this session")
        );
    }

    #[test]
    fn enrich_native_hit_hidden_by_on_disk_user_invocable_false() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".claude/skills/model");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\ndescription: hidden model picker\nuser-invocable: false\n---\n",
        )
        .unwrap();

        let raw = RawDiscovery {
            slash_commands: vec!["model".into()],
            ..RawDiscovery::default()
        };
        let data_tmp = tempfile::tempdir().unwrap();
        let d = enrich_and_filter(raw, &test_project(tmp.path()), data_tmp.path());
        assert!(
            d.commands.is_empty(),
            "expected 'model' to be hidden by on-disk user-invocable: false, got {:?}",
            d.commands
        );
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
        let d = enrich_and_filter(raw, &test_project(tmp.path()), data_tmp.path());
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
        let d = enrich_and_filter(raw, &test_project(tmp.path()), data_tmp.path());
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
    fn run_discovery_sends_its_slash_prompt_to_no_model() {
        let (runtime, handles) = MockRuntimeBuilder::new()
            .with_exec_piped_script("noise\n")
            .build();
        let _ = run_discovery(&runtime, "test-container");
        let calls = handles.exec_calls.lock().unwrap();
        let argv = &calls[0].argv;
        let claude_at = argv
            .iter()
            .position(|arg| arg == consts::CLAUDE_BINARY)
            .expect("the discovery argv runs Claude Code");
        let closed_base_url = format!("ANTHROPIC_BASE_URL={}", consts::CLAUDE_OFFLINE_BASE_URL);
        assert!(
            argv[..claude_at].contains(&closed_base_url),
            "the `/` prompt must go to a closed port, not to a model: {argv:?}"
        );
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
    fn abandoned_reader_thread_is_background_joined_once_pipe_closes() {
        let before = background_joins_completed().load(std::sync::atomic::Ordering::SeqCst);
        let (runtime, _handles) = MockRuntimeBuilder::new()
            .with_exec_piped_orphan_hang(4)
            .with_exec_piped_script("")
            .build();
        let err = run_discovery_with_timeout(
            &runtime,
            "test-container",
            std::time::Duration::from_millis(100),
        )
        .expect_err("must time out while the pipe survives the kill");
        assert!(err.to_string().starts_with("timed out"), "got: {err}");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let after = background_joins_completed().load(std::sync::atomic::Ordering::SeqCst);
            if after > before {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "background joiner never reclaimed the abandoned reader thread"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    #[test]
    fn failed_discovery_is_negative_cached_within_ttl() {
        let project = ProjectHandle::new(unique_project_name("negcache"), std::env::temp_dir());
        let (failing, handles) = MockRuntimeBuilder::new()
            .with_exec_piped_error("container not running")
            .build();
        let first = discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(first.source, DiscoverySource::Unavailable);
        assert!(first.commands.is_empty());
        assert!(
            first
                .reason
                .as_deref()
                .unwrap_or_default()
                .contains("container not running"),
            "Err branch must populate reason: {:?}",
            first.reason
        );

        let second = discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(second.source, DiscoverySource::Unavailable);
        assert_eq!(second.reason, first.reason);
        assert_eq!(
            handles.exec_calls.lock().unwrap().len(),
            1,
            "second call within the negative TTL must not re-spawn the probe"
        );
    }

    #[test]
    fn negative_cache_expires_after_ttl_and_reprobes() {
        let project = ProjectHandle::new(unique_project_name("negttl"), std::env::temp_dir());
        let (failing, handles) = MockRuntimeBuilder::new()
            .with_exec_piped_error("container not running")
            .build();
        let first = discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(first.source, DiscoverySource::Unavailable);

        backdate_cache_entry(&project.name, NEGATIVE_CACHE_TTL);
        let second = discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(second.source, DiscoverySource::Unavailable);
        assert_eq!(
            handles.exec_calls.lock().unwrap().len(),
            2,
            "a call past the negative TTL must re-probe"
        );
    }

    #[test]
    fn invalidate_cache_clears_a_negative_entry() {
        let project =
            ProjectHandle::new(unique_project_name("neginvalidate"), std::env::temp_dir());
        let (failing, handles) = MockRuntimeBuilder::new()
            .with_exec_piped_error("container not running")
            .build();
        discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(handles.exec_calls.lock().unwrap().len(), 1);

        invalidate_cache(&project.name);
        discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(
            handles.exec_calls.lock().unwrap().len(),
            2,
            "invalidate_cache must clear the negative entry and force a re-probe"
        );
    }

    #[test]
    fn discover_slash_commands_caches_results() {
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
        assert_eq!(
            first.reason, None,
            "a successful discovery must carry no reason"
        );

        let (failing, _) = MockRuntimeBuilder::new()
            .with_exec_piped_error("container not running")
            .build();
        let second = discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(second.source, DiscoverySource::Init);
        assert_eq!(first, second);

        invalidate_cache(&project.name);
        let third = discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(third.source, DiscoverySource::Unavailable);
    }

    fn cache_a_real_discovery(project: &ProjectHandle) {
        let script = format!("{}\n", sample_init_json());
        let (working, _) = MockRuntimeBuilder::new()
            .with_exec_piped_script(&script)
            .build();
        assert_eq!(
            discover_slash_commands(&working, project).unwrap().source,
            DiscoverySource::Init
        );
    }

    fn failing_runtime() -> (crate::runtime::LockedRuntime, MockHandles) {
        MockRuntimeBuilder::new()
            .with_exec_piped_error("container not running")
            .build()
    }

    fn reap_compose_lock_dirs(projects: &[&str]) {
        for project in projects {
            crate::runtime::compose_locks::remove_project_lock_dir_for_test(project);
        }
    }

    #[test]
    fn a_compose_recreate_drops_the_cached_discovery() {
        let project = ProjectHandle::new(unique_project_name("recreate"), std::env::temp_dir());
        cache_a_real_discovery(&project);

        let (failing, handles) = failing_runtime();
        failing.compose_up_recreate(&project.name).unwrap();
        let after = discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(after.source, DiscoverySource::Unavailable);
        assert_eq!(
            handles.exec_calls.lock().unwrap().len(),
            1,
            "the recreate must drop the cached entry so discovery re-runs"
        );
        reap_compose_lock_dirs(&[&project.name]);
    }

    #[test]
    fn a_compose_up_drops_the_cached_discovery() {
        let project = ProjectHandle::new(unique_project_name("up"), std::env::temp_dir());
        cache_a_real_discovery(&project);

        let (failing, handles) = failing_runtime();
        failing.compose_up(&project.name).unwrap();
        let after = discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(after.source, DiscoverySource::Unavailable);
        assert_eq!(handles.exec_calls.lock().unwrap().len(), 1);
        reap_compose_lock_dirs(&[&project.name]);
    }

    #[test]
    fn a_failed_compose_up_still_drops_the_cached_discovery() {
        let project = ProjectHandle::new(unique_project_name("up-failed"), std::env::temp_dir());
        cache_a_real_discovery(&project);

        let (failing, handles) = MockRuntimeBuilder::new()
            .with_fail_on_up(&[project.name.as_str()])
            .with_exec_piped_error("container not running")
            .build();
        failing
            .compose_up(&project.name)
            .expect_err("the mock compose_up must fail");
        let after = discover_slash_commands(&failing, &project).unwrap();
        assert_eq!(after.source, DiscoverySource::Unavailable);
        assert_eq!(handles.exec_calls.lock().unwrap().len(), 1);
        reap_compose_lock_dirs(&[&project.name]);
    }

    #[test]
    fn a_compose_recreate_for_another_project_keeps_the_cache() {
        let project = ProjectHandle::new(unique_project_name("other"), std::env::temp_dir());
        let unrelated = unique_project_name("unrelated");
        cache_a_real_discovery(&project);

        let (failing, handles) = failing_runtime();
        failing.compose_up_recreate(&unrelated).unwrap();
        assert_eq!(
            discover_slash_commands(&failing, &project).unwrap().source,
            DiscoverySource::Init
        );
        assert!(handles.exec_calls.lock().unwrap().is_empty());
        reap_compose_lock_dirs(&[&unrelated]);
    }

    #[test]
    fn a_claude_service_recreate_drops_the_cached_discovery() {
        let project = ProjectHandle::new(unique_project_name("svc-claude"), std::env::temp_dir());
        cache_a_real_discovery(&project);

        let (failing, handles) = failing_runtime();
        failing
            .compose_up_service(&project.name, consts::CLAUDE_COMPOSE_SERVICE)
            .unwrap();
        assert_eq!(
            discover_slash_commands(&failing, &project).unwrap().source,
            DiscoverySource::Unavailable
        );
        assert_eq!(handles.exec_calls.lock().unwrap().len(), 1);
        reap_compose_lock_dirs(&[&project.name]);
    }

    #[test]
    fn a_proxy_service_recreate_keeps_the_cached_discovery() {
        let project = ProjectHandle::new(unique_project_name("svc-proxy"), std::env::temp_dir());
        cache_a_real_discovery(&project);

        let (failing, handles) = failing_runtime();
        failing.compose_up_service(&project.name, "proxy").unwrap();
        assert_eq!(
            discover_slash_commands(&failing, &project).unwrap().source,
            DiscoverySource::Init
        );
        assert!(handles.exec_calls.lock().unwrap().is_empty());
        reap_compose_lock_dirs(&[&project.name]);
    }

    fn discover_while_recreating(
        project: &ProjectHandle,
        recreated: &str,
    ) -> (SlashDiscovery, crate::runtime::LockedRuntime) {
        let (hanging, handles) = MockRuntimeBuilder::new()
            .with_exec_piped_hang(30)
            .with_exec_piped_script("")
            .build();
        let rt = &hanging;
        let outcome = std::thread::scope(|s| {
            let discovery = s.spawn(|| {
                discover_slash_commands_with_timeout(rt, project, Duration::from_millis(500))
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            while handles.exec_calls.lock().unwrap().is_empty() {
                assert!(
                    Instant::now() < deadline,
                    "discovery never spawned its probe"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            rt.compose_up_recreate(recreated).unwrap();
            discovery.join().unwrap().unwrap()
        });
        assert_eq!(outcome.source, DiscoverySource::Unavailable);
        (outcome, hanging)
    }

    #[test]
    fn a_recreate_during_an_in_flight_discovery_leaves_nothing_cached() {
        let project = ProjectHandle::new(unique_project_name("inflight"), std::env::temp_dir());
        discover_while_recreating(&project, &project.name);

        let script = format!("{}\n", sample_init_json());
        let (working, handles) = MockRuntimeBuilder::new()
            .with_exec_piped_script(&script)
            .build();
        let after = discover_slash_commands(&working, &project).unwrap();
        assert_eq!(
            after.source,
            DiscoverySource::Init,
            "a result produced against the replaced container must not be cached"
        );
        assert_eq!(handles.exec_calls.lock().unwrap().len(), 1);
        reap_compose_lock_dirs(&[&project.name]);
    }

    #[test]
    fn a_recreate_of_another_project_during_an_in_flight_discovery_keeps_the_result() {
        let project =
            ProjectHandle::new(unique_project_name("inflight-other"), std::env::temp_dir());
        let unrelated = unique_project_name("inflight-unrelated");
        let (first, _) = discover_while_recreating(&project, &unrelated);

        let (working, handles) = failing_runtime();
        let after = discover_slash_commands(&working, &project).unwrap();
        assert_eq!(after, first);
        assert!(handles.exec_calls.lock().unwrap().is_empty());
        reap_compose_lock_dirs(&[&unrelated]);
    }

    #[test]
    fn parse_init_line_ignores_trailing_whitespace() {
        let src = format!("   {}   \n", sample_init_json());
        assert!(parse_init_line(&src).is_some());
    }

    #[test]
    fn classify_kind_prefers_plugin_then_agent_then_command() {
        let agents = vec!["my-agent".to_string()];
        assert_eq!(
            classify_kind("anything", Some("p"), &agents),
            SlashKind::Plugin
        );
        assert_eq!(classify_kind("my-agent", None, &agents), SlashKind::Agent);
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
            lookup_frontmatter("tool", Some("plugin-x"), &project_dir, &[], None, &plugins);
        assert_eq!(fm.description.as_deref(), Some("from plugin"));
        assert_eq!(origin, Some(FrontmatterOrigin::Skill));
    }

    #[test]
    fn concurrent_discovery_runs_exactly_one_exec_and_shares_the_result() {
        let project = unique_project_name("single-flight");
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

    fn in_flight_slot_refs(project: &str) -> usize {
        in_flight_map()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(project)
            .map_or(0, std::sync::Arc::strong_count)
    }

    #[test]
    fn leader_panic_publishes_error_instead_of_deadlocking_followers() {
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
        let leader_refs = in_flight_slot_refs(&project);
        assert!(
            leader_refs > 0,
            "leader must have registered its in-flight slot"
        );
        let follower_project = project.clone();
        let follower =
            std::thread::spawn(move || lead_discovery(&follower_project, || unreachable!()));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while in_flight_slot_refs(&project) <= leader_refs {
            assert!(
                std::time::Instant::now() < deadline,
                "follower never joined the leader's in-flight slot"
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        drop(release_tx);
        assert!(leader.join().is_err(), "leader must have panicked");
        let res = follower.join().unwrap();
        assert_eq!(res.unwrap_err(), "discovery leader failed");
    }

    #[test]
    fn lookup_frontmatter_reads_bundled_core_skills_from_the_resources_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join("claude-resources");
        let skill_dir = bundled.join("skills").join("speedwave-grill-me");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\ndescription: from bundle\n---\n",
        )
        .unwrap();
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(&project_dir).unwrap();

        let (fm, origin) = lookup_frontmatter(
            "speedwave-grill-me",
            None,
            &project_dir,
            std::slice::from_ref(&bundled),
            None,
            &[],
        );
        assert_eq!(fm.description.as_deref(), Some("from bundle"));
        assert_eq!(origin, Some(FrontmatterOrigin::Skill));
    }

    #[test]
    fn lookup_frontmatter_prefers_the_project_over_bundled_resources() {
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join("claude-resources");
        let bundled_skill = bundled.join("skills").join("speedwave-grill-me");
        std::fs::create_dir_all(&bundled_skill).unwrap();
        std::fs::write(
            bundled_skill.join("SKILL.md"),
            "---\ndescription: from bundle\n---\n",
        )
        .unwrap();
        let project_dir = tmp.path().join("project");
        let project_skill = project_dir
            .join(".claude")
            .join("skills")
            .join("speedwave-grill-me");
        std::fs::create_dir_all(&project_skill).unwrap();
        std::fs::write(
            project_skill.join("SKILL.md"),
            "---\ndescription: from project\n---\n",
        )
        .unwrap();

        let (fm, _) = lookup_frontmatter(
            "speedwave-grill-me",
            None,
            &project_dir,
            std::slice::from_ref(&bundled),
            None,
            &[],
        );
        assert_eq!(fm.description.as_deref(), Some("from project"));
    }

    #[test]
    fn skills_origin_promotes_command_to_skill_kind() {
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
        let discovery = enrich_and_filter(raw, &test_project(&project), data_tmp.path());
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
        let d = enrich_and_filter(raw, &test_project(tmp.path()), data_tmp.path());
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
        let d = enrich_and_filter(raw, &test_project(tmp.path()), data_tmp.path());
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
        let d = enrich_and_filter(raw, &test_project(tmp.path()), data_tmp.path());
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
        let d = enrich_and_filter(raw, &test_project(tmp.path()), data_tmp.path());
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
        let d = enrich_and_filter(raw, &test_project(tmp.path()), data_tmp.path());
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
        let d = enrich_and_filter(raw, &test_project(tmp.path()), data_tmp.path());
        assert_eq!(d.commands.len(), 1);
        assert_eq!(d.commands[0].kind, SlashKind::Skill);
        assert_eq!(d.commands[0].description.as_deref(), Some("redmine skill"));
    }

    fn test_project(dir: &Path) -> ProjectHandle {
        ProjectHandle::new("test-project", dir)
    }

    fn with_plugins(dir: &Path, keys: &[&str]) -> ProjectHandle {
        test_project(dir).with_enabled_plugins(keys.iter().map(|k| k.to_string()).collect())
    }

    fn install_plugin_resource(data_dir: &Path, slug: &str, relative: &str, contents: &str) {
        let plugin_dir = crate::plugin::plugins_base_dir_in(data_dir).join(slug);
        let file = crate::plugin::plugin_claude_resources_dir(&plugin_dir).join(relative);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, contents).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            format!(r#"{{"name":"{slug}","slug":"{slug}","version":"1.0.0","description":"t"}}"#),
        )
        .unwrap();
    }

    fn write_bundled_skill(data_dir: &Path, name: &str, frontmatter: &str) {
        let skill_dir = data_dir.join("claude-resources/skills").join(name);
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), frontmatter).unwrap();
    }

    fn write_personal_skill(data_dir: &Path, project: &str, name: &str, description: &str) {
        let skill_dir = crate::claude_home::claude_config_dir(data_dir, project)
            .join("skills")
            .join(name);
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\ndescription: {description}\n---\n"),
        )
        .unwrap();
    }

    fn discover_names(names: &[&str]) -> RawDiscovery {
        RawDiscovery {
            slash_commands: names.iter().map(|n| n.to_string()).collect(),
            ..RawDiscovery::default()
        }
    }

    #[test]
    fn enrich_shows_a_skill_linked_from_an_enabled_speedwave_plugin() {
        let _g = crate::signing::test_support::UnsignedBypassGuard::new();
        let data_tmp = tempfile::tempdir().unwrap();
        install_plugin_resource(
            data_tmp.path(),
            "glpi",
            "skills/glpi-operations/SKILL.md",
            "---\ndescription: GLPI tickets\n---\n",
        );
        let tmp = tempfile::tempdir().unwrap();

        let d = enrich_and_filter(
            discover_names(&["glpi-operations"]),
            &with_plugins(tmp.path(), &["glpi"]),
            data_tmp.path(),
        );

        assert_eq!(d.commands.len(), 1, "got {:?}", d.commands);
        assert_eq!(d.commands[0].name, "glpi-operations");
        assert_eq!(d.commands[0].kind, SlashKind::Skill);
        assert_eq!(d.commands[0].description.as_deref(), Some("GLPI tickets"));
        assert_eq!(d.commands[0].plugin, None);
    }

    #[test]
    fn enrich_shows_a_command_linked_from_an_enabled_speedwave_plugin() {
        let _g = crate::signing::test_support::UnsignedBypassGuard::new();
        let data_tmp = tempfile::tempdir().unwrap();
        install_plugin_resource(
            data_tmp.path(),
            "presale",
            "commands/presale.md",
            "---\ndescription: Presale pipeline\nargument-hint: <rfp>\n---\n",
        );
        let tmp = tempfile::tempdir().unwrap();

        let d = enrich_and_filter(
            discover_names(&["presale"]),
            &with_plugins(tmp.path(), &["presale"]),
            data_tmp.path(),
        );

        assert_eq!(d.commands.len(), 1, "got {:?}", d.commands);
        assert_eq!(d.commands[0].kind, SlashKind::Command);
        assert_eq!(
            d.commands[0].description.as_deref(),
            Some("Presale pipeline")
        );
        assert_eq!(d.commands[0].argument_hint.as_deref(), Some("<rfp>"));
    }

    #[test]
    fn enrich_hides_a_plugin_skill_declaring_user_invocable_false() {
        let _g = crate::signing::test_support::UnsignedBypassGuard::new();
        let data_tmp = tempfile::tempdir().unwrap();
        install_plugin_resource(
            data_tmp.path(),
            "presale",
            "skills/presale-add/SKILL.md",
            "---\ndescription: internal step\nuser-invocable: false\n---\n",
        );
        let tmp = tempfile::tempdir().unwrap();

        let d = enrich_and_filter(
            discover_names(&["presale-add"]),
            &with_plugins(tmp.path(), &["presale"]),
            data_tmp.path(),
        );

        assert!(d.commands.is_empty(), "got {:?}", d.commands);
    }

    #[test]
    fn enrich_ignores_a_skill_from_a_plugin_not_enabled_in_the_project() {
        let _g = crate::signing::test_support::UnsignedBypassGuard::new();
        let data_tmp = tempfile::tempdir().unwrap();
        install_plugin_resource(
            data_tmp.path(),
            "glpi",
            "skills/glpi-operations/SKILL.md",
            "---\ndescription: GLPI tickets\n---\n",
        );
        let tmp = tempfile::tempdir().unwrap();

        let d = enrich_and_filter(
            discover_names(&["glpi-operations"]),
            &with_plugins(tmp.path(), &["presale"]),
            data_tmp.path(),
        );

        assert!(d.commands.is_empty(), "got {:?}", d.commands);
    }

    #[test]
    fn enrich_keeps_a_bundled_skill_that_a_disabled_plugin_would_hide() {
        let _g = crate::signing::test_support::UnsignedBypassGuard::new();
        let data_tmp = tempfile::tempdir().unwrap();
        write_bundled_skill(
            data_tmp.path(),
            "shared",
            "---\ndescription: from bundle\n---\n",
        );
        install_plugin_resource(
            data_tmp.path(),
            "extra",
            "skills/shared/SKILL.md",
            "---\ndescription: from plugin\nuser-invocable: false\n---\n",
        );
        let tmp = tempfile::tempdir().unwrap();

        let d = enrich_and_filter(
            discover_names(&["shared"]),
            &test_project(tmp.path()),
            data_tmp.path(),
        );

        assert_eq!(d.commands.len(), 1, "got {:?}", d.commands);
        assert_eq!(d.commands[0].description.as_deref(), Some("from bundle"));
    }

    #[test]
    fn enrich_prefers_a_plugin_skill_over_a_bundled_skill_of_the_same_name() {
        let _g = crate::signing::test_support::UnsignedBypassGuard::new();
        let data_tmp = tempfile::tempdir().unwrap();
        write_bundled_skill(
            data_tmp.path(),
            "shared",
            "---\ndescription: from bundle\n---\n",
        );
        install_plugin_resource(
            data_tmp.path(),
            "extra",
            "skills/shared/SKILL.md",
            "---\ndescription: from plugin\n---\n",
        );
        let tmp = tempfile::tempdir().unwrap();

        let d = enrich_and_filter(
            discover_names(&["shared"]),
            &with_plugins(tmp.path(), &["extra"]),
            data_tmp.path(),
        );

        assert_eq!(d.commands.len(), 1, "got {:?}", d.commands);
        assert_eq!(d.commands[0].description.as_deref(), Some("from plugin"));
    }

    #[test]
    fn enrich_takes_a_skill_two_plugins_share_from_the_plugin_linked_last() {
        let _g = crate::signing::test_support::UnsignedBypassGuard::new();
        let data_tmp = tempfile::tempdir().unwrap();
        for slug in ["alpha", "zeta"] {
            install_plugin_resource(
                data_tmp.path(),
                slug,
                "skills/shared/SKILL.md",
                &format!("---\ndescription: from {slug}\n---\n"),
            );
        }
        let tmp = tempfile::tempdir().unwrap();

        let d = enrich_and_filter(
            discover_names(&["shared"]),
            &with_plugins(tmp.path(), &["alpha", "zeta"]),
            data_tmp.path(),
        );

        assert_eq!(d.commands.len(), 1, "got {:?}", d.commands);
        assert_eq!(d.commands[0].description.as_deref(), Some("from zeta"));
    }

    #[test]
    fn enrich_does_not_look_up_a_prefixed_name_in_speedwave_resource_dirs() {
        let _g = crate::signing::test_support::UnsignedBypassGuard::new();
        let data_tmp = tempfile::tempdir().unwrap();
        install_plugin_resource(
            data_tmp.path(),
            "extra",
            "skills/review/SKILL.md",
            "---\ndescription: from a speedwave plugin\nuser-invocable: false\n---\n",
        );
        write_bundled_skill(
            data_tmp.path(),
            "review",
            "---\ndescription: from bundle\nuser-invocable: false\n---\n",
        );
        write_personal_skill(data_tmp.path(), "test-project", "review", "personal");
        let raw = RawDiscovery {
            slash_commands: vec!["superpowers:review".into()],
            plugins: vec![PluginEntry {
                name: "superpowers".into(),
                path: None,
            }],
            agents: vec![],
        };
        let tmp = tempfile::tempdir().unwrap();

        let d = enrich_and_filter(raw, &with_plugins(tmp.path(), &["extra"]), data_tmp.path());

        assert_eq!(d.commands.len(), 1, "got {:?}", d.commands);
        assert_eq!(d.commands[0].name, "superpowers:review");
        assert_eq!(d.commands[0].kind, SlashKind::Plugin);
        assert_eq!(d.commands[0].description, None);
    }

    #[test]
    fn enrich_shows_a_personal_skill_from_the_projects_claude_home() {
        let data_tmp = tempfile::tempdir().unwrap();
        write_personal_skill(
            data_tmp.path(),
            "test-project",
            "my-own",
            "made in the container",
        );
        let tmp = tempfile::tempdir().unwrap();

        let d = enrich_and_filter(
            discover_names(&["my-own"]),
            &test_project(tmp.path()),
            data_tmp.path(),
        );

        assert_eq!(d.commands.len(), 1, "got {:?}", d.commands);
        assert_eq!(d.commands[0].kind, SlashKind::Skill);
        assert_eq!(
            d.commands[0].description.as_deref(),
            Some("made in the container")
        );
    }

    #[test]
    fn enrich_prefers_a_real_claude_home_skill_over_the_linked_resources() {
        let _g = crate::signing::test_support::UnsignedBypassGuard::new();
        let data_tmp = tempfile::tempdir().unwrap();
        write_bundled_skill(
            data_tmp.path(),
            "shared",
            "---\ndescription: from bundle\n---\n",
        );
        install_plugin_resource(
            data_tmp.path(),
            "extra",
            "skills/shared/SKILL.md",
            "---\ndescription: from plugin\n---\n",
        );
        write_personal_skill(data_tmp.path(), "test-project", "shared", "personal copy");
        let tmp = tempfile::tempdir().unwrap();

        let d = enrich_and_filter(
            discover_names(&["shared"]),
            &with_plugins(tmp.path(), &["extra"]),
            data_tmp.path(),
        );

        assert_eq!(d.commands.len(), 1, "got {:?}", d.commands);
        assert_eq!(d.commands[0].description.as_deref(), Some("personal copy"));
    }

    #[test]
    fn enrich_ignores_a_personal_skill_of_another_project() {
        let data_tmp = tempfile::tempdir().unwrap();
        write_personal_skill(data_tmp.path(), "other-project", "theirs", "not ours");
        let tmp = tempfile::tempdir().unwrap();

        let d = enrich_and_filter(
            discover_names(&["theirs"]),
            &test_project(tmp.path()),
            data_tmp.path(),
        );

        assert!(d.commands.is_empty(), "got {:?}", d.commands);
    }

    #[cfg(unix)]
    #[test]
    fn enrich_skips_a_claude_home_link_that_resolves_only_inside_the_container() {
        let data_tmp = tempfile::tempdir().unwrap();
        let skills =
            crate::claude_home::claude_config_dir(data_tmp.path(), "test-project").join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        std::os::unix::fs::symlink(
            "/speedwave/plugins/gone/skills/linked-only",
            skills.join("linked-only"),
        )
        .unwrap();
        let tmp = tempfile::tempdir().unwrap();

        let d = enrich_and_filter(
            discover_names(&["linked-only"]),
            &test_project(tmp.path()),
            data_tmp.path(),
        );

        assert!(d.commands.is_empty(), "got {:?}", d.commands);
    }

    #[test]
    fn enrich_hides_a_skill_from_a_plugin_that_fails_verification() {
        let _g = crate::signing::test_support::unsigned_env_lock();
        std::env::remove_var("SPEEDWAVE_ALLOW_UNSIGNED");
        let data_tmp = tempfile::tempdir().unwrap();
        install_plugin_resource(
            data_tmp.path(),
            "unsigned",
            "skills/unsigned-skill/SKILL.md",
            "---\ndescription: never shown\n---\n",
        );
        let listed = crate::plugin::list_for_ui_from_dir(&crate::plugin::plugins_base_dir_in(
            data_tmp.path(),
        ));
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].verification_status,
            crate::plugin::VerificationStatus::MissingSignature
        );
        let tmp = tempfile::tempdir().unwrap();

        let d = enrich_and_filter(
            discover_names(&["unsigned-skill"]),
            &with_plugins(tmp.path(), &["unsigned"]),
            data_tmp.path(),
        );

        assert!(d.commands.is_empty(), "got {:?}", d.commands);
    }

    #[test]
    fn enrich_does_not_resolve_a_name_that_climbs_out_of_its_base() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".claude/skills")).unwrap();
        let outside = tmp.path().join(".claude/outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("SKILL.md"), "---\ndescription: escaped\n---\n").unwrap();
        let data_tmp = tempfile::tempdir().unwrap();

        let d = enrich_and_filter(
            discover_names(&["../outside"]),
            &test_project(tmp.path()),
            data_tmp.path(),
        );

        assert!(d.commands.is_empty(), "got {:?}", d.commands);
    }

    #[test]
    fn enrich_reads_the_frontmatter_of_a_file_longer_than_the_read_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".claude/skills/long");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let body = "x".repeat(usize::try_from(FRONTMATTER_READ_LIMIT).unwrap() * 3);
        std::fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\ndescription: long body\n---\n{body}"),
        )
        .unwrap();
        let data_tmp = tempfile::tempdir().unwrap();

        let d = enrich_and_filter(
            discover_names(&["long"]),
            &test_project(tmp.path()),
            data_tmp.path(),
        );

        assert_eq!(d.commands.len(), 1, "got {:?}", d.commands);
        assert_eq!(d.commands[0].description.as_deref(), Some("long body"));
    }

    #[test]
    fn is_plain_name_accepts_only_a_single_normal_component() {
        for ok in ["glpi-operations", "presale", "speedwave-grill-me"] {
            assert!(is_plain_name(ok), "{ok}");
        }
        for bad in ["", ".", "..", "../x", "a/b", "/abs"] {
            assert!(!is_plain_name(bad), "{bad}");
        }
    }

    #[test]
    fn read_frontmatter_head_stops_at_the_read_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("big.md");
        let limit = usize::try_from(FRONTMATTER_READ_LIMIT).unwrap();
        std::fs::write(&file, "y".repeat(limit * 2)).unwrap();

        assert_eq!(read_frontmatter_head(&file).unwrap().len(), limit);
    }

    #[test]
    fn read_frontmatter_head_rejects_something_other_than_a_regular_file() {
        let tmp = tempfile::tempdir().unwrap();

        let err = read_frontmatter_head(tmp.path()).unwrap_err();

        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    }
}
