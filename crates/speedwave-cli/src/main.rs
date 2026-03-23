// CLI binary intentionally uses stdout/stderr for user output.
#![allow(clippy::print_stdout, clippy::print_stderr)]
#![allow(missing_docs)]

use speedwave_runtime::compose::{self, SecurityCheck};
use speedwave_runtime::config;
use speedwave_runtime::consts;
use speedwave_runtime::plugin;
use speedwave_runtime::runtime::{detect_runtime, ensure_exec_healthy};
use speedwave_runtime::update;
use speedwave_runtime::validation;

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, PartialEq)]
enum CliAction {
    PluginInstall(String), // zip path
    PluginList,
    PluginRemove(String), // slug
    PluginEnable { service_id: String, project: String },
    PluginDisable { service_id: String, project: String },
    Check,
    Init(Option<String>), // optional project name
    SelfUpdate,
    Update,
    Run, // default: compose_up + exec
}

/// Extracts `--project <value>` from plugin enable/disable args.
fn parse_project_flag(args: &[String], subcommand: &str) -> Result<String, String> {
    // args: [speedwave, plugin, enable|disable, <service_id>, --project, <project>]
    let flag_pos = args.iter().position(|a| a == "--project").ok_or(format!(
        "usage: speedwave plugin {subcommand} <service_id> --project <project>"
    ))?;
    args.get(flag_pos + 1).cloned().ok_or(format!(
        "usage: speedwave plugin {subcommand} <service_id> --project <project>"
    ))
}

fn parse_action(args: &[String]) -> Result<CliAction, String> {
    match args.get(1).map(|s| s.as_str()) {
        Some("plugin") => match args.get(2).map(|s| s.as_str()) {
            Some("install") => {
                let path = args
                    .get(3)
                    .ok_or("usage: speedwave plugin install <zip-path>".to_string())?;
                Ok(CliAction::PluginInstall(path.clone()))
            }
            Some("list") => Ok(CliAction::PluginList),
            Some("remove") => {
                let slug = args
                    .get(3)
                    .ok_or("usage: speedwave plugin remove <slug>".to_string())?;
                Ok(CliAction::PluginRemove(slug.clone()))
            }
            Some("enable") => {
                let service_id = args.get(3).ok_or(
                    "usage: speedwave plugin enable <service_id> --project <project>".to_string(),
                )?;
                let project = parse_project_flag(args, "enable")?;
                Ok(CliAction::PluginEnable {
                    service_id: service_id.clone(),
                    project,
                })
            }
            Some("disable") => {
                let service_id = args.get(3).ok_or(
                    "usage: speedwave plugin disable <service_id> --project <project>".to_string(),
                )?;
                let project = parse_project_flag(args, "disable")?;
                Ok(CliAction::PluginDisable {
                    service_id: service_id.clone(),
                    project,
                })
            }
            _ => Err("usage: speedwave plugin [install|list|remove|enable|disable]".to_string()),
        },
        Some("check") => Ok(CliAction::Check),
        Some("init") => {
            let name = args.get(2).cloned();
            Ok(CliAction::Init(name))
        }
        Some("self-update") => Ok(CliAction::SelfUpdate),
        Some("update") => Ok(CliAction::Update),
        _ => Ok(CliAction::Run),
    }
}

// ── Self-update constants ──────────────────────────────────────────────────

const REPO_OWNER: &str = "speednet-software";
const REPO_NAME: &str = "speedwave";
const UPDATE_CHECK_INTERVAL_SECS: u64 =
    speedwave_runtime::consts::UPDATE_CHECK_INTERVAL_HOURS as u64 * 3600;

// ── Update check cache ────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
struct UpdateCheckCache {
    last_check: u64,
    latest_version: String,
}

fn update_cache_path() -> PathBuf {
    consts::data_dir().join("update-check.json")
}

/// Testable variant: resolves update cache path under an explicit data directory.
#[cfg(test)]
fn update_cache_path_in(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("update-check.json")
}

