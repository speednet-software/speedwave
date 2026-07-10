//! `speedwave` CLI: runs Claude Code in a hardened per-project container.

use speedwave_runtime::compose::{self, SecurityCheck, SecurityRule};
use speedwave_runtime::config;
use speedwave_runtime::consts;
use speedwave_runtime::plugin;
use speedwave_runtime::runtime::{detect_runtime, ensure_exec_healthy};
use speedwave_runtime::update;
use speedwave_runtime::validation;
use strum::IntoEnumIterator;

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

mod paste_watcher;
mod terminal_restore;

/// Redact secrets from one CLI output line via the `log_sanitizer` SSOT.
/// Split out from [`emit`] so the redaction is unit-testable without
/// capturing stdout.
fn sanitize_output_line(line: &str) -> String {
    speedwave_runtime::log_sanitizer::sanitize(line)
}

/// Redact secrets from an error before interpolating it into user-facing output.
fn redact_err(e: &impl std::fmt::Display) -> String {
    sanitize_output_line(&e.to_string())
}

/// Single output sink for `out!`/`err!`; every line passes through the
/// `log_sanitizer` SSOT before reaching the terminal.
#[allow(clippy::print_stdout, clippy::print_stderr)]
fn emit(to_stderr: bool, args: std::fmt::Arguments<'_>) {
    let line = sanitize_output_line(&args.to_string());
    if to_stderr {
        eprintln!("{line}");
    } else {
        println!("{line}");
    }
}

/// Print a line to stdout (normal CLI result output).
macro_rules! out {
    () => { emit(false, format_args!("")) };
    ($($arg:tt)*) => { emit(false, format_args!($($arg)*)) };
}

/// Print a line to stderr (diagnostics, prompts, errors).
macro_rules! err {
    () => { emit(true, format_args!("")) };
    ($($arg:tt)*) => { emit(true, format_args!($($arg)*)) };
}

