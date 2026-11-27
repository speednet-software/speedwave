//! `speedwave` CLI: runs Claude Code in a hardened per-project container.

use speedwave_runtime::config;
use speedwave_runtime::consts;
use speedwave_runtime::update_channel::{self, UpdateChannel};

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

macro_rules! out {
    () => { $crate::emit(false, format_args!("")) };
    ($($arg:tt)*) => { $crate::emit(false, format_args!($($arg)*)) };
}

macro_rules! err {
    () => { $crate::emit(true, format_args!("")) };
    ($($arg:tt)*) => { $crate::emit(true, format_args!($($arg)*)) };
}

mod cli_action;
mod cli_logger;
mod command_needs;
mod commands;
mod paste_watcher;
mod project_command;
mod release_signature;
mod terminal_restore;

use cli_action::{parse_action, CliAction};
use command_needs::command_needs;
use project_command::prepare;

const REPO_OWNER: &str = "speednet-software";
const REPO_NAME: &str = "speedwave";
const GITHUB_API_URL: &str = "https://api.github.com";
const MAX_SIGNATURE_BYTES: u64 = 4096;
const UPDATE_CHECK_INTERVAL_SECS: u64 =
    speedwave_runtime::consts::UPDATE_CHECK_INTERVAL_HOURS as u64 * 3600;

#[derive(serde::Serialize, serde::Deserialize)]
struct UpdateCheckCache {
    last_check: u64,
    latest_version: String,
}

fn main() -> anyhow::Result<()> {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let sanitized = speedwave_runtime::log_sanitizer::sanitize(&format!("{info}"));
        log::error!("PANIC: {sanitized}");
        #[cfg(debug_assertions)]
        default_hook(info);
        #[cfg(not(debug_assertions))]
        {
            let _ = &default_hook;
            if !cli_logger::terminal_handed_over() {
                err!("PANIC: {sanitized}");
            }
        }
    }));

    cli_logger::init();

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

    if action == CliAction::Help {
        print_help();
        std::process::exit(0);
    }

    if action == CliAction::Version {
        out!("speedwave {}", env!("SPEEDWAVE_VERSION"));
        std::process::exit(0);
    }

    if action == CliAction::SelfUpdate {
        if let Err(e) = run_self_update() {
            let e = redact_err(&e);
            err!("Self-update failed: {e}");
            std::process::exit(1);
        }
        std::process::exit(0);
    }

    maybe_print_update_hint();

    if let Err(e) = config::heal_llm_config_on_disk() {
        log::warn!("llm config heal failed: {}", redact_err(&e));
    }

    if command_needs(&action).plugin_audit {
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

    if let Err(e) = speedwave_runtime::config::check_telemetry_policy_at_boot() {
        err!("Organization policy error: {}", redact_err(&e));
        err!("Contact your administrator to correct the managed configuration.");
        std::process::exit(2);
    }

    if let Err(e) = speedwave_runtime::pii_policy::check_pii_policy_at_boot() {
        err!("Organization policy error: {}", redact_err(&e));
        err!("Contact your administrator to correct the managed configuration.");
        std::process::exit(2);
    }

    let prepared = prepare(&action, consts::data_dir())?;
    commands::run(&action, prepared)
}

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
    speedwave update  [--project <p>] Rebuild container images for the active project (or <p>)
    speedwave self-update             Download the latest speedwave CLI binary

    speedwave plugin install <zip>    Install a plugin from a signed ZIP
    speedwave plugin list             List installed plugins
    speedwave plugin remove <slug>    Uninstall a plugin
    speedwave plugin enable  <id> --project <project>   Enable a plugin per-project
    speedwave plugin disable <id> --project <project>   Disable a plugin per-project

    speedwave --help | -h | help       Show this help and exit
    speedwave --version | -V           Show the version and exit

The active project is the one selected in Speedwave Desktop; `--project <p>`
overrides it. The working directory does not select the project.

Most commands require Speedwave Desktop to be running.
Full documentation: https://speedwave.dev/docs",
    );
}