fn read_update_cache() -> Option<UpdateCheckCache> {
    let path = update_cache_path();
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn write_update_cache(cache: &UpdateCheckCache) {
    let path = update_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = serde_json::to_string(cache)
        .ok()
        .and_then(|json| std::fs::write(path, json).ok());
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Check if the CLI binary is inside a macOS .app bundle.
fn is_app_bundle() -> bool {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().contains(".app/"))
        .unwrap_or(false)
}

/// Non-blocking version check on startup. Prints a hint if a newer version is available.
/// Only checks once per day (cached). Errors are silently ignored.
fn maybe_print_update_hint() {
    if is_app_bundle() {
        return; // Desktop users update via the app
    }

    let current = env!("CARGO_PKG_VERSION");

    // Check cache first
    if let Some(cache) = read_update_cache() {
        let elapsed = now_secs().saturating_sub(cache.last_check);
        if elapsed < UPDATE_CHECK_INTERVAL_SECS {
            // Cache is fresh — use cached version to print hint
            if let (Ok(cur), Ok(latest)) = (
                semver::Version::parse(current),
                semver::Version::parse(&cache.latest_version),
            ) {
                if latest > cur {
                    eprintln!(
                        "Update available: speedwave {} -> {}. Run: speedwave self-update",
                        current, cache.latest_version
                    );
                }
            }
            return;
        }
    }

    // Cache is stale or missing — fetch latest release in a background thread
    // so we don't slow down startup
    std::thread::spawn(move || {
        let latest = match self_update::backends::github::Update::configure()
            .repo_owner(REPO_OWNER)
            .repo_name(REPO_NAME)
            .bin_name(consts::CLI_BINARY)
            .current_version(current)
            .build()
        {
            Ok(updater) => match updater.get_latest_release() {
                Ok(release) => release.version,
                Err(_) => return,
            },
            Err(_) => return,
        };

        write_update_cache(&UpdateCheckCache {
            last_check: now_secs(),
            latest_version: latest,
        });
    });
}

/// Run the self-update: download the latest release from GitHub and replace the current binary.
fn run_self_update() -> anyhow::Result<()> {
    if is_app_bundle() {
        anyhow::bail!("This binary is part of a Speedwave.app bundle. Please update via the Desktop app instead.");
    }

    let current = env!("CARGO_PKG_VERSION");
    println!("Current version: {}", current);
    println!("Checking for updates...");

    let status = self_update::backends::github::Update::configure()
        .repo_owner(REPO_OWNER)
        .repo_name(REPO_NAME)
        .bin_name(consts::CLI_BINARY)
        .show_download_progress(true)
        .current_version(current)
        .build()?
        .update()?;

    // Update the cache after a successful update check
    write_update_cache(&UpdateCheckCache {
        last_check: now_secs(),
        latest_version: status.version().to_string(),
    });

    if status.updated() {
        println!("Updated to version {}", status.version());
    } else {
        println!("Already up to date ({})", current);
    }

    Ok(())
}

/// Validate that a project name is safe for use as a container name component.
/// Delegates to the canonical validation in `speedwave_runtime::validation`.
fn validate_project_name(name: &str) -> Result<(), String> {
    validation::validate_project_name(name).map_err(|e| e.to_string())
}

fn runtime_not_available() -> ! {
    eprintln!("Speedwave runtime is not running.");
    eprintln!("CLI requires Speedwave Desktop to be running with a completed setup.");
    eprintln!("1. Open Speedwave.app");
    eprintln!("2. Complete the Setup Wizard");
    eprintln!("3. Start your project");
    eprintln!("Then run `speedwave` again in your project directory.");
    std::process::exit(1);
}

fn main() -> anyhow::Result<()> {
    // Panic hook — sanitize panic payload before logging
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(&format!("{info}"));
        log::error!("PANIC: {sanitized}");
        #[cfg(debug_assertions)]
        default_hook(info);
        #[cfg(not(debug_assertions))]
        {
            let _ = &default_hook;
            eprintln!("PANIC: {sanitized}");
        }
    }));

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format(|buf, record| {
            use std::io::Write;
            let sanitized =
                speedwave_runtime::log_sanitizer::sanitize(&format!("{}", record.args()));
            writeln!(
                buf,
                "[{level}][{target}] {sanitized}",
                level = record.level(),
                target = record.target(),
            )
        })
        .init();

    // If SPEEDWAVE_RESOURCES_DIR is not set, try reading the marker file written
    // by the Desktop app (e.g. ~/.speedwave/resources-dir → "/usr/lib/Speedwave").
    // This lets the CLI find bundled binaries (nerdctl, node) without inheriting
    // the Desktop's environment.
    if std::env::var(consts::BUNDLE_RESOURCES_ENV).is_err() {
        let marker = consts::data_dir().join(consts::RESOURCES_MARKER);
        if let Ok(contents) = std::fs::read_to_string(&marker) {
            let resources_dir = contents.trim();
            if !resources_dir.is_empty() {
                log::debug!("loaded resources dir from marker: {resources_dir}");
                std::env::set_var(consts::BUNDLE_RESOURCES_ENV, resources_dir);
            }
        }
    }

    let args: Vec<String> = std::env::args().collect();

    let action = parse_action(&args).unwrap_or_else(|msg| {
        eprintln!("{}", msg);
        std::process::exit(1);
    });

    // Handle `speedwave self-update` before anything else
    if action == CliAction::SelfUpdate {
        if let Err(e) = run_self_update() {
            eprintln!("Self-update failed: {e}");
            std::process::exit(1);
        }
        std::process::exit(0);
    }

    // Non-blocking update hint (max once per day, cached)
    maybe_print_update_hint();

    // Handle `speedwave init [name]` — register CWD as a project (no running VM required)
    if let CliAction::Init(ref custom_name) = action {
        let cwd = std::env::current_dir()?;
        let canonical = std::fs::canonicalize(&cwd)?;
        let name = match custom_name {
            Some(n) => n.clone(),
            None => canonical
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .ok_or_else(|| anyhow::anyhow!("Cannot determine directory name"))?,
        };
        validation::validate_project_name(&name)?;

        let canonical_str = canonical.to_string_lossy().to_string();
        match speedwave_runtime::project::add_project(&name, &canonical_str) {
            Ok(()) => {
                println!("Project '{}' registered at {}", name, canonical_str);
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("already registered") || msg.contains("already exists") {
                    println!("{}", msg);
                } else {
                    return Err(e);
                }
            }
        }
        std::process::exit(0);
    }

    // Handle `speedwave update` — rebuild images + recreate containers
    if action == CliAction::Update {
        let runtime = detect_runtime();
        if !runtime.is_available() {
            runtime_not_available();
        }
        let user_config = config::load_user_config().unwrap_or_else(|e| {
            eprintln!("Failed to load config: {e}");
            std::process::exit(1);
        });
        let project_name = resolve_project(&user_config)?;
        println!("Updating containers for project '{}'...", project_name);
        match update::update_containers(runtime.as_ref(), &project_name) {
            Ok(result) => {
                println!(
                    "Updated {} containers ({} images rebuilt)",
                    result.containers_recreated, result.images_rebuilt
                );
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!("Container update failed: {e}");
                std::process::exit(1);
            }
        }
    }

    // Handle plugin subcommands before runtime check
    // (plugin install/list/remove don't need a running VM)
    match &action {
        CliAction::PluginInstall(path) => {
            let rt = detect_runtime();
            let rt_ref: Option<&dyn speedwave_runtime::runtime::ContainerRuntime> =
                if rt.is_available() { Some(&*rt) } else { None };
            let manifest = plugin::install_plugin(std::path::Path::new(path), rt_ref)?;
            println!(
                "Plugin '{}' ({}) installed successfully",
                manifest.name, manifest.slug
            );
            std::process::exit(0);
        }
        CliAction::PluginList => {
            let plugins = plugin::list_installed_plugins()?;
            if plugins.is_empty() {
                println!("No plugins installed");
            } else {
                for m in &plugins {
                    println!("{} ({}): {}", m.name, m.slug, m.version);
                }
            }
            std::process::exit(0);
        }
        CliAction::PluginRemove(slug) => {
            plugin::remove_plugin(slug)?;
            println!("Plugin '{}' removed", slug);
            std::process::exit(0);
        }
        CliAction::PluginEnable {
            service_id,
            project,
        } => {
            let manifests = plugin::list_installed_plugins()?;
            let manifest = manifests
                .iter()
                .find(|m| m.service_id.as_deref() == Some(service_id))
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "No installed plugin with service_id '{}'. Run `speedwave plugin list` to see installed plugins.",
                        service_id
                    )
                })?;
            let mut user_config = config::load_user_config()?;
            let entry = user_config
                .projects
                .iter_mut()
                .find(|p| p.name == *project)
                .ok_or_else(|| anyhow::anyhow!("project '{}' not found in config", project))?;
            let integrations = entry.integrations.get_or_insert_with(Default::default);
            integrations.set_plugin_enabled(service_id, true);
            config::save_user_config(&user_config)?;
            println!(
                "Plugin '{}' (service_id: {}) enabled for project '{}'",
                manifest.name, service_id, project
            );
            std::process::exit(0);
        }
        CliAction::PluginDisable {
            service_id,
            project,
        } => {
            let manifests = plugin::list_installed_plugins()?;
            let manifest = manifests
                .iter()
                .find(|m| m.service_id.as_deref() == Some(service_id))
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "No installed plugin with service_id '{}'. Run `speedwave plugin list` to see installed plugins.",
                        service_id
                    )
                })?;
            let mut user_config = config::load_user_config()?;
            let entry = user_config
                .projects
                .iter_mut()
                .find(|p| p.name == *project)
                .ok_or_else(|| anyhow::anyhow!("project '{}' not found in config", project))?;
            let integrations = entry.integrations.get_or_insert_with(Default::default);
            integrations.set_plugin_enabled(service_id, false);
            config::save_user_config(&user_config)?;
            println!(
                "Plugin '{}' (service_id: {}) disabled for project '{}'",
                manifest.name, service_id, project
            );
            std::process::exit(0);
        }
        _ => {}
    }

    let runtime = detect_runtime();

    // CLI checks availability but does NOT install (ensure_ready).
    // Installation is the Setup Wizard's responsibility in Speedwave.app.
    if !runtime.is_available() {
        runtime_not_available();
    }

    // Load config once — used for both project resolution and compose rendering
    let user_config = config::load_user_config().unwrap_or_else(|e| {
        eprintln!("Failed to load config: {e}");
        std::process::exit(1);
    });

    let project_name = resolve_project(&user_config)?;

    // Validate project name is safe for container naming
    validate_project_name(&project_name).map_err(|e| anyhow::anyhow!(e))?;

    // Use project dir from config (authoritative), fall back to CWD
    let project_dir = match user_config.find_project(&project_name) {
        Some(p) => std::path::PathBuf::from(&p.dir),
        None => std::env::current_dir().map_err(|e| {
            anyhow::anyhow!(
                "project '{}' not found in config and cannot determine current directory: {}",
                project_name,
                e
            )
        })?,
    };

    let (resolved, integrations) =
        config::resolve_project_config(&project_dir, &user_config, &project_name);

    let compose_yml = compose::render_compose(
        &project_name,
        &project_dir.to_string_lossy(),
        &resolved,
        &integrations,
        Some(&*runtime),
    )?;

    let manifests = plugin::list_installed_plugins().unwrap_or_else(|e| {
        log::warn!("Failed to list installed plugins: {e}");
        Vec::new()
    });
    let expected_paths =
        compose::SecurityExpectedPaths::compute(&project_name, &project_dir.to_string_lossy())?;

    // Handle `speedwave check` subcommand
    if action == CliAction::Check {
        let violations =
            SecurityCheck::run(&compose_yml, &project_name, &manifests, &expected_paths);
        if violations.is_empty() {
            println!("speedwave check OK -- all security invariants satisfied");
            std::process::exit(0);
        } else {
            eprintln!("speedwave check FAILED -- containers NOT started\n");
            for v in &violations {
                eprintln!("  [{}] {} -- {}", v.container, v.rule, v.message);
                eprintln!("  Fix: {}\n", v.remediation);
            }
            std::process::exit(1);
        }
    }

    // Mandatory security gate before container start
    let violations = SecurityCheck::run(&compose_yml, &project_name, &manifests, &expected_paths);
    if !violations.is_empty() {
        eprintln!("speedwave check FAILED -- containers NOT started\n");
        for v in &violations {
            eprintln!("  [{}] {} -- {}", v.container, v.rule, v.message);
            eprintln!("  Fix: {}\n", v.remediation);
        }
        std::process::exit(1);
    }

    // Save compose file and start containers.
    // compose_up is idempotent (no --force-recreate) — nerdctl
    // recreates containers whose config changed. Skip the expensive compose_ps
    // call over SSH; just call compose_up unconditionally and let the engine
    // decide what needs recreating.
    compose::save_compose(&project_name, &compose_yml)?;
    runtime.compose_up(&project_name)?;

    // Verify container exec works before starting interactive session.
    // Recovers automatically from stale mounts after macOS sleep/resume.
    let container_name = format!("{}_{}_claude", consts::compose_prefix(), project_name);
    ensure_exec_healthy(&*runtime, &project_name, &container_name)?;

    // exec -it -> interactive Claude terminal inside container
    let mut exec_cmd: Vec<&str> = vec![consts::CLAUDE_BINARY];
    exec_cmd.extend_from_slice(&resolved.flags);
    let status = runtime
        .container_exec(&container_name, &exec_cmd)
        .status()?;
    std::process::exit(status.code().unwrap_or(1));
}