#[derive(Debug, PartialEq)]
enum CliAction {
    PluginInstall(String), // zip path
    PluginList,
    PluginRemove(String), // slug
    PluginEnable { service_id: String, project: String },
    PluginDisable { service_id: String, project: String },
    Check,
    Init(Option<String>), // optional explicit project name (default: derive from dir name)
    Login(Option<String>), // optional --project override (default: active project)
    Logout(Option<String>), // optional --project override (default: active project)
    SelfUpdate,
    Update(Option<String>), // optional --project override (default: active project)
    Run(Option<String>), // optional --project override (default: active project); compose_up + exec
    Help,
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

/// Parses an optional `--project <value>` / `--project=<value>` flag from the
/// argv `tail` (slice after the subcommand token). Any other token is a hard
/// error; returns `Ok(None)` when the tail is empty.
fn parse_optional_project_tail(
    tail: &[String],
    subcommand: &str,
) -> Result<Option<String>, String> {
    let usage = || format!("usage: speedwave {subcommand} [--project <project>]");
    let mut iter = tail.iter();
    let Some(first) = iter.next() else {
        return Ok(None);
    };
    let project = if let Some(value) = first.strip_prefix("--project=") {
        if value.is_empty() {
            return Err(usage());
        }
        value.to_string()
    } else if first == "--project" {
        iter.next().cloned().ok_or_else(usage)?
    } else {
        return Err(format!("unexpected argument: '{first}'. {}", usage()));
    };
    if let Some(extra) = iter.next() {
        return Err(format!("unexpected argument: '{extra}'. {}", usage()));
    }
    Ok(Some(project))
}

/// Rejects any token beyond `expected_len` for subcommands that take no args.
fn reject_extra_args(args: &[String], expected_len: usize, usage: &str) -> Result<(), String> {
    match args.get(expected_len) {
        Some(extra) => Err(format!("unexpected argument: '{extra}'. usage: {usage}")),
        None => Ok(()),
    }
}

fn parse_action(args: &[String]) -> Result<CliAction, String> {
    match args.get(1).map(|s| s.as_str()) {
        Some("--help" | "-h" | "help") => Ok(CliAction::Help),
        Some("plugin") => match args.get(2).map(|s| s.as_str()) {
            Some("install") => {
                let path = args
                    .get(3)
                    .ok_or("usage: speedwave plugin install <zip-path>".to_string())?;
                reject_extra_args(args, 4, "speedwave plugin install <zip-path>")?;
                Ok(CliAction::PluginInstall(path.clone()))
            }
            Some("list") => {
                reject_extra_args(args, 3, "speedwave plugin list")?;
                Ok(CliAction::PluginList)
            }
            Some("remove") => {
                let slug = args
                    .get(3)
                    .ok_or("usage: speedwave plugin remove <slug>".to_string())?;
                reject_extra_args(args, 4, "speedwave plugin remove <slug>")?;
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
        Some("check") => {
            reject_extra_args(args, 2, "speedwave check")?;
            Ok(CliAction::Check)
        }
        Some("init") => {
            let name = args.get(2).cloned();
            reject_extra_args(args, 3, "speedwave init [name]")?;
            Ok(CliAction::Init(name))
        }
        Some("self-update") => {
            reject_extra_args(args, 2, "speedwave self-update")?;
            Ok(CliAction::SelfUpdate)
        }
        Some("update") => Ok(CliAction::Update(parse_optional_project_tail(
            &args[2..],
            "update",
        )?)),
        Some("login") => Ok(CliAction::Login(parse_optional_project_tail(
            &args[2..],
            "login",
        )?)),
        Some("logout") => Ok(CliAction::Logout(parse_optional_project_tail(
            &args[2..],
            "logout",
        )?)),
        // A leading flag with no subcommand is the bare-run project override:
        // `speedwave --project acme` / `speedwave --project=acme`.
        Some(flag) if flag.starts_with('-') => Ok(CliAction::Run(parse_optional_project_tail(
            &args[1..],
            "run",
        )?)),
        // A non-flag token that matched no subcommand is a typo, not a silent
        // `run` — reject it so `speedwave updatte` fails loudly.
        Some(unknown) => Err(format!(
            "unknown command: '{unknown}'. Run 'speedwave --help' for usage."
        )),
        None => Ok(CliAction::Run(None)),
    }
}

// ── Self-update constants ──────────────────────────────────────────────────

const REPO_OWNER: &str = "speednet-software";
const REPO_NAME: &str = "speedwave";
const UPDATE_CHECK_INTERVAL_SECS: u64 =
    speedwave_runtime::consts::UPDATE_CHECK_INTERVAL_HOURS as u64 * 3600;

/// Returns true for actions that must run even when an installed plugin fails
/// signature verification (recovery actions like `plugin remove`).
fn skip_plugin_audit(action: &CliAction) -> bool {
    matches!(
        action,
        CliAction::Init(_)
            | CliAction::PluginInstall(_)
            | CliAction::PluginList
            | CliAction::PluginRemove(_)
    )
}

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
                    err!(
                        "Update available: speedwave {} -> {}. Run: speedwave self-update",
                        current,
                        cache.latest_version
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

/// Re-exec the new binary with `update` to rebuild container images with the
/// correct image tags; CWD is inherited from the caller.
fn run_rebuild(exe: &std::path::Path) -> anyhow::Result<()> {
    let status = std::process::Command::new(exe)
        .arg("update")
        .env_remove(speedwave_runtime::consts::BUNDLE_RESOURCES_ENV)
        .status()
        .map_err(|e| anyhow::anyhow!("Failed to run container image rebuild: {e}"))?;
    if !status.success() {
        anyhow::bail!(
            "Container image rebuild failed (exit {}). \
             Ensure Speedwave Desktop is running, then run `speedwave update` \
             again.",
            status.code().unwrap_or(-1)
        );
    }
    Ok(())
}

/// Run the self-update: download the latest release from GitHub and replace the current binary.
fn run_self_update() -> anyhow::Result<()> {
    if is_app_bundle() {
        anyhow::bail!("This binary is part of a Speedwave.app bundle. Please update via the Desktop app instead.");
    }

    // Capture exe path BEFORE self-replace, because on Linux /proc/self/exe
    // will point to the deleted old inode after atomic rename.
    let exe_path = std::env::current_exe()
        .map_err(|e| anyhow::anyhow!("Failed to locate current binary: {e}"))?;

    let current = env!("CARGO_PKG_VERSION");
    out!("Current version: {}", current);
    out!("Checking for updates...");

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
        out!("Updated to version {}.", status.version());
        // Older Desktop resources cannot digest the new image catalogue —
        // skip the rebuild with guidance instead of bricking every invocation.
        let resources_version = speedwave_runtime::build::resolve_build_root()
            .ok()
            .and_then(|root| speedwave_runtime::bundle::manifest_app_version_in(&root));
        let new_version = status.version().trim_start_matches('v').to_string();
        match resources_version {
            Some(v) if v.trim_start_matches('v') != new_version => {
                out!(
                    "Installed Speedwave Desktop resources are v{v}. Update the Desktop \
                     app, then run `speedwave update` to rebuild container images."
                );
            }
            _ => {
                out!("Rebuilding container images...");
                if let Err(e) = run_rebuild(&exe_path) {
                    let e = redact_err(&e);
                    err!("Binary updated successfully, but container rebuild failed: {e}");
                    std::process::exit(1);
                }
                out!("Container images rebuilt successfully.");
            }
        }
    } else {
        out!("Already up to date ({}).", current);
    }

    Ok(())
}

/// Validate that a project name is safe for use as a container name component.
/// Delegates to the canonical validation in `speedwave_runtime::validation`.
fn validate_project_name(name: &str) -> Result<(), String> {
    validation::validate_project_name(name).map_err(|e| e.to_string())
}

/// Builds the `login` exec argv: a shell that unsets non-Anthropic provider env,
/// re-exports the proxy base URL, then execs `claude auth login --claudeai` so
/// the OAuth flow starts directly (no interactive prompt, no MCP session).
fn build_login_exec_cmd(base_url: &str, unset_keys: &[&str]) -> Vec<String> {
    let script = format!(
        "unset {}; export ANTHROPIC_BASE_URL={base_url}; exec {} auth login --claudeai",
        unset_keys.join(" "),
        consts::CLAUDE_BINARY,
    );
    vec!["sh".to_string(), "-lc".to_string(), script]
}

/// Makes Anthropic active on `project`'s `llm` config, creating the override
/// when absent; `false` when `project` has no entry in `user_config` at all.
fn select_anthropic_in(
    user_config: &mut config::SpeedwaveUserConfig,
    project: &str,
    evidence: config::AnthropicEvidence,
) -> bool {
    let Some(entry) = user_config.find_project_mut(project) else {
        return false;
    };
    let claude = entry.claude.get_or_insert_with(Default::default);
    let llm = claude.llm.get_or_insert_with(Default::default);
    // Lift v1 BEFORE selecting — set_active_to_anthropic on a raw v1 shape
    // stamps schema_version and would permanently disable the lift (data loss).
    let migrated = config::migrate_llm(llm, evidence);
    let selected = llm.set_active_to_anthropic();
    selected || migrated
}

/// After a successful `speedwave login`, makes Anthropic active so a
/// logout-emptied OR never-configured project is usable again. No-op when
/// the project has no entry in `user_config` (nothing to attach `llm` to).
fn select_anthropic_after_login(project: &str) -> anyhow::Result<()> {
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        let evidence = config::AnthropicEvidence::detect_in(consts::data_dir().as_path(), project);
        if select_anthropic_in(&mut user_config, project, evidence) {
            config::save_user_config(&user_config)?;
        }
        Ok(())
    })
}

/// Printed by `speedwave --help` / `-h` / `help`. Must not require the
/// runtime or any I/O so users can discover commands before Desktop is
/// running (or while troubleshooting a broken setup).
fn print_help() {
    out!(
        "\
speedwave — run Claude Code in a hardened container per project

USAGE:
    speedwave         [--project <p>] Start Claude Code for the active project (or <p>)
    speedwave check                   Run security + OS prerequisite checks
    speedwave init [name]             Register the current directory as a project
    speedwave login   [--project <p>] Run Anthropic OAuth login (sign-in starts automatically)
    speedwave logout  [--project <p>] Delete Claude Code credentials for the project
    speedwave update                  Rebuild container images for the active project
    speedwave self-update             Download the latest speedwave CLI binary

    speedwave plugin install <zip>    Install a plugin from a signed ZIP
    speedwave plugin list             List installed plugins
    speedwave plugin remove <slug>    Uninstall a plugin
    speedwave plugin enable  <id> --project <project>   Enable a plugin per-project
    speedwave plugin disable <id> --project <project>   Disable a plugin per-project

    speedwave --help | -h | help      Show this help and exit

The active project is the one selected in Speedwave Desktop; `--project <p>`
overrides it. The working directory does not select the project.

Most commands require Speedwave Desktop to be running. See docs/guides/cli.md.",
    );
}

fn runtime_not_available() -> ! {
    err!("Speedwave runtime is not running.");
    err!("CLI requires Speedwave Desktop to be running with a completed setup.");
    err!("1. Open Speedwave.app");
    err!("2. Complete the Setup Wizard");
    err!("3. Start your project");
    err!("Then run `speedwave` again.");
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
            err!("PANIC: {sanitized}");
        }
    }));

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format(|buf, record| {
            use std::io::Write;
            let sanitized =
                speedwave_runtime::log_sanitizer::sanitize(&format!("{}", record.args()));
            // One timestamp format for every Speedwave log line — see
            // `speedwave_runtime::log_ts` (the Rust SSOT).
            let ts = speedwave_runtime::log_ts::log_timestamp();
            writeln!(
                buf,
                "{ts} [{level}][{target}] {sanitized}",
                level = record.level(),
                target = record.target(),
            )
        })
        .init();

    // If SPEEDWAVE_RESOURCES_DIR is unset, read the marker file the Desktop app
    // writes (e.g. ~/.speedwave/resources-dir → "/usr/lib/Speedwave").
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
        err!("{}", msg);
        std::process::exit(1);
    });

    // `--help` must print usage without touching the runtime; ordering pinned
    // by `main_handles_help_before_runtime_check`.
    if action == CliAction::Help {
        print_help();
        std::process::exit(0);
    }

    // Handle `speedwave self-update` before anything else
    if action == CliAction::SelfUpdate {
        if let Err(e) = run_self_update() {
            let e = redact_err(&e);
            err!("Self-update failed: {e}");
            std::process::exit(1);
        }
        std::process::exit(0);
    }

    // Non-blocking update hint (max once per day, cached)
    maybe_print_update_hint();

    // Persist the LLM schema migration for CLI-first upgrades (Desktop heals at
    // its own startup); non-fatal — resolve still migrates in-memory.
    if let Err(e) = config::heal_llm_config_on_disk() {
        log::warn!("llm config heal failed: {}", redact_err(&e));
    }

    // Hard-fail on tampered plugins, except for recovery actions.
    if !skip_plugin_audit(&action) {
        if let Err(failures) = speedwave_runtime::plugin::audit_all() {
            err!("Plugin verification failed:");
            for (slug, reason) in &failures {
                err!("  • {slug}: {reason}");
            }
            err!(
                "\nFix: speedwave plugin remove <slug>   OR   \
                 rm -rf ~/.speedwave/plugins/<slug>/\nThen reinstall a signed plugin."
            );
            std::process::exit(2);
        }
    }

    // Fail-closed on an invalid MDM telemetry policy, mirroring the Desktop boot
    // check — an org policy never silently vanishes on an admin typo.
    if let Err(e) = speedwave_runtime::config::check_telemetry_policy_at_boot() {
        err!("Organization policy error: {}", redact_err(&e));
        err!("Contact your administrator to correct the managed configuration.");
        std::process::exit(2);
    }

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
                out!("Project '{}' registered at {}", name, canonical_str);
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("already registered") || msg.contains("already exists") {
                    out!("{}", msg);
                } else {
                    return Err(e);
                }
            }
        }
        std::process::exit(0);
    }

    // Handle `speedwave update` — rebuild images + recreate containers
    if let CliAction::Update(_) = action {
        let runtime = detect_runtime();
        if !runtime.is_available() {
            runtime_not_available();
        }
        let user_config = config::load_user_config().unwrap_or_else(|e| {
            err!("Failed to load config: {err}", err = redact_err(&e));
            std::process::exit(1);
        });
        let project_name = resolve_action_project(&action, &user_config)?;
        out!("Updating containers for project '{}'...", project_name);
        match update::update_containers(&runtime, &project_name) {
            Ok(result) => {
                out!(
                    "Updated {} containers ({} images rebuilt)",
                    result.containers_recreated,
                    result.images_rebuilt
                );
                std::process::exit(0);
            }
            Err(e) => {
                let msg = redact_err(&e);
                err!("Container update failed: {msg}");
                // Roll back only when containers are torn down (compose_down+).
                // Early failures leave old containers running; rollback there
                // would needlessly recreate from a possibly stale snapshot.
                if update::is_torn_down(&e) {
                    match update::rollback_containers(&runtime, &project_name) {
                        Ok(()) => err!("Rolled back to the previous container state."),
                        Err(rollback_err) => {
                            let rollback_err = redact_err(&rollback_err);
                            err!(
                                "Automatic rollback also failed: {rollback_err}. \
                                 Run `speedwave` to start containers manually."
                            );
                        }
                    }
                }
                std::process::exit(1);
            }
        }
    }

    // Handle `speedwave logout` — deletes Claude Code's credential files from
    // the per-project CLAUDE_HOME mount; no runtime needed.
    if let CliAction::Logout(_) = action {
        let user_config = config::load_user_config().unwrap_or_else(|e| {
            err!("Failed to load config: {err}", err = redact_err(&e));
            std::process::exit(1);
        });
        let project_name = resolve_action_project(&action, &user_config)?;
        validate_project_name(&project_name).map_err(|e| anyhow::anyhow!(e))?;
        let removed = speedwave_runtime::claude_home::remove_claude_credentials(
            consts::data_dir(),
            &project_name,
        )?;
        if removed == 0 {
            err!("No Claude credentials found for project '{project_name}'.");
        } else {
            err!("Removed Claude credentials for project '{project_name}' ({removed} file(s)).");
        }
        std::process::exit(0);
    }

    // Handle plugin subcommands before runtime check
    // (plugin install/list/remove don't need a running VM)
    match &action {
        CliAction::PluginInstall(path) => {
            let rt = detect_runtime();
            let rt_ref: Option<&speedwave_runtime::runtime::LockedRuntime> =
                if rt.is_available() { Some(&rt) } else { None };
            let outcome = plugin::install_plugin(std::path::Path::new(path), rt_ref, &mut |_| {})?;
            match outcome {
                plugin::InstallOutcome::Installed(manifest) => {
                    out!(
                        "Plugin '{}' ({}) installed successfully",
                        manifest.name,
                        manifest.slug
                    );
                }
                plugin::InstallOutcome::InstalledPendingBuild(manifest) => {
                    err!(
                        "Plugin '{}' ({}) installed; image build failed and will retry on next launch",
                        manifest.name, manifest.slug
                    );
                }
            }
            std::process::exit(0);
        }
        CliAction::PluginList => {
            // Tolerant listing: never fails, reports verification status per plugin.
            let plugins = plugin::list_for_ui();
            if plugins.is_empty() {
                out!("No plugins installed");
            } else {
                for e in &plugins {
                    let name = e
                        .manifest
                        .as_ref()
                        .map(|m| m.name.as_str())
                        .unwrap_or(&e.slug);
                    let version = e
                        .manifest
                        .as_ref()
                        .map(|m| m.version.as_str())
                        .unwrap_or("?");
                    if e.verification_status == plugin::VerificationStatus::Verified {
                        out!("{name} ({}): {version}  [verified]", e.slug);
                    } else {
                        let reason = e.verification_error.as_deref().unwrap_or("unverified");
                        out!("{name} ({}): {version}  [UNVERIFIED: {reason}]", e.slug);
                    }
                }
            }
            std::process::exit(0);
        }
        CliAction::PluginRemove(slug) => {
            let rt = detect_runtime();
            let rt_ref: Option<&speedwave_runtime::runtime::LockedRuntime> =
                if rt.is_available() { Some(&rt) } else { None };
            plugin::remove_plugin(slug, rt_ref)?;
            out!("Plugin '{}' removed", slug);
            std::process::exit(0);
        }
        CliAction::PluginEnable {
            service_id,
            project,
        } => {
            // Enabling requires a verified plugin — same gate as the Desktop
            // `set_plugin_enabled` command.
            let entries = plugin::list_for_ui();
            let entry = entries
                .iter()
                .find(|e| {
                    e.manifest.as_ref().map(|m| m.service_id.as_deref()) == Some(Some(service_id))
                        || e.slug == *service_id
                })
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "No installed plugin with service_id '{}'. Run `speedwave plugin list` to see installed plugins.",
                        service_id
                    )
                })?;
            if entry.verification_status != plugin::VerificationStatus::Verified {
                return Err(anyhow::anyhow!(
                    "plugin '{}' cannot be enabled: {}. Reinstall a signed plugin or remove it.",
                    service_id,
                    entry
                        .verification_error
                        .as_deref()
                        .unwrap_or("signature verification failed")
                ));
            }
            let display_name = entry
                .manifest
                .as_ref()
                .map(|m| m.name.clone())
                .unwrap_or_else(|| service_id.clone());
            config::with_config_lock(|| {
                let mut user_config = config::load_user_config()?;
                let cfg_entry = user_config
                    .projects
                    .iter_mut()
                    .find(|p| p.name == *project)
                    .ok_or_else(|| anyhow::anyhow!("project '{}' not found in config", project))?;
                let integrations = cfg_entry.integrations.get_or_insert_with(Default::default);
                integrations.set_plugin_enabled(service_id, true);
                config::save_user_config(&user_config)
            })?;
            out!(
                "Plugin '{}' (service_id: {}) enabled for project '{}'",
                display_name,
                service_id,
                project
            );
            std::process::exit(0);
        }
        CliAction::PluginDisable {
            service_id,
            project,
        } => {
            // Disabling does NOT require verification — a bad plugin must
            // always be turn-off-able. `list_for_ui` is tolerant.
            let entries = plugin::list_for_ui();
            let entry = entries
                .iter()
                .find(|e| {
                    e.manifest.as_ref().map(|m| m.service_id.as_deref()) == Some(Some(service_id))
                        || e.slug == *service_id
                })
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "No installed plugin with service_id '{}'. Run `speedwave plugin list` to see installed plugins.",
                        service_id
                    )
                })?;
            let display_name = entry
                .manifest
                .as_ref()
                .map(|m| m.name.clone())
                .unwrap_or_else(|| service_id.clone());
            config::with_config_lock(|| {
                let mut user_config = config::load_user_config()?;
                let cfg_entry = user_config
                    .projects
                    .iter_mut()
                    .find(|p| p.name == *project)
                    .ok_or_else(|| anyhow::anyhow!("project '{}' not found in config", project))?;
                let integrations = cfg_entry.integrations.get_or_insert_with(Default::default);
                integrations.set_plugin_enabled(service_id, false);
                config::save_user_config(&user_config)
            })?;
            out!(
                "Plugin '{}' (service_id: {}) disabled for project '{}'",
                display_name,
                service_id,
                project
            );
            std::process::exit(0);
        }
        _ => {}
    }

    let runtime = detect_runtime();

    // Install stays the wizard's job; an installed-but-stopped runtime
    // (Lima VM after reboot, containerd down) is recovered right here.
    if !runtime.is_available() {
        if !runtime.is_installed() {
            runtime_not_available();
        }
        err!("Starting the Speedwave runtime (it was stopped)...");
        if let Err(e) = runtime.ensure_ready() {
            err!("Failed to start the runtime: {}", redact_err(&e));
            std::process::exit(1);
        }
    }

    // Live-session marker: Desktop's exit cleanup leaves the VM running while
    // this shared lock is held (kernel-released on any death, incl. SIGKILL).
    let _cli_session = match speedwave_runtime::session::CliSessionGuard::acquire(consts::data_dir())
    {
        Ok(guard) => Some(guard),
        Err(e) => {
            log::warn!("CLI session lock unavailable: {e}");
            None
        }
    };

    // Windows engine invariants (nerdctl pin + drvfs metadata automount);
    // no-op elsewhere. Warn-only, Once-guarded inside.
    speedwave_runtime::provision::ensure_windows_invariants();

    // Load config once — used for both project resolution and compose rendering
    let mut user_config = config::load_user_config().unwrap_or_else(|e| {
        err!("Failed to load config: {err}", err = redact_err(&e));
        std::process::exit(1);
    });

    let project_name = resolve_action_project(&action, &user_config)?;

    // Validate project name is safe for container naming
    validate_project_name(&project_name).map_err(|e| anyhow::anyhow!(e))?;

    // Login must select Anthropic BEFORE render_compose, else the no-provider
    // guard bails and the terminal closes before `claude auth login` runs.
    if matches!(action, CliAction::Login(_)) {
        // Fatal on failure: continuing would hit that very guard and print a
        // misleading "Run `speedwave login`" while the real cause stays hidden.
        if let Err(e) = select_anthropic_after_login(&project_name) {
            err!(
                "Login failed: could not select Anthropic: {}",
                redact_err(&e)
            );
            std::process::exit(1);
        }
        user_config = config::load_user_config().unwrap_or_else(|e| {
            err!("Failed to load config: {err}", err = redact_err(&e));
            std::process::exit(1);
        });
    }

    // Project dir comes from config (authoritative); an unresolved name is a
    // hard error, never a working-directory fallback.
    let project_dir = user_config
        .find_project(&project_name)
        .map(|p| std::path::PathBuf::from(&p.dir))
        .ok_or_else(|| {
            let available = user_config
                .projects
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            anyhow::anyhow!(
                "project '{project_name}' not found in config. Available projects: {available}"
            )
        })?;

    // Cloud-storage preflight (Desktop parity): a TCC-blocked iCloud/OneDrive
    // dir must be a clear message, not a cryptic compose failure.
    if let Err(e) = speedwave_runtime::cloudstorage::check_project_readable_or_err(&project_dir) {
        err!(
            "{}",
            speedwave_runtime::cloudstorage::TCC_USER_REMEDIATION_MESSAGE
        );
        err!("({e})");
        std::process::exit(1);
    }

    let (resolved, integrations) =
        config::resolve_project_config(&project_dir, &user_config, &project_name);

    // Sanitise v1 SharePoint secrets from the worker-mounted token dir.
    // Idempotent; secrets are never migrated.
    let cleaned = speedwave_runtime::legacy_token_cleanup::run_legacy_token_cleanup_at_startup();
    if cleaned > 0 {
        log::info!("legacy_token_cleanup: {cleaned} project(s) sanitised");
    }

    // Self-heal legacy/partial oauth.json shape (ADR-060 addendum); idempotent.
    // Do not re-log the return value (CodeQL taints it).
    let _ = speedwave_runtime::oauth_state_migration::run_oauth_state_migration_at_startup();

    // Host workers (oauth, mcp-os) are Desktop-owned; the CLI must NOT spawn its
    // own. render_compose reads the Desktop-held lock + bearer-map from disk.
    // Reconstruct host-bridge registrations from disk (ADR-074).
    let host_bridges = compose::host_bridges_from_disk();

    let compose_yml = compose::render_compose(
        &project_name,
        &project_dir.to_string_lossy(),
        &resolved,
        &integrations,
        Some(&runtime),
        &host_bridges,
    )?;

    let manifests = plugin::list_installed_plugins().unwrap_or_else(|e| {
        log::warn!("Failed to list installed plugins: {e}");
        Vec::new()
    });
    let expected_paths =
        compose::SecurityExpectedPaths::compute(&project_name, &project_dir.to_string_lossy())?;

    // OS prerequisite check
    let prereq_violations = speedwave_runtime::os_prereqs::check_os_prereqs();

    // Handle `speedwave check` subcommand
    if action == CliAction::Check {
        let security_violations =
            SecurityCheck::run(&compose_yml, &project_name, &manifests, &expected_paths);

        // Non-blocking warnings (e.g. nested virtualization) — printed in both OK and FAILED paths
        let os_warnings = speedwave_runtime::os_prereqs::check_os_warnings();
        for w in &os_warnings {
            err!("  WARNING: {w}\n");
        }

        // ANSI color codes (only when stderr is a terminal)
        let use_color = std::io::IsTerminal::is_terminal(&std::io::stderr());
        let green = if use_color { "\x1b[32m" } else { "" };
        let red = if use_color { "\x1b[31m" } else { "" };
        let reset = if use_color { "\x1b[0m" } else { "" };

        if prereq_violations.is_empty() && security_violations.is_empty() {
            out!("speedwave check OK -- all system checks passed");
            err!();
            for rule in SecurityRule::iter() {
                err!("  {green}OK{reset}    {}  {}", rule, rule.description());
            }
            std::process::exit(0);
        } else {
            err!("speedwave check FAILED -- containers NOT started\n");
            let failed_rules: std::collections::HashSet<SecurityRule> =
                security_violations.iter().map(|v| v.rule).collect();
            for rule in SecurityRule::iter() {
                if failed_rules.contains(&rule) {
                    err!("  {red}FAIL{reset}  {}  {}", rule, rule.description());
                } else {
                    err!("  {green}OK{reset}    {}  {}", rule, rule.description());
                }
            }
            if !prereq_violations.is_empty() {
                err!();
                for v in &prereq_violations {
                    err!("  {} -- {}", v.rule, v.message);
                    err!("  Fix: {}\n", v.remediation);
                }
            }
            if !security_violations.is_empty() {
                err!();
                for v in &security_violations {
                    err!("  [{}] {} -- {}", v.container, v.rule, v.message);
                    err!("  Fix: {}\n", v.remediation);
                }
            }
            std::process::exit(1);
        }
    }

    // Mandatory prereq + security gate before container start
    if !prereq_violations.is_empty() {
        err!("speedwave check FAILED -- containers NOT started\n");
        for v in &prereq_violations {
            err!("  {} -- {}", v.rule, v.message);
            err!("  Fix: {}\n", v.remediation);
        }
        std::process::exit(1);
    }
    speedwave_runtime::fs_security::ensure_data_dir_permissions(&project_name)?;
    let violations = SecurityCheck::run(&compose_yml, &project_name, &manifests, &expected_paths);
    if !violations.is_empty() {
        err!("speedwave check FAILED -- containers NOT started\n");
        for v in &violations {
            err!("  [{}] {} -- {}", v.container, v.rule, v.message);
            err!("  Fix: {}\n", v.remediation);
        }
        std::process::exit(1);
    }

    // Build missing images before compose-up, outside the compose lock (ADR-066).
    let bundle_manifest = speedwave_runtime::bundle::load_current_bundle_manifest()?;
    let enabled_imgs = speedwave_runtime::build::enabled_images(&integrations);
    let prior_state = speedwave_runtime::bundle::load_bundle_state();
    let built = speedwave_runtime::build::build_missing_images_locked(
        &runtime,
        &enabled_imgs,
        &bundle_manifest,
    )
    .map_err(|e| anyhow::anyhow!("container image build failed: {}", redact_err(&e)))?;
    if built > 0 {
        out!("Built {built} container image(s) for this app version");
        // Half-applied bundle bug: an image rebuild without the resource sync
        // leaves stale skills/commands until the next Desktop launch.
        match speedwave_runtime::build::resolve_build_root() {
            Ok(root) => {
                if let Err(e) = speedwave_runtime::bundle::sync_claude_resources(&root) {
                    err!(
                        "Warning: claude-resources sync failed: {} (skills may be stale)",
                        redact_err(&e)
                    );
                }
            }
            Err(e) => err!(
                "Warning: build root unavailable, claude-resources not synced: {}",
                redact_err(&e)
            ),
        }
        // Prune superseded tags (warn-only) so CLI-only users don't leak a tag generation.
        speedwave_runtime::build::prune_superseded_images(
            &runtime,
            &prior_state.applied_image_hashes,
            prior_state.applied_bundle_id.as_deref(),
            &bundle_manifest,
        );
    }
    let enabled_plugin_ids: Vec<&str> = integrations.enabled_plugin_service_ids();
    plugin::ensure_plugin_images(&runtime, &enabled_plugin_ids)
        .map_err(|e| anyhow::anyhow!("plugin image build failed: {}", redact_err(&e)))?;

    // compose_up is idempotent (no --force-recreate). Wrapped in a per-project
    // transaction so a concurrent Desktop process can't overwrite compose.yml
    // between save and up (ADR-066).
    runtime.transaction(&project_name, |runtime| -> anyhow::Result<()> {
        compose::save_compose(&project_name, &compose_yml)?;
        speedwave_runtime::runtime::compose_validate_with_retry(runtime, &project_name)?;
        runtime.compose_up(&project_name)?;
        Ok(())
    })?;

    // Verify container exec works before starting interactive session.
    // Recovers automatically from stale mounts after macOS sleep/resume.
    let container_name = format!("{}_{}_claude", consts::compose_prefix(), project_name);
    ensure_exec_healthy(&runtime, &project_name, &container_name)?;

    // Host clipboard → /workspace/.speedwave/pastes/clip.png (ADR-065). Spawned
    // before the login branch so image paste works in `login` sessions too.
    let _paste_watcher = paste_watcher::PasteWatcher::spawn(project_dir.clone());

    // Handle `speedwave login` — runs `claude auth login` directly so the
    // Anthropic OAuth flow starts at once. Claude Code writes credentials to the mount.
    if let CliAction::Login(_) = action {
        err!("Starting Anthropic sign-in. Follow the prompt, then close the terminal when done.");
        // Unset any non-Anthropic provider env so OAuth runs against Anthropic.
        let instance_id = speedwave_runtime::session::new_instance_id();
        let cmd = stamped_exec_argv(
            &instance_id,
            build_login_exec_cmd(
                compose::PROXY_BASE_URL,
                compose::anthropic_login_unset_keys(),
            ),
        );
        let cmd_ref: Vec<&str> = cmd.iter().map(String::as_str).collect();
        let status = runtime.container_exec(&container_name, &cmd_ref).status()?;
        terminal_restore::sanitize_host_terminal();
        reap_instance(&runtime, &container_name, &instance_id);
        std::process::exit(
            status
                .code()
                .unwrap_or(if status.success() { 0 } else { 1 }),
        );
    }

    // exec -it -> interactive Claude terminal inside container
    let instance_id = speedwave_runtime::session::new_instance_id();
    let mut tail = vec![consts::CLAUDE_BINARY.to_string()];
    tail.extend(resolved.flags.iter().cloned());
    let exec_argv = stamped_exec_argv(&instance_id, tail);
    let exec_cmd: Vec<&str> = exec_argv.iter().map(String::as_str).collect();
    let status = runtime
        .container_exec(&container_name, &exec_cmd)
        .status()?;
    // Claude killed abruptly (VM poweroff, OOM) cannot pop the emulator modes
    // it enabled; the CLI is the last process on the PTY chain that can.
    terminal_restore::sanitize_host_terminal();
    reap_instance(&runtime, &container_name, &instance_id);

    let is_oom = speedwave_runtime::resources::is_oom_exit(&status);
    if is_oom {
        err!("{}", speedwave_runtime::resources::OOM_MESSAGE);
    }
    // Normalize OOM-via-SIGKILL (code()==None on Linux) to 137 for macOS parity.
    let code = status.code().unwrap_or(if is_oom { 137 } else { 1 });
    std::process::exit(code);
}

