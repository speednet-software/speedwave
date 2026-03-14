// CLI binary intentionally uses stdout/stderr for user output.
#![allow(clippy::print_stdout, clippy::print_stderr)]
#![allow(missing_docs)]

use speedwave_runtime::addon;
use speedwave_runtime::compose::{self, SecurityCheck};
use speedwave_runtime::config;
use speedwave_runtime::consts;
use speedwave_runtime::runtime::detect_runtime;
use speedwave_runtime::update;
use speedwave_runtime::validation;

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, PartialEq)]
enum CliAction {
    AddonInstall(String), // zip path
    Check,
    SelfUpdate,
    Update,
    Run, // default: compose_up + exec
}

fn parse_action(args: &[String]) -> Result<CliAction, String> {
    match args.get(1).map(|s| s.as_str()) {
        Some("addon") => match args.get(2).map(|s| s.as_str()) {
            Some("install") => {
                let path = args
                    .get(3)
                    .ok_or("usage: speedwave addon install <zip-path>".to_string())?;
                Ok(CliAction::AddonInstall(path.clone()))
            }
            _ => Err("usage: speedwave addon install <zip-path>".to_string()),
        },
        Some("check") => Ok(CliAction::Check),
        Some("self-update") => Ok(CliAction::SelfUpdate),
        Some("update") => Ok(CliAction::Update),
        _ => Ok(CliAction::Run),
    }
}

// ── Self-update constants ──────────────────────────────────────────────────

const REPO_OWNER: &str = "speednet-software";
const REPO_NAME: &str = "speedwave";
const UPDATE_CHECK_INTERVAL_SECS: u64 = 86400; // 24 hours

// ── Update check cache ────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
struct UpdateCheckCache {
    last_check: u64,
    latest_version: String,
}

fn update_cache_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(consts::DATA_DIR).join("update-check.json"))
}

fn read_update_cache() -> Option<UpdateCheckCache> {
    let path = update_cache_path()?;
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn write_update_cache(cache: &UpdateCheckCache) {
    if let Some(path) = update_cache_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = serde_json::to_string(cache)
            .ok()
            .and_then(|json| std::fs::write(path, json).ok());
    }
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
        if let Some(home) = dirs::home_dir() {
            let marker = home.join(consts::DATA_DIR).join(consts::RESOURCES_MARKER);
            if let Ok(contents) = std::fs::read_to_string(&marker) {
                let resources_dir = contents.trim();
                if !resources_dir.is_empty() {
                    log::debug!("loaded resources dir from marker: {resources_dir}");
                    std::env::set_var(consts::BUNDLE_RESOURCES_ENV, resources_dir);
                }
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

    // Handle `speedwave addon install <path>` before runtime check
    // (addon install doesn't need a running VM)
    if let CliAction::AddonInstall(ref path) = action {
        let manifest = addon::install_addon(std::path::Path::new(path))?;
        println!(
            "Addon '{}' v{} installed successfully",
            manifest.name, manifest.version
        );
        if manifest.mcp_server {
            println!("MCP server will be available on next project start");
        }
        std::process::exit(0);
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
    )?;

    // Handle `speedwave check` subcommand
    if action == CliAction::Check {
        let violations = SecurityCheck::run(&compose_yml, &project_name);
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
    let violations = SecurityCheck::run(&compose_yml, &project_name);
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

    // exec -it -> interactive Claude terminal inside container
    let container_name = format!("{}_{}_claude", consts::COMPOSE_PREFIX, project_name);
    let mut exec_cmd: Vec<&str> = vec![consts::CLAUDE_BINARY];
    exec_cmd.extend_from_slice(&resolved.flags);
    let status = runtime
        .container_exec(&container_name, &exec_cmd)
        .status()?;
    std::process::exit(status.code().unwrap_or(1));
}

/// Resolves project name: checks CWD name against configured projects,
/// falls back to active_project from config.
fn resolve_project(user_config: &config::SpeedwaveUserConfig) -> anyhow::Result<String> {
    // Try CWD name first
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(dir_name) = cwd.file_name() {
            let name = dir_name.to_string_lossy().to_string();
            if user_config.projects.iter().any(|p| p.name == name) {
                return Ok(name);
            }
        }
    }

    // Fall back to active project from config
    user_config
        .active_project
        .clone()
        .or_else(|| user_config.projects.first().map(|p| p.name.clone()))
        .ok_or_else(|| anyhow::anyhow!("No project configured. Run Speedwave.app setup first."))
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
    fn parse_action_addon_install() {
        let args = vec![
            "speedwave".to_string(),
            "addon".to_string(),
            "install".to_string(),
            "/tmp/foo.zip".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::AddonInstall("/tmp/foo.zip".to_string())
        );
    }

    #[test]
    fn parse_action_addon_no_subcommand() {
        let args = vec!["speedwave".to_string(), "addon".to_string()];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_addon_install_no_path() {
        let args = vec![
            "speedwave".to_string(),
            "addon".to_string(),
            "install".to_string(),
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
    fn test_resolve_project_with_matching_cwd() {
        // resolve_project checks if CWD's directory name matches a configured project.
        // Get the actual CWD directory name so the test works regardless of where it runs.
        let cwd = std::env::current_dir().unwrap();
        let dir_name = cwd.file_name().unwrap().to_string_lossy().to_string();

        let user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: dir_name.clone(),
                dir: cwd.to_string_lossy().to_string(),
                claude: None,
                integrations: None,
            }],
            active_project: None,
            selected_ide: None,
            log_level: None,
        };

        let result = resolve_project(&user_config).unwrap();
        assert_eq!(result, dir_name);
    }

    #[test]
    fn test_resolve_project_falls_back_to_active() {
        // No project name matches CWD, so resolve_project should fall back to active_project.
        let user_config = config::SpeedwaveUserConfig {
            projects: vec![config::ProjectUserEntry {
                name: "fallback-project".to_string(),
                dir: "/nonexistent/path/that/wont/match/cwd".to_string(),
                claude: None,
                integrations: None,
            }],
            active_project: Some("fallback-project".to_string()),
            selected_ide: None,
            log_level: None,
        };

        let result = resolve_project(&user_config).unwrap();
        assert_eq!(result, "fallback-project");
    }

    #[test]
    fn test_claude_binary_path_is_usr_local_bin() {
        assert_eq!(consts::CLAUDE_BINARY, "/usr/local/bin/claude");
    }

    #[test]
    fn validate_project_name_valid() {
        assert!(validate_project_name("my-project").is_ok());
        assert!(validate_project_name("Project_1.0").is_ok());
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
    fn update_cache_path_returns_some_under_data_dir() {
        let path = update_cache_path().expect("update_cache_path should return Some");
        let path_str = path.to_string_lossy();
        assert!(
            path_str.contains(".speedwave/update-check.json"),
            "cache path should be under ~/.speedwave/, got: {}",
            path_str
        );
    }

    #[test]
    fn test_update_cache_path_under_speedwave() {
        let path = update_cache_path();
        let path_str = path
            .expect("update_cache_path should return Some")
            .to_string_lossy()
            .to_string();
        assert!(
            path_str.contains(".speedwave"),
            "update_cache_path should be under .speedwave, got: {path_str}"
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
}