fn maybe_print_update_hint() {
    if is_app_bundle() {
        return;
    }

    let current = env!("SPEEDWAVE_VERSION");

    if let Some(cache) = read_update_cache() {
        let elapsed = now_secs().saturating_sub(cache.last_check);
        if elapsed < UPDATE_CHECK_INTERVAL_SECS {
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

    std::thread::spawn(move || {
        let channel = update_channel::read_update_channel();
        let Ok(target_tag) = target_release_tag(channel) else {
            return;
        };

        write_update_cache(&UpdateCheckCache {
            last_check: now_secs(),
            latest_version: target_tag.trim_start_matches('v').to_string(),
        });
    });
}

fn update_cache_path() -> PathBuf {
    consts::data_dir().join("update-check.json")
}

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

fn is_app_bundle() -> bool {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().contains(".app/"))
        .unwrap_or(false)
}

fn run_self_update() -> anyhow::Result<()> {
    if is_app_bundle() {
        anyhow::bail!("This binary is part of a Speedwave.app bundle. Please update via the Desktop app instead.");
    }

    let exe_path = std::env::current_exe()
        .map_err(|e| anyhow::anyhow!("Failed to locate current binary: {e}"))?;

    let current = env!("SPEEDWAVE_VERSION");
    out!("Current version: {}", current);

    let channel = update_channel::read_update_channel();
    out!("Update channel: {}", channel);
    out!("Checking for updates...");

    let target_tag = target_release_tag(channel)?;

    if !tag_is_newer_than(current, &target_tag)? {
        out!("Already up to date ({}).", current);
        write_update_cache(&UpdateCheckCache {
            last_check: now_secs(),
            latest_version: target_tag.trim_start_matches('v').to_string(),
        });
        return Ok(());
    }

    let status = install_verified_release(
        GITHUB_API_URL,
        &exe_path,
        &target_tag,
        release_signature::UPDATER_PUBKEY,
        false,
    )?;

    write_update_cache(&UpdateCheckCache {
        last_check: now_secs(),
        latest_version: status.version().to_string(),
    });

    if status.is_updated() {
        out!("Updated to version {}.", status.version());
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

fn run_rebuild(exe: &std::path::Path) -> anyhow::Result<()> {
    let status = speedwave_runtime::binary::interactive_command(&exe.to_string_lossy())
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

fn install_verified_release(
    api_base_url: &str,
    install_path: &std::path::Path,
    tag: &str,
    pubkey: &str,
    no_confirm: bool,
) -> anyhow::Result<self_update::VersionStatus> {
    let mut updater = self_update::backends::github::Update::configure();
    updater
        .api_base_url(api_base_url)
        .repo_owner(REPO_OWNER)
        .repo_name(REPO_NAME)
        .bin_name(consts::CLI_BINARY)
        .bin_install_path(install_path)
        .no_confirm(no_confirm)
        .show_download_progress(true)
        .current_version(env!("SPEEDWAVE_VERSION"))
        .release_tag(tag)
        .asset_matcher(|assets| {
            release_signature::archive_asset(assets, self_update::get_target())
        });

    let release = updater.build()?.get_release_version(tag)?;
    let signature = fetch_release_signature(release.assets())?;
    let signed_version = tag.trim_start_matches('v').to_string();
    let pubkey = pubkey.to_string();

    let status = updater
        .verify_archive(move |archive: &std::path::Path| {
            release_signature::verify_archive(archive, &signature, &pubkey, &signed_version)
                .map_err(|e| self_update::Error::archive_verification_rejected(format!("{e:#}")))
        })
        .build()?
        .update()?;
    Ok(status)
}

fn fetch_release_signature(assets: &[self_update::update::ReleaseAsset]) -> anyhow::Result<String> {
    let target = self_update::get_target();
    let archive = release_signature::archive_asset(assets, target)
        .ok_or_else(|| anyhow::anyhow!("The release has no CLI archive for {target}."))?;
    let signature_asset =
        release_signature::signature_asset(assets, &archive).ok_or_else(|| {
            anyhow::anyhow!(
                "The release has no signature for {}; refusing to install an unsigned archive.",
                archive.name()
            )
        })?;

    let mut body = Vec::new();
    self_update::Download::from_url(signature_asset.download_url())
        .request_header("Accept", "application/octet-stream")
        .max_download_size(MAX_SIGNATURE_BYTES)
        .download_to(&mut body)
        .map_err(|e| anyhow::anyhow!("Failed to download {}: {e}", signature_asset.name()))?;
    String::from_utf8(body)
        .map_err(|_| anyhow::anyhow!("{} is not valid UTF-8.", signature_asset.name()))
}

fn target_release_tag(channel: UpdateChannel) -> anyhow::Result<String> {
    update_channel::fetch_release_tag(channel).map_err(|e| anyhow::anyhow!(e))
}

/// `true` when `tag` is a strictly newer release than `current` (full `Ord`, build metadata included).
fn tag_is_newer_than(current: &str, tag: &str) -> anyhow::Result<bool> {
    let current_version = semver::Version::parse(current)
        .map_err(|e| anyhow::anyhow!("Cannot parse current version {current}: {e}"))?;
    let candidate = tag.trim_start_matches('v');
    let candidate_version = semver::Version::parse(candidate)
        .map_err(|e| anyhow::anyhow!("Cannot parse release tag {tag}: {e}"))?;
    Ok(candidate_version > current_version)
}

fn sanitize_output_line(line: &str) -> String {
    speedwave_runtime::log_sanitizer::sanitize(line)
}

fn redact_err(e: &impl std::fmt::Display) -> String {
    sanitize_output_line(&format!("{e:#}"))
}

#[expect(
    clippy::print_stdout,
    clippy::print_stderr,
    reason = "the CLI's single output sink — every other call site routes through out!/err!"
)]
fn emit(to_stderr: bool, args: std::fmt::Arguments<'_>) {
    let line = sanitize_output_line(&args.to_string());
    if to_stderr {
        eprintln!("{line}");
    } else {
        println!("{line}");
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test fixtures assert on setup that must not silently fail"
)]
mod tests {
    use super::*;

    const FIXTURE_PUBKEY: &str = include_str!("../test-fixtures/release-signature/public-key.txt");
    const FIXTURE_OTHER_PUBKEY: &str =
        include_str!("../test-fixtures/release-signature/other-public-key.txt");
    const FIXTURE_TAG: &str = "v1.2.3";
    const FIXTURE_BINARY: &[u8] = b"#!/bin/sh\necho speedwave-test-binary\n";
    const INSTALLED_BINARY: &[u8] = b"installed binary";

    #[cfg(not(windows))]
    const FIXTURE_ARCHIVE: &[u8] =
        include_bytes!("../test-fixtures/release-signature/archive.tar.gz");
    #[cfg(not(windows))]
    const FIXTURE_SIGNATURE: &str =
        include_str!("../test-fixtures/release-signature/archive.tar.gz.sig");
    #[cfg(windows)]
    const FIXTURE_ARCHIVE: &[u8] =
        include_bytes!("../test-fixtures/release-signature/archive-windows.tar.gz");
    #[cfg(windows)]
    const FIXTURE_SIGNATURE: &str =
        include_str!("../test-fixtures/release-signature/archive-windows.tar.gz.sig");

    #[test]
    fn cli_does_not_spawn_host_workers() {
        let source = include_str!("main.rs");
        let forbidden = [(concat!("McpOsProcess::", "spawn"), "mcp-os")];
        for (needle, worker) in forbidden {
            assert!(
                !source.contains(needle),
                "CLI must not spawn the {worker} worker ({needle}) — Desktop is the \
                 sole supervisor; two supervisors race kill_stale_node and crash \
                 the Claude exec with exit 137 (ADR-068)"
            );
        }
    }

    #[test]
    fn print_help_lists_login_and_logout() {
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
    fn print_help_lists_version_flag() {
        let source = include_str!("main.rs");
        let help_start = source
            .find("fn print_help() {")
            .expect("print_help must exist");
        let help_end = source[help_start..]
            .find("\n}")
            .expect("print_help must end with `}`");
        let body = &source[help_start..help_start + help_end];
        assert!(
            body.contains("speedwave --version | -V"),
            "print_help must document `--version | -V` flag"
        );
    }

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

    #[test]
    fn tag_is_newer_than_reports_a_higher_version_tag_as_newer() {
        assert!(tag_is_newer_than("0.21.0", "v0.22.0+41").unwrap());
    }

    #[test]
    fn tag_is_newer_than_reports_the_same_version_as_not_newer() {
        assert!(!tag_is_newer_than("0.21.0+37", "v0.21.0+37").unwrap());
    }

    #[test]
    fn tag_is_newer_than_reports_a_lower_version_tag_as_not_newer() {
        assert!(!tag_is_newer_than("0.21.1", "v0.21.0").unwrap());
    }

    #[test]
    fn tag_is_newer_than_compares_build_metadata() {
        assert!(tag_is_newer_than("0.21.0+37", "v0.21.0+38").unwrap());
        assert!(!tag_is_newer_than("0.21.0+38", "v0.21.0+37").unwrap());
    }

    #[test]
    fn tag_is_newer_than_errors_on_unparsable_current_version() {
        assert!(tag_is_newer_than("not-a-version", "v0.21.0").is_err());
    }

    #[test]
    fn tag_is_newer_than_errors_on_unparsable_tag() {
        assert!(tag_is_newer_than("0.21.0", "not-a-tag").is_err());
    }

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

    #[test]
    fn test_claude_binary_path_is_usr_local_bin() {
        assert_eq!(consts::CLAUDE_BINARY, "/usr/local/bin/claude");
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
    fn maybe_print_update_hint_resolves_tag_by_channel() {
        let source = include_str!("main.rs");
        let fn_body = extract_fn_body(source, "fn maybe_print_update_hint(");
        assert!(
            fn_body.contains("read_update_channel()"),
            "the background hint must read the installation channel"
        );
        assert!(
            fn_body.contains("target_release_tag("),
            "the background hint must resolve the same tag self-update would"
        );
        assert!(
            !fn_body.contains("get_latest_release()"),
            "the hint must not use self_update's own channel-blind release lookup"
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

    fn extract_fn_body<'a>(source: &'a str, signature: &str) -> &'a str {
        let fn_start = source
            .find(signature)
            .unwrap_or_else(|| panic!("{signature} must exist in main.rs"));
        let after_start = &source[fn_start..];
        let fn_end = after_start[1..]
            .find("\nfn ")
            .map(|i| i + 1)
            .unwrap_or(after_start.len());
        &after_start[..fn_end]
    }

    #[test]
    fn test_self_update_does_not_propagate_rebuild_error() {
        let source = include_str!("main.rs");
        let fn_body = extract_fn_body(source, "fn run_self_update(");

        assert!(
            fn_body.contains("if let Err(e) = run_rebuild("),
            "run_rebuild error must be handled with `if let Err`, not `?`"
        );
    }

    #[test]
    fn test_run_rebuild_clears_resources_env() {
        let source = include_str!("main.rs");
        let fn_body = extract_fn_body(source, "fn run_rebuild(");

        assert!(
            fn_body.contains(".env_remove("),
            "run_rebuild must clear BUNDLE_RESOURCES_ENV from subprocess"
        );
    }

    #[test]
    fn test_self_update_rebuild_only_when_updated() {
        let source = include_str!("main.rs");
        let fn_body = extract_fn_body(source, "fn run_self_update(");

        let updated_check = fn_body
            .find("status.is_updated()")
            .expect("must check status.is_updated()");
        let rebuild_call = fn_body.find("run_rebuild(").expect("must call run_rebuild");
        let already_up_to_date = fn_body
            .rfind("Already up to date")
            .expect("must have 'Already up to date' branch");

        assert!(
            updated_check < rebuild_call && rebuild_call < already_up_to_date,
            "run_rebuild must be between status.updated() and 'Already up to date'"
        );
    }

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

    #[test]
    fn emit_output_line_redacts_secrets() {
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
        let err = anyhow::anyhow!("compose render failed: Authorization: Bearer sk-leak-xyz");
        let red = redact_err(&err);
        assert!(!red.contains("sk-leak-xyz"), "leaked: {red}");
        assert!(red.contains("REDACTED"), "not redacted: {red}");
    }

    fn install_from_mock_release(
        archive: &[u8],
        signature: Option<&str>,
        pubkey: &str,
    ) -> (anyhow::Result<self_update::VersionStatus>, Vec<u8>) {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir
            .path()
            .join(format!("speedwave{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&destination, INSTALLED_BINARY).unwrap();
        let mut server = mockito::Server::new();
        let _mocks = mock_release(&mut server, archive, signature);

        let result =
            install_verified_release(&server.url(), &destination, FIXTURE_TAG, pubkey, true);
        (result, std::fs::read(&destination).unwrap())
    }

    fn mock_release(
        server: &mut mockito::ServerGuard,
        archive: &[u8],
        signature: Option<&str>,
    ) -> Vec<mockito::Mock> {
        let archive_name = format!(
            "speedwave-{FIXTURE_TAG}-{}.tar.gz",
            self_update::get_target()
        );
        let mut assets = Vec::new();
        let mut mocks = Vec::new();
        if let Some(signature) = signature {
            assets.push(serde_json::json!({
                "name": format!("{archive_name}.sig"),
                "url": format!("{}/assets/signature", server.url()),
            }));
            mocks.push(
                server
                    .mock("GET", "/assets/signature")
                    .match_header("accept", "application/octet-stream")
                    .with_status(200)
                    .with_body(signature)
                    .create(),
            );
        }
        assets.push(serde_json::json!({
            "name": archive_name,
            "url": format!("{}/assets/archive", server.url()),
        }));
        mocks.push(
            server
                .mock("GET", "/assets/archive")
                .match_header("accept", "application/octet-stream")
                .with_status(200)
                .with_body(archive)
                .create(),
        );
        let release = serde_json::json!({
            "tag_name": FIXTURE_TAG,
            "created_at": "2026-01-01T00:00:00Z",
            "name": FIXTURE_TAG,
            "assets": assets,
        });
        let tag_path = format!("/repos/{REPO_OWNER}/{REPO_NAME}/releases/tags/{FIXTURE_TAG}");
        mocks.push(
            server
                .mock("GET", tag_path.as_str())
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(release.to_string())
                .create(),
        );
        mocks
    }

    #[test]
    fn install_verified_release_replaces_the_binary_with_a_correctly_signed_archive() {
        let (result, destination) =
            install_from_mock_release(FIXTURE_ARCHIVE, Some(FIXTURE_SIGNATURE), FIXTURE_PUBKEY);
        assert!(result.unwrap().is_updated());
        assert_eq!(destination, FIXTURE_BINARY);
    }

    #[test]
    fn install_verified_release_keeps_the_binary_when_the_archive_changed_after_signing() {
        let mut tampered = FIXTURE_ARCHIVE.to_vec();
        tampered.push(0);
        let (result, destination) =
            install_from_mock_release(&tampered, Some(FIXTURE_SIGNATURE), FIXTURE_PUBKEY);
        let err = format!("{:#}", result.err().unwrap());
        assert!(err.contains("does not match its signature"), "{err}");
        assert_eq!(destination, INSTALLED_BINARY);
    }

    #[test]
    fn install_verified_release_keeps_the_binary_when_the_signature_is_from_another_key() {
        let (result, destination) = install_from_mock_release(
            FIXTURE_ARCHIVE,
            Some(FIXTURE_SIGNATURE),
            FIXTURE_OTHER_PUBKEY,
        );
        let err = format!("{:#}", result.err().unwrap());
        assert!(err.contains("different key"), "{err}");
        assert_eq!(destination, INSTALLED_BINARY);
    }

    #[test]
    fn install_verified_release_keeps_the_binary_when_the_release_has_no_signature() {
        let (result, destination) =
            install_from_mock_release(FIXTURE_ARCHIVE, None, FIXTURE_PUBKEY);
        let err = format!("{:#}", result.err().unwrap());
        assert!(err.contains("no signature"), "{err}");
        assert_eq!(destination, INSTALLED_BINARY);
    }
}