/// Interactive exec argv carrying the instance marker so an orphaned
/// in-container process can be reaped after the exec transport dies.
fn stamped_exec_argv(instance_id: &str, tail: Vec<String>) -> Vec<String> {
    let mut argv = speedwave_runtime::session::instance_env_argv(instance_id);
    argv.extend(tail);
    argv
}

/// Kills the in-container claude stamped with `instance_id` (host-side death
/// does not propagate through `nerdctl exec`). Best-effort; dead VM is fine.
fn reap_instance(
    runtime: &speedwave_runtime::runtime::LockedRuntime,
    container: &str,
    instance_id: &str,
) {
    let argv = speedwave_runtime::session::kill_by_instance_command(instance_id);
    let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    match runtime.container_exec_piped(container, &argv_refs) {
        Ok(mut cmd) => {
            // output() (not status()) so nerdctl noise never reaches the terminal.
            if let Err(e) = cmd.output() {
                log::debug!("session reap failed: {e}");
            }
        }
        Err(e) => log::debug!("session reap unavailable: {e}"),
    }
}

/// Picks the project an action operates on. An explicit `--project` override
/// wins and must name a real project; otherwise falls back to the active then
/// first configured project. The working directory is never consulted.
fn resolve_action_project(
    action: &CliAction,
    user_config: &config::SpeedwaveUserConfig,
) -> anyhow::Result<String> {
    match action {
        CliAction::Run(Some(name))
        | CliAction::Login(Some(name))
        | CliAction::Logout(Some(name))
        | CliAction::Update(Some(name)) => {
            // An explicit `--project` must name a real project.
            user_config.require_project(name)?;
            Ok(name.clone())
        }
        _ => resolve_project_fallback(user_config),
    }
}