/// Resolves project name from CWD path matching against configured projects.
/// Falls back to active_project with a warning if no path matches.
fn resolve_project(user_config: &config::SpeedwaveUserConfig) -> anyhow::Result<String> {
    if let Ok(cwd) = std::env::current_dir() {
        return resolve_project_for_cwd(&cwd, user_config);
    }
    resolve_project_fallback(user_config)
}

/// Testable project resolution: matches CWD (or a subdirectory) against
/// registered project paths using canonicalization and longest-prefix match.
fn resolve_project_for_cwd(
    cwd: &Path,
    user_config: &config::SpeedwaveUserConfig,
) -> anyhow::Result<String> {
    let canonical_cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let cwd_str = canonical_cwd.to_string_lossy();

    // Exact match — CWD is exactly a project directory
    for p in &user_config.projects {
        if let Ok(canonical_dir) = std::fs::canonicalize(&p.dir) {
            if canonical_dir == canonical_cwd {
                return Ok(p.name.clone());
            }
        } else {
            eprintln!(
                "Warning: cannot resolve configured path '{}' for project '{}' — skipping",
                p.dir, p.name
            );
        }
    }

    // Longest-prefix match — CWD is inside a project directory
    let mut best: Option<(&str, usize)> = None;
    for p in &user_config.projects {
        if let Ok(canonical_dir) = std::fs::canonicalize(&p.dir) {
            let dir_str = canonical_dir.to_string_lossy();
            let prefix = format!("{}/", dir_str.trim_end_matches('/'));
            if cwd_str.starts_with(&prefix) {
                let len = prefix.len();
                if best.is_none_or(|(_, best_len)| len > best_len) {
                    best = Some((&p.name, len));
                }
            }
        } else {
            eprintln!(
                "Warning: cannot resolve configured path '{}' for project '{}' — skipping",
                p.dir, p.name
            );
        }
    }
    if let Some((name, _)) = best {
        return Ok(name.to_string());
    }

    // Fallback with warning
    let result = resolve_project_fallback(user_config)?;
    eprintln!(
        "Warning: current directory does not match any registered project. Using '{}'.",
        result
    );
    eprintln!("Hint: run `speedwave init` to register this directory as a project.");
    Ok(result)
}

fn resolve_project_fallback(user_config: &config::SpeedwaveUserConfig) -> anyhow::Result<String> {
    user_config
        .active_project
        .clone()
        .or_else(|| user_config.projects.first().map(|p| p.name.clone()))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "No project configured. Run `speedwave init` or complete the Speedwave.app setup."
            )
        })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn parse_action_no_args_returns_run() {
        let args = vec!["speedwave".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Run);
    }

    #[test]
    fn parse_action_check() {
        let args = vec!["speedwave".to_string(), "check".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Check);
    }

    #[test]
    fn parse_action_plugin_install() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "install".to_string(),
            "/tmp/foo.zip".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::PluginInstall("/tmp/foo.zip".to_string())
        );
    }

    #[test]
    fn parse_action_plugin_list() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "list".to_string(),
        ];
        assert_eq!(parse_action(&args).unwrap(), CliAction::PluginList);
    }

    #[test]
    fn parse_action_plugin_remove() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "remove".to_string(),
            "my-plugin".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::PluginRemove("my-plugin".to_string())
        );
    }

    #[test]
    fn parse_action_plugin_no_subcommand() {
        let args = vec!["speedwave".to_string(), "plugin".to_string()];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_plugin_install_no_path() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "install".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_plugin_remove_no_slug() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "remove".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_unknown_command_returns_run() {
        let args = vec!["speedwave".to_string(), "unknown".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Run);
    }

    #[test]
    fn test_exec_cmd_starts_with_claude_binary() {
        let mut exec_cmd: Vec<&str> = vec![consts::CLAUDE_BINARY];
        exec_cmd.extend_from_slice(&["--flag"]);
        assert_eq!(exec_cmd[0], "/usr/local/bin/claude");
    }

    #[test]
    fn test_exec_cmd_includes_resolved_flags() {
        use speedwave_runtime::defaults;
        let mut exec_cmd: Vec<&str> = vec![consts::CLAUDE_BINARY];
        exec_cmd.extend_from_slice(defaults::DEFAULT_FLAGS);
        assert_eq!(exec_cmd[0], consts::CLAUDE_BINARY);
        assert!(exec_cmd.contains(&"--dangerously-skip-permissions"));
        assert!(exec_cmd.contains(&"--mcp-config"));
        assert!(exec_cmd.contains(&defaults::MCP_CONFIG_PATH));
        assert!(exec_cmd.contains(&"--strict-mcp-config"));
    }

    #[test]
    fn test_resolve_project_exact_path_match() {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = std::fs::canonicalize(tmp.path()).unwrap();

        let user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "my-proj".to_string(),
                dir: canonical.to_string_lossy().to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };

        let result = resolve_project_for_cwd(&canonical, &user_config).unwrap();
        assert_eq!(result, "my-proj");
    }

    #[test]
    fn test_resolve_project_subdirectory_match() {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = std::fs::canonicalize(tmp.path()).unwrap();
        let sub = canonical.join("src").join("lib");
        std::fs::create_dir_all(&sub).unwrap();

        let user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "my-proj".to_string(),
                dir: canonical.to_string_lossy().to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };

        let result = resolve_project_for_cwd(&sub, &user_config).unwrap();
        assert_eq!(result, "my-proj");
    }

    #[test]
    fn test_resolve_project_longest_prefix_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        let nested = root.join("apps").join("web");
        std::fs::create_dir_all(&nested).unwrap();
        let deep = nested.join("src");
        std::fs::create_dir_all(&deep).unwrap();

        let user_config = config::SpeedwaveUserConfig {
            projects: vec![
                config::ProjectUserEntry {
                    name: "root-proj".to_string(),
                    dir: root.to_string_lossy().to_string(),
                    claude: None,
                    integrations: None,
                    plugin_settings: None,
                },
                config::ProjectUserEntry {
                    name: "web-proj".to_string(),
                    dir: nested.to_string_lossy().to_string(),
                    claude: None,
                    integrations: None,
                    plugin_settings: None,
                },
            ],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };

        // CWD inside nested project should match web-proj (longer prefix)
        let result = resolve_project_for_cwd(&deep, &user_config).unwrap();
        assert_eq!(result, "web-proj");
    }

    #[test]
    fn test_resolve_project_fallback_to_active() {
        let user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "fallback-project".to_string(),
                dir: "/nonexistent/path/that/wont/match/cwd".to_string(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: Some("fallback-project".to_string()),
            selected_ide: None,
            log_level: None,
        };

        // Use a tempdir as CWD that doesn't match any project
        let tmp = tempfile::tempdir().unwrap();
        let result = resolve_project_for_cwd(tmp.path(), &user_config).unwrap();
        assert_eq!(result, "fallback-project");
    }

    #[test]
    fn test_resolve_project_no_projects_errors() {
        let user_config = config::SpeedwaveUserConfig {
            projects: vec![],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };

        let tmp = tempfile::tempdir().unwrap();
        let result = resolve_project_for_cwd(tmp.path(), &user_config);
        assert!(result.is_err());
    }

    #[test]
    fn test_resolve_project_trailing_slash_in_config() {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = std::fs::canonicalize(tmp.path()).unwrap();
        // Store with trailing slash — should still match
        let dir_with_slash = format!("{}/", canonical.to_string_lossy());

        let user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "slashed".to_string(),
                dir: dir_with_slash,
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };

        // canonicalize strips trailing slash, so exact match should work
        // because we canonicalize both sides
        let result = resolve_project_for_cwd(&canonical, &user_config).unwrap();
        assert_eq!(result, "slashed");
    }

    #[test]
    fn test_claude_binary_path_is_usr_local_bin() {
        assert_eq!(consts::CLAUDE_BINARY, "/usr/local/bin/claude");
    }

    #[test]
    fn validate_project_name_valid() {
        assert!(validate_project_name("my-project").is_ok());
        assert!(validate_project_name("project_1.0").is_ok());
        assert!(validate_project_name("a").is_ok());
    }

    #[test]
    fn validate_project_name_empty() {
        assert!(validate_project_name("").is_err());
    }

    #[test]
    fn validate_project_name_starts_with_special() {
        assert!(validate_project_name("-project").is_err());
        assert!(validate_project_name(".hidden").is_err());
    }

    #[test]
    fn validate_project_name_invalid_chars() {
        assert!(validate_project_name("my project").is_err());
        assert!(validate_project_name("caf\u{00e9}").is_err());
        assert!(validate_project_name("path/name").is_err());
    }

    #[test]
    fn parse_action_self_update() {
        let args = vec!["speedwave".to_string(), "self-update".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::SelfUpdate);
    }

    #[test]
    fn parse_action_update() {
        let args = vec!["speedwave".to_string(), "update".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Update);
    }

    #[test]
    fn parse_action_init_no_name() {
        let args = vec!["speedwave".to_string(), "init".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Init(None));
    }

    #[test]
    fn parse_action_init_with_name() {
        let args = vec![
            "speedwave".to_string(),
            "init".to_string(),
            "my-custom-name".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Init(Some("my-custom-name".to_string()))
        );
    }

    #[test]
    fn update_cache_round_trip() {
        let dir = std::env::temp_dir().join("speedwave-test-cache");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("update-check.json");

        let cache = UpdateCheckCache {
            last_check: 1_700_000_000,
            latest_version: "1.2.3".to_string(),
        };
        let json = serde_json::to_string(&cache).unwrap();
        std::fs::write(&path, &json).unwrap();

        let loaded: UpdateCheckCache = serde_json::from_str(&json).unwrap();
        assert_eq!(loaded.last_check, 1_700_000_000);
        assert_eq!(loaded.latest_version, "1.2.3");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_app_bundle_returns_false_for_test_binary() {
        // Test binaries are in target/debug/, not inside an .app bundle
        assert!(!is_app_bundle());
    }

    #[test]
    fn update_cache_path_returns_path_under_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let path = update_cache_path_in(dir.path());
        assert!(
            path.starts_with(dir.path()),
            "cache path should be under data_dir, got: {}",
            path.display()
        );
        assert!(
            path.ends_with("update-check.json"),
            "cache path should end with update-check.json, got: {}",
            path.display()
        );
    }

    #[test]
    fn now_secs_is_nonzero() {
        assert!(now_secs() > 0);
    }

    #[test]
    fn repo_constants_are_set() {
        assert_eq!(REPO_OWNER, "speednet-software");
        assert_eq!(REPO_NAME, "speedwave");
        assert_eq!(UPDATE_CHECK_INTERVAL_SECS, 86400);
    }

    #[test]
    fn resources_marker_constant_is_correct() {
        assert_eq!(consts::RESOURCES_MARKER, "resources-dir");
    }

    #[test]
    fn resources_marker_parsing_trims_whitespace() {
        // Simulate the marker-reading logic: contents are trimmed before use
        let raw = "  /usr/lib/Speedwave  \n";
        let resources_dir = raw.trim();
        assert_eq!(resources_dir, "/usr/lib/Speedwave");
        assert!(!resources_dir.is_empty());
    }

    #[test]
    fn resources_marker_empty_content_is_ignored() {
        let raw = "  \n";
        let resources_dir = raw.trim();
        assert!(resources_dir.is_empty());
    }

    #[test]
    fn parse_action_plugin_enable() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "enable".to_string(),
            "my-svc".to_string(),
            "--project".to_string(),
            "demo".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::PluginEnable {
                service_id: "my-svc".to_string(),
                project: "demo".to_string(),
            }
        );
    }

    #[test]
    fn parse_action_plugin_disable() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "disable".to_string(),
            "my-svc".to_string(),
            "--project".to_string(),
            "demo".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::PluginDisable {
                service_id: "my-svc".to_string(),
                project: "demo".to_string(),
            }
        );
    }

    #[test]
    fn parse_action_plugin_enable_missing_service_id() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "enable".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_plugin_disable_missing_service_id() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "disable".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_plugin_enable_missing_project_flag() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "enable".to_string(),
            "my-svc".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_plugin_disable_missing_project_flag() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "disable".to_string(),
            "my-svc".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_plugin_enable_missing_project_value() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "enable".to_string(),
            "my-svc".to_string(),
            "--project".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_plugin_disable_missing_project_value() {
        let args = vec![
            "speedwave".to_string(),
            "plugin".to_string(),
            "disable".to_string(),
            "my-svc".to_string(),
            "--project".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }
}