/// Resolves the project when no explicit `--project` was given: the active
/// project is authoritative, else the first configured project. The working
/// directory is never consulted.
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
    fn cli_bare_run_syncs_resources_when_images_rebuilt() {
        // Post-app-update bare run: image rebuild without the resource sync
        // half-applies the bundle (stale skills until Desktop launches).
        let source = include_str!("main.rs");
        let run_flow = source
            .find("Built {built} container image(s)")
            .expect("bare-run rebuild message must exist");
        let window = &source[run_flow..run_flow + 900];
        assert!(
            window.contains("sync_claude_resources"),
            "bare-run rebuild must sync claude-resources alongside images"
        );
    }

    #[test]
    fn interactive_exec_sanitizes_host_terminal_before_exit() {
        // An abruptly killed claude leaves emulator modes enabled (kitty CSI-u,
        // bracketed paste); the CLI must sanitize after the PTY session ends.
        let source = include_str!("main.rs");
        let exec = source
            .find(".container_exec(&container_name, &exec_cmd)")
            .expect("interactive exec must exist");
        let sanitize = source[exec..]
            .find("sanitize_host_terminal()")
            .expect("interactive exec must sanitize the host terminal after status()");
        let oom = source[exec..]
            .find("is_oom_exit(&status)")
            .expect("OOM check must exist after the interactive exec");
        assert!(
            sanitize < oom,
            "sanitize must run before the OOM message so it renders on a sane terminal"
        );
    }

    #[test]
    fn login_exec_sanitizes_host_terminal_before_exit() {
        let source = include_str!("main.rs");
        let exec = source
            .find(".container_exec(&container_name, &cmd_ref)")
            .expect("login exec must exist");
        let window = &source[exec..exec + 300];
        assert!(
            window.contains("sanitize_host_terminal()"),
            "login exec must sanitize the host terminal after status()"
        );
    }

    #[test]
    fn cli_aligns_nerdctl_before_compose_work() {
        let source = include_str!("main.rs");
        let avail = source
            .find("runtime_not_available();")
            .expect("availability gate must exist");
        let align = source
            .find("ensure_windows_invariants();")
            .expect("CLI must apply Windows invariants (nerdctl pin + metadata automount)");
        let txn = source
            .find("runtime.transaction(")
            .expect("compose transaction must exist");
        assert!(
            avail < align && align < txn,
            "Windows invariants must run after availability, before compose work"
        );
    }

    /// Structural (ADR-072): the run path must build missing images BEFORE the
    /// compose transaction — pull_policy:never fails a CLI-first-after-update.
    #[test]
    fn run_builds_missing_images_before_compose_transaction() {
        let src = include_str!("main.rs");
        let build_pos = src
            .find("build_missing_images_locked")
            .expect("run path must build missing images");
        let tx_pos = src
            .find("runtime.transaction(&project_name")
            .expect("run path must use the compose transaction");
        assert!(
            build_pos < tx_pos,
            "missing-image build (at {build_pos}) must precede the compose \
             transaction (at {tx_pos}) — builds stay outside compose locks"
        );
    }

    /// Structural (ADR-072 GC): when the CLI builds images it must prune superseded
    /// tags immediately after — CLI-only users never see Desktop reconcile, so
    /// without this they leak one tag generation per update.
    #[test]
    fn cli_prunes_superseded_images_after_build() {
        let src = include_str!("main.rs");
        let build_pos = src
            .find("build_missing_images_locked")
            .expect("run path must call build_missing_images_locked");
        let prune_pos = src
            .find("prune_superseded_images")
            .expect("run path must prune superseded images after build");
        assert!(
            build_pos < prune_pos,
            "prune_superseded_images (at {prune_pos}) must follow build_missing_images_locked \
             (at {build_pos}) — prune needs the previous state captured before the build"
        );
        // The prune must use the state captured BEFORE the build.
        let state_pos = src
            .find("load_bundle_state()")
            .expect("run path must load prior bundle state for GC");
        assert!(
            state_pos < build_pos,
            "load_bundle_state (at {state_pos}) must precede build_missing_images_locked \
             (at {build_pos}) — prune compares applied hashes vs new manifest"
        );
    }

    #[test]
    fn parse_action_no_args_returns_run() {
        let args = vec!["speedwave".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Run(None));
    }

    #[test]
    fn parse_action_help_long_flag() {
        let args = vec!["speedwave".to_string(), "--help".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Help);
    }

    #[test]
    fn parse_action_help_short_flag() {
        let args = vec!["speedwave".to_string(), "-h".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Help);
    }

    #[test]
    fn parse_action_help_subcommand() {
        let args = vec!["speedwave".to_string(), "help".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Help);
    }

    /// Regression guard: `main()` must handle Help before any runtime check.
    #[test]
    fn main_handles_help_before_runtime_check() {
        let source = include_str!("main.rs");
        let main_start = source
            .find("\nfn main() -> anyhow::Result<()>")
            .expect("main.rs must define fn main()");
        let main_body = &source[main_start..];
        let help_idx = main_body
            .find("if action == CliAction::Help")
            .expect("main() must handle CliAction::Help");
        let runtime_idx = main_body
            .find("runtime_not_available()")
            .expect("main() must have at least one runtime_not_available call site");
        assert!(
            help_idx < runtime_idx,
            "CliAction::Help must be handled BEFORE any runtime_not_available \
             call site inside main() — otherwise `speedwave --help` fails \
             when Desktop is not running"
        );
    }

    /// CLI must never spawn host workers — Desktop is sole supervisor (ADR-068);
    /// re-adding a spawn call would silently reintroduce the exit-137 crash.
    #[test]
    fn cli_does_not_spawn_host_workers() {
        let source = include_str!("main.rs");
        // Needles assembled from fragments so this test can't match itself;
        // type-prefix catches any spawn variant (spawn / spawn_in).
        let forbidden = [
            (concat!("maybe_", "spawn_oauth_worker"), "oauth"),
            (concat!("OauthProcess::", "spawn"), "oauth"),
            (concat!("McpOsProcess::", "spawn"), "mcp-os"),
        ];
        for (needle, worker) in forbidden {
            assert!(
                !source.contains(needle),
                "CLI must not spawn the {worker} worker ({needle}) — Desktop is the \
                 sole supervisor; two supervisors race kill_stale_node and crash \
                 the Claude exec with exit 137 (ADR-068)"
            );
        }
    }

    /// PasteWatcher must spawn BEFORE the `login` branch, which exits the
    /// process — otherwise image paste is dead in the login session (#image-paste).
    #[test]
    fn paste_watcher_spawns_before_login_branch_exit() {
        let source = include_str!("main.rs");
        let spawn_idx = source
            .find(concat!("PasteWatcher::", "spawn"))
            .expect("main.rs must spawn the PasteWatcher");
        let login_idx = source
            .find("if let CliAction::Login(_) = action")
            .expect("main.rs must handle the login branch");
        assert!(
            spawn_idx < login_idx,
            "PasteWatcher::spawn must run BEFORE the login branch — the login \
             branch ends in process::exit, so a watcher spawned after it never \
             runs during `speedwave login` and clipboard image paste fails there"
        );
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
    fn parse_action_unknown_command_errors() {
        let args = vec!["speedwave".to_string(), "updatte".to_string()];
        let err = parse_action(&args).unwrap_err();
        assert!(
            err.contains("unknown command") && err.contains("updatte"),
            "expected unknown-command error, got: {err}"
        );
    }

    // ── login / logout ─────────────────────────────────────────────────────

    #[test]
    fn parse_action_login_no_project() {
        let args = vec!["speedwave".to_string(), "login".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Login(None));
    }

    #[test]
    fn parse_action_login_with_project() {
        let args = vec![
            "speedwave".to_string(),
            "login".to_string(),
            "--project".to_string(),
            "foo".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Login(Some("foo".to_string()))
        );
    }

    #[test]
    fn parse_action_login_project_flag_without_value() {
        let args = vec![
            "speedwave".to_string(),
            "login".to_string(),
            "--project".to_string(),
        ];
        let err = parse_action(&args).unwrap_err();
        assert!(
            err.contains("speedwave login"),
            "expected usage hint, got: {err}"
        );
    }

    #[test]
    fn parse_action_logout_no_project() {
        let args = vec!["speedwave".to_string(), "logout".to_string()];
        assert_eq!(parse_action(&args).unwrap(), CliAction::Logout(None));
    }

    #[test]
    fn parse_action_logout_with_project() {
        let args = vec![
            "speedwave".to_string(),
            "logout".to_string(),
            "--project".to_string(),
            "bar".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Logout(Some("bar".to_string()))
        );
    }

    #[test]
    fn parse_action_logout_project_flag_without_value() {
        let args = vec![
            "speedwave".to_string(),
            "logout".to_string(),
            "--project".to_string(),
        ];
        assert!(parse_action(&args).is_err());
    }

    // ── hardened parser: 6 defects + compatibility ──────────────────────────

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_action_leading_flag_before_subcommand_errors() {
        // `speedwave --project acme login` must error: `login` is trailing garbage.
        let args = argv(&["speedwave", "--project", "acme", "login"]);
        let err = parse_action(&args).unwrap_err();
        assert!(
            err.contains("unexpected argument") && err.contains("login"),
            "expected trailing-garbage error, got: {err}"
        );
    }

    #[test]
    fn parse_action_update_with_project_space_form() {
        // Defect #3: update now accepts --project (was silently ignored).
        let args = argv(&["speedwave", "update", "--project", "acme"]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Update(Some("acme".to_string()))
        );
    }

    #[test]
    fn parse_action_login_equals_form() {
        // Defect #4: `--project=acme` was silently ignored; now supported.
        let args = argv(&["speedwave", "login", "--project=acme"]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Login(Some("acme".to_string()))
        );
    }

    #[test]
    fn parse_action_bare_run_equals_form() {
        let args = argv(&["speedwave", "--project=acme"]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Run(Some("acme".to_string()))
        );
    }

    #[test]
    fn parse_action_equals_form_empty_value_errors() {
        let args = argv(&["speedwave", "login", "--project="]);
        let err = parse_action(&args).unwrap_err();
        assert!(err.contains("speedwave login"), "got: {err}");
    }

    #[test]
    fn parse_action_login_extra_positional_errors() {
        // Defect #5: garbage after a valid subcommand is rejected.
        let args = argv(&["speedwave", "login", "extra", "junk"]);
        let err = parse_action(&args).unwrap_err();
        assert!(
            err.contains("unexpected argument") && err.contains("extra"),
            "got: {err}"
        );
    }

    #[test]
    fn parse_action_login_extra_after_project_value_errors() {
        let args = argv(&["speedwave", "login", "--project", "acme", "junk"]);
        let err = parse_action(&args).unwrap_err();
        assert!(
            err.contains("unexpected argument") && err.contains("junk"),
            "got: {err}"
        );
    }

    #[test]
    fn parse_action_check_rejects_extra_args() {
        let args = argv(&["speedwave", "check", "junk"]);
        let err = parse_action(&args).unwrap_err();
        assert!(err.contains("speedwave check"), "got: {err}");
    }

    #[test]
    fn parse_action_self_update_rejects_extra_args() {
        let args = argv(&["speedwave", "self-update", "junk"]);
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_init_rejects_extra_args() {
        let args = argv(&["speedwave", "init", "name", "junk"]);
        let err = parse_action(&args).unwrap_err();
        assert!(err.contains("speedwave init"), "got: {err}");
    }

    #[test]
    fn parse_action_plugin_install_rejects_extra_args() {
        let args = argv(&["speedwave", "plugin", "install", "x.zip", "junk"]);
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn parse_action_compat_desktop_login_project_space_form() {
        // HARD CONSTRAINT: Desktop generates `speedwave login --project <name>`.
        let args = argv(&["speedwave", "login", "--project", "My Project"]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Login(Some("My Project".to_string()))
        );
    }

    #[test]
    fn parse_action_compat_bare_run_with_project() {
        // HARD CONSTRAINT: `speedwave --project acme` → Run(Some).
        let args = argv(&["speedwave", "--project", "acme"]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Run(Some("acme".to_string()))
        );
    }

    #[test]
    fn parse_action_compat_bare_run_no_args() {
        // HARD CONSTRAINT: `speedwave` → Run(None).
        let args = argv(&["speedwave"]);
        assert_eq!(parse_action(&args).unwrap(), CliAction::Run(None));
    }

    #[test]
    fn parse_action_compat_plugin_enable_shape() {
        // HARD CONSTRAINT: plugin enable shape unchanged.
        let args = argv(&[
            "speedwave",
            "plugin",
            "enable",
            "slack",
            "--project",
            "acme",
        ]);
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::PluginEnable {
                service_id: "slack".to_string(),
                project: "acme".to_string(),
            }
        );
    }

    #[test]
    fn print_help_lists_login_and_logout() {
        // Source-level check that the `print_help` body documents both subcommands.
        let source = include_str!("main.rs");
        let help_start = source
            .find("fn print_help() {")
            .expect("print_help must exist");
        let help_end = source[help_start..]
            .find("\n}")
            .expect("print_help must end with `}`");
        let body = &source[help_start..help_start + help_end];
        assert!(
            body.contains("speedwave login"),
            "print_help must document `login` subcommand"
        );
        assert!(
            body.contains("speedwave logout"),
            "print_help must document `logout` subcommand"
        );
    }

    #[test]
    fn stamped_exec_argv_places_claude_after_instance_marker() {
        let argv = stamped_exec_argv(
            "id-1",
            vec![consts::CLAUDE_BINARY.to_string(), "--flag".to_string()],
        );
        assert_eq!(argv[0], "env");
        assert_eq!(
            argv[1],
            format!("{}=id-1", speedwave_runtime::session::SESSION_INSTANCE_ENV)
        );
        assert_eq!(argv[2], "/usr/local/bin/claude");
        assert_eq!(argv[3], "--flag");
    }

    #[test]
    fn build_login_exec_cmd_unsets_and_execs_auth_login() {
        let cmd = build_login_exec_cmd(
            "http://proxy:4000",
            &["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"],
        );
        assert_eq!(cmd[0], "sh");
        assert_eq!(cmd[1], "-lc");
        let script = &cmd[2];
        assert!(
            script.contains("unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL"),
            "{script}"
        );
        assert!(
            script.contains("export ANTHROPIC_BASE_URL=http://proxy:4000"),
            "{script}"
        );
        // `auth login --claudeai` runs OAuth directly — no interactive prompt.
        let exec_pos = script.find("exec ").expect("exec present");
        let unset_pos = script.find("unset ").unwrap();
        assert!(unset_pos < exec_pos, "unset must precede exec: {script}");
        assert!(
            script.contains(&format!("{} auth login --claudeai", consts::CLAUDE_BINARY)),
            "auth login subcommand: {script}"
        );
    }

    #[test]
    fn build_login_exec_cmd_uses_runtime_ssot_unset_list() {
        let cmd = build_login_exec_cmd(
            compose::PROXY_BASE_URL,
            compose::anthropic_login_unset_keys(),
        );
        let script = &cmd[2];
        for key in compose::anthropic_login_unset_keys() {
            assert!(script.contains(key), "unset list missing `{key}`: {script}");
        }
        assert!(script.contains(compose::PROXY_BASE_URL), "{script}");
    }

    /// Login must select Anthropic active BEFORE render_compose, so a
    /// logout-emptied project escapes the no-provider guard (avoids the dead-loop
    /// where the login terminal closes before `claude auth login` runs).
    #[test]
    fn login_selects_anthropic_before_render_compose() {
        let source = include_str!("main.rs");
        let select_idx = source
            .find("select_anthropic_after_login(&project_name)")
            .expect("main() must select Anthropic on the login path");
        let render_idx = source
            .find("compose::render_compose(")
            .expect("the CLI must call render_compose in main()");
        assert!(
            select_idx < render_idx,
            "select_anthropic_after_login must run before render_compose"
        );
        // It must be gated on the Login action (not run for plain `speedwave`).
        let gate_idx = source
            .find("if matches!(action, CliAction::Login(_)) {")
            .expect("the Anthropic-select must be gated on the Login action");
        assert!(
            gate_idx < select_idx && select_idx < render_idx,
            "select must sit inside the Login gate, before render_compose"
        );
    }

    /// A select failure on the login path must be fatal — warn-and-continue would
    /// fall into the no-provider guard and print a misleading "Run `speedwave login`".
    #[test]
    fn login_select_failure_is_fatal_not_a_warning() {
        let source = include_str!("main.rs");
        let gate_idx = source
            .find("if matches!(action, CliAction::Login(_)) {")
            .expect("login gate must exist");
        let render_idx = source
            .find("compose::render_compose(")
            .expect("render_compose must exist");
        let block = &source[gate_idx..render_idx];
        assert!(
            block.contains("Login failed: could not select Anthropic")
                && block.contains("std::process::exit(1)"),
            "login select failure must exit non-zero, not warn-and-continue"
        );
    }

    fn user_config_with_project(
        project: &str,
        claude: Option<config::ClaudeOverrides>,
    ) -> config::SpeedwaveUserConfig {
        let mut user_config = config::SpeedwaveUserConfig::default();
        user_config.projects.push(config::ProjectUserEntry {
            name: project.to_string(),
            dir: "/tmp/proj".to_string(),
            claude,
            integrations: None,
            plugin_settings: None,
        });
        user_config
    }

    /// Happy path: a never-configured project (no `claude` override at all)
    /// gets an `llm` override created and Anthropic selected.
    #[test]
    fn select_anthropic_in_creates_llm_override_for_fresh_project() {
        let mut user_config = user_config_with_project("proj", None);
        assert!(select_anthropic_in(
            &mut user_config,
            "proj",
            config::AnthropicEvidence::None
        ));
        let llm = user_config
            .find_project_mut("proj")
            .unwrap()
            .claude
            .as_ref()
            .unwrap()
            .llm
            .as_ref()
            .unwrap();
        assert!(!llm.is_unconfigured());
        assert_eq!(
            llm.active.as_ref().unwrap().provider_id,
            config::ANTHROPIC_PROVIDER_ID,
            "fresh project must select anthropic, not just stop being fresh"
        );
    }

    /// Edge case: `claude` exists but `llm` is `None` (partial override) —
    /// same fresh-llm creation path applies.
    #[test]
    fn select_anthropic_in_creates_llm_override_when_claude_present_but_llm_absent() {
        let mut user_config = user_config_with_project(
            "proj",
            Some(config::ClaudeOverrides {
                env: None,
                settings: None,
                llm: None,
            }),
        );
        assert!(select_anthropic_in(
            &mut user_config,
            "proj",
            config::AnthropicEvidence::None
        ));
        assert!(!user_config
            .find_project_mut("proj")
            .unwrap()
            .claude
            .as_ref()
            .unwrap()
            .llm
            .as_ref()
            .unwrap()
            .is_unconfigured());
    }

    /// Explicit logout (v2 shape, providers present, active cleared) must be
    /// reactivated — the original no-op-when-absent behavior is preserved
    /// when there IS an llm config, just no longer the only path.
    #[test]
    fn select_anthropic_in_reactivates_explicit_logout() {
        let llm = config::LlmConfig {
            schema_version: Some(config::LLM_SCHEMA_VERSION),
            providers: vec![config::LlmProviderEntry {
                id: config::ANTHROPIC_PROVIDER_ID.to_string(),
                kind: config::LlmProviderKind::AnthropicOauth,
                base_url: None,
                model: None,
                has_api_key: false,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: None,
            ..Default::default()
        };
        assert!(
            llm.is_unconfigured(),
            "precondition: logged-out is unconfigured"
        );
        let mut user_config = user_config_with_project(
            "proj",
            Some(config::ClaudeOverrides {
                env: None,
                settings: None,
                llm: Some(llm),
            }),
        );
        assert!(select_anthropic_in(
            &mut user_config,
            "proj",
            config::AnthropicEvidence::None
        ));
        assert!(!user_config
            .find_project_mut("proj")
            .unwrap()
            .claude
            .as_ref()
            .unwrap()
            .llm
            .as_ref()
            .unwrap()
            .is_unconfigured());
    }

    /// Selecting Anthropic on a RAW v1 local config must lift it first —
    /// stamping schema_version pre-lift would erase the local provider forever.
    #[test]
    fn select_anthropic_in_preserves_raw_v1_local_config() {
        let mut user_config = user_config_with_project(
            "proj",
            Some(config::ClaudeOverrides {
                env: None,
                settings: None,
                llm: Some(config::LlmConfig {
                    provider: Some("lmstudio".into()),
                    base_url: Some("http://localhost:1234".into()),
                    model: Some("qwen".into()),
                    ..Default::default()
                }),
            }),
        );
        assert!(select_anthropic_in(
            &mut user_config,
            "proj",
            config::AnthropicEvidence::Oauth
        ));
        let binding = user_config.find_project_mut("proj").unwrap();
        let llm = binding.claude.as_ref().unwrap().llm.as_ref().unwrap();
        let local = llm
            .providers
            .iter()
            .find(|p| p.id == "local")
            .expect("local entry must survive the lift");
        assert_eq!(local.base_url.as_deref(), Some("http://localhost:1234"));
        assert_eq!(local.model.as_deref(), Some("qwen"));
        assert_eq!(
            llm.active.as_ref().unwrap().provider_id,
            config::ANTHROPIC_PROVIDER_ID
        );
    }

    /// A raw v1 anthropic config keeps its pinned model through
    /// login (the lift runs before the entry is fabricated model-less).
    #[test]
    fn select_anthropic_in_preserves_v1_pinned_anthropic_model() {
        let mut user_config = user_config_with_project(
            "proj",
            Some(config::ClaudeOverrides {
                env: None,
                settings: None,
                llm: Some(config::LlmConfig {
                    provider: Some(config::ANTHROPIC_PROVIDER_ID.to_string()),
                    model: Some("claude-opus-4-6".into()),
                    ..Default::default()
                }),
            }),
        );
        select_anthropic_in(&mut user_config, "proj", config::AnthropicEvidence::Oauth);
        let binding = user_config.find_project_mut("proj").unwrap();
        let llm = binding.claude.as_ref().unwrap().llm.as_ref().unwrap();
        assert_eq!(
            llm.effective_active_model().as_deref(),
            Some("claude-opus-4-6")
        );
    }

    /// After a self-update, the rebuild must be gated on the installed
    /// Desktop resources version — an older tree cannot digest the new catalogue.
    #[test]
    fn run_self_update_checks_resources_version_before_rebuild() {
        let source = include_str!("main.rs");
        let fn_body = extract_fn_body(source, "fn run_self_update(");
        let probe = fn_body
            .find("manifest_app_version_in")
            .expect("run_self_update must probe the installed resources version");
        let rebuild = fn_body
            .find("run_rebuild(")
            .expect("run_self_update must call run_rebuild()");
        assert!(probe < rebuild, "version gate must precede the rebuild");
    }

    /// The CLI must persist the LLM migration on startup (Desktop
    /// heals at its own startup; CLI-first upgrades need parity).
    #[test]
    fn main_heals_llm_config_before_project_actions() {
        let source = include_str!("main.rs");
        let heal = source
            .find("heal_llm_config_on_disk")
            .expect("CLI must persist the LLM schema migration");
        let audit = source
            .find("plugin::audit_all")
            .expect("plugin audit anchor");
        assert!(heal < audit, "heal must run before project actions");
    }

    /// Error path: a project absent from `user_config` entirely is a no-op —
    /// there is nothing to attach an `llm` override to.
    #[test]
    fn select_anthropic_in_noop_when_project_not_found() {
        let mut user_config = config::SpeedwaveUserConfig::default();
        assert!(!select_anthropic_in(
            &mut user_config,
            "ghost-project",
            config::AnthropicEvidence::None
        ));
        assert!(user_config.find_project_mut("ghost-project").is_none());
    }

    /// State transition: already-active Anthropic is idempotent (no spurious
    /// `true` that would trigger an unnecessary config write).
    #[test]
    fn select_anthropic_in_idempotent_when_already_anthropic() {
        let mut llm = config::LlmConfig {
            schema_version: Some(config::LLM_SCHEMA_VERSION),
            providers: vec![config::LlmProviderEntry {
                id: config::ANTHROPIC_PROVIDER_ID.to_string(),
                kind: config::LlmProviderKind::AnthropicOauth,
                base_url: None,
                model: None,
                has_api_key: false,
                context_tokens: None,
                has_custom_headers: false,
            }],
            active: None,
            ..Default::default()
        };
        assert!(
            llm.set_active_to_anthropic(),
            "first activation changes state"
        );
        // Normalize (flat-mirror sync) so only the selection itself is measured.
        config::migrate_llm(&mut llm, config::AnthropicEvidence::None);
        let mut user_config = user_config_with_project(
            "proj",
            Some(config::ClaudeOverrides {
                env: None,
                settings: None,
                llm: Some(llm),
            }),
        );
        assert!(
            !select_anthropic_in(&mut user_config, "proj", config::AnthropicEvidence::None),
            "already-active anthropic must not report a change"
        );
    }

    #[test]
    fn oauth_state_migration_runs_after_cleanup_and_before_render() {
        // Structural guard (ADR-060 addendum): self-heal must run after
        // legacy_token_cleanup and before render_compose.
        let source = include_str!("main.rs");
        let cleanup_idx = source
            .find("run_legacy_token_cleanup_at_startup()")
            .expect("the CLI must call run_legacy_token_cleanup_at_startup in main()");
        let migration_idx = source
            .find("run_oauth_state_migration_at_startup()")
            .expect("the CLI must call run_oauth_state_migration_at_startup in main()");
        let render_idx = source
            .find("compose::render_compose(")
            .expect("the CLI must call render_compose in main()");
        assert!(
            cleanup_idx < migration_idx,
            "oauth_state_migration must run after legacy_token_cleanup"
        );
        assert!(
            migration_idx < render_idx,
            "oauth_state_migration must run before render_compose"
        );
    }

    #[test]
    fn test_exec_cmd_includes_resolved_flags() {
        use speedwave_runtime::defaults;
        let mut tail = vec![consts::CLAUDE_BINARY.to_string()];
        tail.extend(defaults::DEFAULT_FLAGS.iter().map(|f| f.to_string()));
        let argv = stamped_exec_argv("id-2", tail);
        assert!(argv.contains(&consts::CLAUDE_BINARY.to_string()));
        assert!(argv.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(argv.contains(&"--mcp-config".to_string()));
        assert!(argv.contains(&defaults::MCP_CONFIG_PATH.to_string()));
        assert!(argv.contains(&"--strict-mcp-config".to_string()));
    }

    #[test]
    fn interactive_exec_is_stamped_and_reaped() {
        let source = include_str!("main.rs");
        let exec = source
            .find(".container_exec(&container_name, &exec_cmd)")
            .expect("interactive exec must exist");
        let before = &source[exec.saturating_sub(700)..exec];
        assert!(
            before.contains("stamped_exec_argv("),
            "run argv must carry the instance marker"
        );
        let after = &source[exec..exec + 500];
        assert!(
            after.contains("reap_instance("),
            "run path must reap the marked process after status()"
        );
    }

    #[test]
    fn login_exec_is_stamped_and_reaped() {
        let source = include_str!("main.rs");
        let exec = source
            .find(".container_exec(&container_name, &cmd_ref)")
            .expect("login exec must exist");
        let before = &source[exec.saturating_sub(700)..exec];
        assert!(
            before.contains("stamped_exec_argv("),
            "login argv must carry the instance marker"
        );
        let after = &source[exec..exec + 500];
        assert!(
            after.contains("reap_instance("),
            "login path must reap the marked process after status()"
        );
    }

    #[test]
    fn cli_session_guard_spans_compose_and_interactive_execs() {
        // The shared lock tells Desktop's exit cleanup a live CLI session is
        // attached to the VM (kernel-released on any death, incl. SIGKILL).
        let source = include_str!("main.rs");
        let ready = source
            .find("runtime.ensure_ready()")
            .expect("runtime recovery must exist");
        let guard = source
            .find("CliSessionGuard::acquire(")
            .expect("CLI must hold the live-session lock");
        let txn = source
            .find("runtime.transaction(")
            .expect("compose transaction must exist");
        assert!(
            ready < guard && guard < txn,
            "guard must be taken once the VM is confirmed, before compose/image work"
        );
    }

    /// Builds a project entry with the given name; dir is irrelevant now that
    /// resolution ignores CWD, so a fixed placeholder keeps the tests terse.
    fn proj(name: &str) -> config::ProjectUserEntry {
        config::ProjectUserEntry {
            name: name.to_string(),
            dir: format!("/projects/{name}"),
            claude: None,
            integrations: None,
            plugin_settings: None,
        }
    }

    fn config_with(
        projects: Vec<config::ProjectUserEntry>,
        active: Option<&str>,
    ) -> config::SpeedwaveUserConfig {
        config::SpeedwaveUserConfig {
            projects,
            active_project: active.map(str::to_string),
            selected_ide: None,
            ui: None,
            telemetry: None,
        }
    }

    #[test]
    fn resolve_fallback_prefers_active_project() {
        // active_project wins even when it is not first in the list — the
        // Desktop selector is authoritative.
        let cfg = config_with(vec![proj("alpha"), proj("beta")], Some("beta"));
        assert_eq!(resolve_project_fallback(&cfg).unwrap(), "beta");
    }

    #[test]
    fn resolve_fallback_uses_first_when_active_none() {
        let cfg = config_with(vec![proj("alpha"), proj("beta")], None);
        assert_eq!(resolve_project_fallback(&cfg).unwrap(), "alpha");
    }

    #[test]
    fn resolve_fallback_errors_when_no_projects() {
        let cfg = config_with(vec![], None);
        assert!(resolve_project_fallback(&cfg).is_err());
    }

    #[test]
    fn resolve_fallback_ignores_cwd() {
        // A project dir equal to the real CWD must NOT win over active_project:
        // resolution never consults the working directory.
        let cwd = std::env::current_dir().unwrap();
        let cwd_project = config::ProjectUserEntry {
            name: "here".to_string(),
            dir: cwd.to_string_lossy().to_string(),
            claude: None,
            integrations: None,
            plugin_settings: None,
        };
        let cfg = config_with(vec![proj("alpha"), cwd_project], Some("alpha"));
        assert_eq!(resolve_project_fallback(&cfg).unwrap(), "alpha");
    }

    #[test]
    fn parse_action_project_flag_overrides_run() {
        let args = vec![
            "speedwave".to_string(),
            "--project".to_string(),
            "beta".to_string(),
        ];
        assert_eq!(
            parse_action(&args).unwrap(),
            CliAction::Run(Some("beta".to_string()))
        );
    }

    #[test]
    fn parse_action_project_flag_without_value_errors() {
        let args = vec!["speedwave".to_string(), "--project".to_string()];
        assert!(parse_action(&args).is_err());
    }

    #[test]
    fn resolve_action_project_uses_run_override() {
        // `speedwave --project beta` targets beta even when alpha is active.
        let cfg = config_with(vec![proj("alpha"), proj("beta")], Some("alpha"));
        let action = CliAction::Run(Some("beta".to_string()));
        assert_eq!(resolve_action_project(&action, &cfg).unwrap(), "beta");
    }

    #[test]
    fn resolve_action_project_bare_run_uses_active() {
        // Regression guard: bare `speedwave` follows the active project (the
        // Desktop selector), never the working directory.
        let cfg = config_with(vec![proj("alpha"), proj("beta")], Some("beta"));
        let action = CliAction::Run(None);
        assert_eq!(resolve_action_project(&action, &cfg).unwrap(), "beta");
    }

    #[test]
    fn resolve_action_project_login_override_wins() {
        let cfg = config_with(vec![proj("alpha"), proj("beta")], Some("alpha"));
        let action = CliAction::Login(Some("beta".to_string()));
        assert_eq!(resolve_action_project(&action, &cfg).unwrap(), "beta");
    }

    #[test]
    fn resolve_action_project_explicit_missing_errors() {
        // Defect #6: an explicit --project naming a project not in config is a
        // hard error, not a silent fallback to the working directory.
        let cfg = config_with(vec![proj("alpha")], Some("alpha"));
        let action = CliAction::Run(Some("typo".to_string()));
        let err = resolve_action_project(&action, &cfg).unwrap_err();
        assert!(
            err.to_string().contains("not found in config"),
            "expected not-found error, got: {err}"
        );
    }

    #[test]
    fn resolve_action_project_update_override_wins() {
        let cfg = config_with(vec![proj("alpha"), proj("beta")], Some("alpha"));
        let action = CliAction::Update(Some("beta".to_string()));
        assert_eq!(resolve_action_project(&action, &cfg).unwrap(), "beta");
    }

    #[test]
    fn resolve_action_project_logout_override_wins() {
        let cfg = config_with(vec![proj("alpha"), proj("beta")], Some("alpha"));
        let action = CliAction::Logout(Some("beta".to_string()));
        assert_eq!(resolve_action_project(&action, &cfg).unwrap(), "beta");
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
        assert_eq!(parse_action(&args).unwrap(), CliAction::Update(None));
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
    fn test_check_includes_os_prereqs() {
        // Structural test: `speedwave check` runs prereqs before SecurityCheck
        // and prints violations in the expected format.
        let source = include_str!("main.rs");

        // Locate the check subcommand handler
        let check_start = source
            .find("if action == CliAction::Check")
            .expect("CliAction::Check handler must exist in main.rs");
        let check_body = &source[check_start..];

        // prereq_violations is consumed inside the check handler
        assert!(
            check_body.contains("prereq_violations.is_empty()"),
            "check handler must test prereq_violations.is_empty()"
        );

        // Verify the output format: rule -- message + Fix: remediation
        assert!(
            check_body.contains(r#""{} -- {}", v.rule, v.message"#),
            "check handler must print prereq violations as 'rule -- message'"
        );
        assert!(
            check_body.contains(r#""  Fix: {}\n", v.remediation"#),
            "check handler must print 'Fix: remediation' for each prereq violation"
        );

        // Verify prereqs also gate container start (after the check subcommand block)
        let gate_start = source
            .find("// Mandatory prereq + security gate")
            .expect("pre-compose prereq gate must exist in main.rs");
        let gate_body = &source[gate_start..];
        assert!(
            gate_body.contains("prereq_violations.is_empty()"),
            "pre-compose gate must check prereq_violations"
        );
    }

    #[test]
    fn test_check_does_not_autofix_permissions() {
        // `speedwave check` is diagnostic-only: must NOT call ensure_data_dir_permissions.
        // Behavioral coverage: fs_security::tests::test_ensure_roundtrip_fixes_then_check_passes
        let source = include_str!("main.rs");
        let check_start = source
            .find("if action == CliAction::Check")
            .expect("CliAction::Check handler must exist in main.rs");
        // Delimit the check handler by finding the next CliAction:: reference
        // after it (marks the start of subsequent handler code).
        let after_check = &source[check_start..];
        let check_end = after_check[1..]
            .find("CliAction::")
            .map(|pos| pos + 1)
            .expect(
                "there must be another CliAction:: reference after the Check handler \
                 — if this fails, the source structure has changed significantly",
            );
        let check_block = &after_check[..check_end];

        assert!(
            !check_block.contains("ensure_data_dir_permissions"),
            "speedwave check must NOT call ensure_data_dir_permissions — \
             check is diagnostic-only, it reports violations without fixing them"
        );
    }

    #[test]
    fn test_cli_check_calls_check_os_warnings() {
        let source = include_str!("main.rs");
        let check_start = source
            .find("if action == CliAction::Check")
            .expect("CliAction::Check handler must exist in main.rs");
        let check_body = &source[check_start..];
        assert!(
            check_body.contains("check_os_warnings"),
            "CliAction::Check handler must call check_os_warnings()"
        );
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

    // ── plugin audit skip-list ────────────────────────────────────────────
    // Pin which actions run with a tampered plugin on disk.

    #[test]
    fn skip_plugin_audit_skips_recovery_actions() {
        // Recovery actions must run even when another plugin fails audit.
        assert!(skip_plugin_audit(&CliAction::Init(None)));
        assert!(skip_plugin_audit(&CliAction::Init(Some("foo".into()))));
        assert!(skip_plugin_audit(&CliAction::PluginInstall(
            "/tmp/x.zip".into()
        )));
        assert!(skip_plugin_audit(&CliAction::PluginList));
        assert!(skip_plugin_audit(&CliAction::PluginRemove("foo".into())));
    }

    #[test]
    fn skip_plugin_audit_does_not_skip_runtime_actions() {
        // Runtime/config actions must be gated by the audit.
        assert!(!skip_plugin_audit(&CliAction::Run(None)));
        assert!(!skip_plugin_audit(&CliAction::Check));
        assert!(!skip_plugin_audit(&CliAction::Update(None)));
        assert!(!skip_plugin_audit(&CliAction::PluginEnable {
            project: "p".into(),
            service_id: "s".into(),
        }));
        assert!(!skip_plugin_audit(&CliAction::PluginDisable {
            project: "p".into(),
            service_id: "s".into(),
        }));
    }

    // ── self-update rebuild structural tests ─────────────────────────────

    /// Extract the body of a top-level function from source, stopping at the
    /// next top-level `fn ` definition.
    fn extract_fn_body<'a>(source: &'a str, signature: &str) -> &'a str {
        let fn_start = source
            .find(signature)
            .unwrap_or_else(|| panic!("{signature} must exist in main.rs"));
        let after_start = &source[fn_start..];
        // Find the next top-level fn definition (starts at column 0).
        let fn_end = after_start[1..]
            .find("\nfn ")
            .map(|i| i + 1)
            .unwrap_or(after_start.len());
        &after_start[..fn_end]
    }

    #[test]
    fn host_bridges_are_reconstructed_and_passed_to_render_compose() {
        // Structural guard (ADR-074): the CLI must feed disk-reconstructed
        // host bridges into render_compose, not an empty list.
        let source = include_str!("main.rs");
        let fn_body = extract_fn_body(source, "fn main(");
        let build_pos = fn_body.find("compose::host_bridges_from_disk()");
        let render_pos = fn_body
            .find("compose::render_compose(")
            .expect("main() must call render_compose");
        assert!(
            build_pos.is_some_and(|b| b < render_pos),
            "main() must build host_bridges_from_disk() before render_compose"
        );
        // Split needle so this assertion does not match its own source text.
        let empty_default = format!("HostBridgesInfo::{}()", "default");
        assert!(
            !fn_body[..render_pos].contains(&empty_default),
            "main() must not pass an empty HostBridgesInfo to render_compose"
        );
        // Assert the call site receives &host_bridges (not an inline default).
        let call = &fn_body[render_pos..];
        let call_end = call
            .find(';')
            .expect("render_compose statement must end with ;");
        assert!(
            call[..call_end].contains("&host_bridges"),
            "render_compose must receive &host_bridges, not an inline default"
        );
    }

    #[test]
    fn test_self_update_captures_exe_before_update() {
        // Structural test: run_self_update() captures current_exe() BEFORE
        // .update() and calls run_rebuild inside the status.updated() branch.
        let source = include_str!("main.rs");
        let fn_body = extract_fn_body(source, "fn run_self_update(");

        let exe_capture = fn_body
            .find("current_exe()")
            .expect("run_self_update must call current_exe()");
        let update_call = fn_body
            .find(".update()")
            .expect("run_self_update must call .update()");
        let rebuild_call = fn_body
            .find("run_rebuild(")
            .expect("run_self_update must call run_rebuild()");

        assert!(
            exe_capture < update_call,
            "current_exe() must be captured BEFORE .update() call \
             (Linux /proc/self/exe points to deleted inode after rename)"
        );
        assert!(
            update_call < rebuild_call,
            "run_rebuild must be called AFTER .update()"
        );
    }

    #[test]
    fn test_self_update_does_not_propagate_rebuild_error() {
        // The rebuild error must NOT propagate via `?` (the caller's
        // "Self-update failed" message would be misleading); verify `if let Err`.
        let source = include_str!("main.rs");
        let fn_body = extract_fn_body(source, "fn run_self_update(");

        assert!(
            fn_body.contains("if let Err(e) = run_rebuild("),
            "run_rebuild error must be handled with `if let Err`, not `?`"
        );
    }

    #[test]
    fn test_run_rebuild_clears_resources_env() {
        // The subprocess must NOT inherit SPEEDWAVE_RESOURCES_DIR so it reads
        // the fresh marker file instead of a stale value.
        let source = include_str!("main.rs");
        let fn_body = extract_fn_body(source, "fn run_rebuild(");

        assert!(
            fn_body.contains(".env_remove("),
            "run_rebuild must clear BUNDLE_RESOURCES_ENV from subprocess"
        );
    }

    #[test]
    fn test_self_update_rebuild_only_when_updated() {
        // run_rebuild must appear between the `status.updated()` check and the
        // "Already up to date" branch, not unconditionally.
        let source = include_str!("main.rs");
        let fn_body = extract_fn_body(source, "fn run_self_update(");

        let updated_check = fn_body
            .find("status.updated()")
            .expect("must check status.updated()");
        let rebuild_call = fn_body.find("run_rebuild(").expect("must call run_rebuild");
        let already_up_to_date = fn_body
            .find("Already up to date")
            .expect("must have 'Already up to date' branch");

        assert!(
            updated_check < rebuild_call && rebuild_call < already_up_to_date,
            "run_rebuild must be between status.updated() and 'Already up to date'"
        );
    }

    // ── run_rebuild unit tests ──────────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn run_rebuild_nonexistent_binary() {
        let result = run_rebuild(std::path::Path::new("/nonexistent/speedwave"));
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Failed to run"), "unexpected error: {msg}");
    }

    #[cfg(unix)]
    #[test]
    fn run_rebuild_failing_command() {
        let result = run_rebuild(std::path::Path::new("/usr/bin/false"));
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("Ensure Speedwave Desktop"),
            "should include remediation guidance: {msg}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn run_rebuild_successful_command() {
        let result = run_rebuild(std::path::Path::new("/usr/bin/true"));
        assert!(result.is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn run_rebuild_nonexistent_binary_windows() {
        let result = run_rebuild(std::path::Path::new("C:\\nonexistent\\speedwave.exe"));
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("Failed to run"), "unexpected error: {msg}");
    }

    // No Windows equivalent of run_rebuild_failing_command; the
    // nonexistent-binary test covers the Windows error path.

    #[test]
    fn emit_output_line_redacts_secrets() {
        // A Bearer token leaked into an error string must never reach the
        // terminal — every out!/err! line goes through this sanitizer.
        let redacted = sanitize_output_line("Failed: Bearer sk-secret-value-123");
        assert!(
            !redacted.contains("sk-secret-value-123"),
            "leaked: {redacted}"
        );
        assert!(redacted.contains("REDACTED"), "not redacted: {redacted}");
    }

    #[test]
    fn emit_output_line_passes_normal_text_through() {
        let out = sanitize_output_line("Project 'demo' registered at /workspace");
        assert_eq!(out, "Project 'demo' registered at /workspace");
    }

    #[test]
    fn redact_err_strips_secrets_from_error_chains() {
        // An error carrying a token must be redacted before it is interpolated
        // into an `err!`/`out!` line (config/compose/OAuth error chains).
        let err = anyhow::anyhow!("compose render failed: Authorization: Bearer sk-leak-xyz");
        let red = redact_err(&err);
        assert!(!red.contains("sk-leak-xyz"), "leaked: {red}");
        assert!(red.contains("REDACTED"), "not redacted: {red}");
    }

    /// `PluginEnable`/`PluginDisable` must hold `with_config_lock` across their
    /// load→mutate→save sequence, like `select_anthropic_after_login` does —
    /// otherwise a concurrent config writer loses the plugin-enabled update.
    #[test]
    fn plugin_enable_disable_hold_config_lock_across_save() {
        let source = include_str!("main.rs");
        // Full arm header (incl. `} => {`) so this matches only the match arm
        // in main(), not the CliAction-construction call sites in parse_action.
        let enable_arm = "CliAction::PluginEnable {\n            service_id,\n            project,\n        } => {";
        let disable_arm = "CliAction::PluginDisable {\n            service_id,\n            project,\n        } => {";
        for arm_marker in [enable_arm, disable_arm] {
            let arm_start = source
                .find(arm_marker)
                .unwrap_or_else(|| panic!("{arm_marker} must exist in main.rs"));
            // Bound the slice to this arm (it ends with exit) so the assertions
            // can never self-match the test's own string literals below.
            let rest = &source[arm_start..];
            let arm_end = rest
                .find("std::process::exit(0);")
                .unwrap_or_else(|| panic!("{arm_marker} must end with exit(0)"));
            let arm = &rest[..arm_end];
            let lock_pos = arm
                .find("config::with_config_lock(")
                .unwrap_or_else(|| panic!("{arm_marker} must take the config lock"));
            let save_pos = arm
                .find("config::save_user_config(&user_config)")
                .unwrap_or_else(|| panic!("{arm_marker} must call save_user_config"));
            assert!(
                lock_pos < save_pos,
                "{arm_marker} must wrap its load→mutate→save in config::with_config_lock \
                 or a concurrent config writer can lose this update"
            );
        }
    }
}
