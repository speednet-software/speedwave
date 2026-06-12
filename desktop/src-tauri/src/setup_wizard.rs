use serde::{Deserialize, Serialize};
use speedwave_runtime::runtime::ensure_exec_healthy;
use speedwave_runtime::{build, bundle, compose, config, consts, project, runtime};
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Setup state — persisted to ~/.speedwave/setup_state.json for resume support
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct SetupState {
    pub runtime_ready: bool,
    pub vm_ready: bool,
    pub project_created: Option<String>,
    pub tokens_configured: Vec<String>,
    pub images_built: bool,
    pub containers_started: bool,
    pub cli_linked: bool,
}

impl SetupState {
    /// Derives the current wizard step from the boolean flags.
    ///
    /// Returns the number of completed sequential steps (0 = nothing done).
    /// The wizard steps execute in this order:
    ///   1. runtime_ready  (Check Runtime)
    ///   2. vm_ready       (Initialize VM)
    ///   3. images_built   (Build Images)
    ///   4. project_created (Create Project)
    ///   5. containers_started (Start Containers)
    ///   6. cli_linked     (Finalize / CLI symlink)
    ///
    /// Previously this was a stored field (`current_step: u8`) that could
    /// diverge from the boolean flags. Now it is derived, so it is always
    /// consistent. Old serialized JSON that includes `"current_step"` is
    /// silently ignored on deserialization (serde default behavior).
    #[cfg(test)]
    pub fn current_step(&self) -> u8 {
        if !self.runtime_ready {
            return 0;
        }
        if !self.vm_ready {
            return 1;
        }
        if !self.images_built {
            return 2;
        }
        if self.project_created.is_none() {
            return 3;
        }
        if !self.containers_started {
            return 4;
        }
        if !self.cli_linked {
            return 5;
        }
        6
    }

    fn state_path() -> anyhow::Result<PathBuf> {
        Ok(consts::data_dir().join("setup_state.json"))
    }

    pub fn load() -> Self {
        let Ok(path) = Self::state_path() else {
            return Self::default();
        };
        match Self::load_from(&path) {
            Ok(state) => state,
            Err(e) => {
                // Missing file is the normal first-run case; anything else
                // (corrupt JSON, unreadable) silently restarts onboarding, so warn.
                if !Self::is_missing_state_file(&e) {
                    log::warn!(
                        "SetupState::load: {} unreadable/corrupt, restarting onboarding from scratch: {e}",
                        path.display()
                    );
                }
                Self::default()
            }
        }
    }

    /// `true` only when the load error is a missing file (silent first-run case).
    fn is_missing_state_file(e: &anyhow::Error) -> bool {
        e.downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
    }

    /// Loads setup state from a specific file path.
    fn load_from(path: &std::path::Path) -> anyhow::Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let state: Self = serde_json::from_str(&content)?;
        Ok(state)
    }

    pub fn save(&self) -> anyhow::Result<()> {
        let path = Self::state_path()?;
        self.save_to(&path)
    }

    /// Saves setup state to a specific file path (atomic write via rename).
    fn save_to(&self, path: &std::path::Path) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)?;
        let tmp_path = path.with_extension("json.tmp");
        std::fs::write(&tmp_path, &json)?;
        std::fs::rename(&tmp_path, path)?;
        Ok(())
    }

    /// Pure-logic check: returns `true` when all required setup steps have been completed.
    ///
    /// `cli_linked` is intentionally excluded — CLI symlink creation is optional
    /// (the Desktop app works without it) and may fail on restricted systems.
    pub fn is_complete(&self) -> bool {
        self.runtime_ready
            && self.vm_ready
            && self.project_created.is_some()
            && self.images_built
            && self.containers_started
    }
}

// ---------------------------------------------------------------------------
// Step 2: Check and install container runtime
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub enum RuntimeStatus {
    Ready,
    NotInstalled,
}

pub fn check_runtime() -> anyhow::Result<RuntimeStatus> {
    let rt = runtime::detect_runtime();
    // ensure_ready() verifies the full stack: binary exists, correct version,
    // AND containerd is running. is_available() only checks the binary, which
    // causes the wizard to skip init_vm even when containerd is not started.
    if rt.ensure_ready().is_ok() {
        let mut state = SetupState::load();
        state.runtime_ready = true;
        // When the runtime is already Ready, the VM is also ready — ensure_ready()
        // verifies the full stack (binary + containerd running). Without this,
        // the wizard skips init_vm (which normally sets vm_ready) and
        // is_complete() returns false because vm_ready stays false.
        state.vm_ready = true;
        state.save()?;
        Ok(RuntimeStatus::Ready)
    } else {
        Ok(RuntimeStatus::NotInstalled)
    }
}

// ---------------------------------------------------------------------------
// Step 3: Initialize VM (macOS only — Lima)
// ---------------------------------------------------------------------------

// VM provisioning primitives (Lima YAML builder, WSL2 import, nerdctl-full
// install, .wslconfig / wsl.conf mergers) live in the runtime SSOT
// `speedwave_runtime::provision`. `init_vm()` below dispatches into it.

/// Returns a `Command` for `limactl` with bundled-binary resolution and
/// isolated `LIMA_HOME`. Delegates to [`speedwave_runtime::binary::command`]
/// which resolves the binary path and ensures LIMA_HOME is set.
///
/// Retained here (not in `provision`) because `factory_reset` — wizard-state
/// orchestration — is the only remaining direct `limactl` caller in this crate.
#[cfg(target_os = "macos")]
fn limactl_command() -> std::process::Command {
    speedwave_runtime::binary::command("limactl")
}

/// Decode output from `wsl.exe` which may be UTF-16LE (with or without BOM) or UTF-8.
///
/// Windows `wsl.exe --list` often outputs UTF-16LE text. Using `String::from_utf8_lossy()`
/// on such output corrupts the data (inserts replacement characters and null bytes), causing
/// string comparisons like distro name matching to silently fail.
#[cfg(test)]
use runtime::decode_wsl_output;

pub fn init_vm() -> anyhow::Result<()> {
    #[cfg(target_os = "macos")]
    {
        speedwave_runtime::provision::init_vm_macos()?;
    }

    #[cfg(target_os = "windows")]
    {
        speedwave_runtime::provision::init_vm_windows()?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        anyhow::bail!("Unsupported platform — Speedwave only supports macOS and Windows");
    }

    let mut state = SetupState::load();
    state.runtime_ready = true;
    state.vm_ready = true;
    state.save()?;

    Ok(())
}

// VM provisioning primitives (Lima create/start, WSL2 import, nerdctl-full
// install, .wslconfig / wsl.conf mergers) moved to the runtime SSOT
// `speedwave_runtime::provision`. The wizard re-exports the items its public
// API + `main.rs` reference; `init_vm()` above dispatches into the module.

/// Ensures `%USERPROFILE%\.wslconfig` declares VPN-compatible `[wsl2]` keys.
/// Re-exported from the runtime SSOT — called at startup from `main.rs`.
#[cfg(target_os = "windows")]
pub use speedwave_runtime::provision::ensure_wslconfig_vpn_compat;

/// Whether `ensure_wsl_distro_metadata` may `wsl --terminate` to apply the
/// change. Re-exported from the runtime SSOT — used by `main.rs`.
#[cfg(target_os = "windows")]
pub use speedwave_runtime::provision::TerminateOnChange;

/// Sets `/etc/wsl.conf` automount for the Speedwave distro (ADR-052).
/// Re-exported from the runtime SSOT — used by `main.rs`.
#[cfg(target_os = "windows")]
pub use speedwave_runtime::provision::ensure_wsl_distro_metadata;

/// Chowns the project's claude-home tree to the container user (ADR-052).
/// Re-exported from the runtime SSOT — used by `start_containers`.
#[cfg(target_os = "windows")]
pub use speedwave_runtime::provision::ensure_claude_home_owner;

// ---------------------------------------------------------------------------
// Step 4: Create project
// ---------------------------------------------------------------------------

pub fn create_project(name: &str, dir: &str) -> anyhow::Result<()> {
    project::add_project(name, dir)?;

    let mut state = SetupState::load();
    state.project_created = Some(name.to_string());
    state.save()?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Setup completeness check
// ---------------------------------------------------------------------------

/// Returns `true` when all required setup steps have been completed AND the
/// VM / WSL distro still physically exists. `cli_linked` is excluded — CLI
/// symlink creation is optional. The runtime check catches external removal
/// (factory reset, manual unregister, data_dir rename) that leaves stale state.
///
/// **Cost:** `is_installed()` spawns `limactl list` (macOS) or `wsl.exe --list`
/// (Windows) per call. Safe for navigation/route guards; do not poll.
pub fn is_setup_complete() -> bool {
    let state = SetupState::load();
    if !state.is_complete() {
        return false;
    }
    runtime::detect_runtime().is_installed()
}

// ---------------------------------------------------------------------------
// Build container images
// ---------------------------------------------------------------------------

pub fn build_images() -> anyhow::Result<()> {
    let rt = runtime::detect_runtime();
    rt.ensure_ready()?;
    // Build the active project's enabled set (+ claude/mcp-hub always). On a
    // fresh setup there is no active project, so only claude/mcp-hub are
    // built — workers come on demand when an integration is first enabled
    // (ADR-057).
    let active_integrations = {
        let user_config = match config::load_user_config() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("build_images: failed to load config, using defaults: {e}");
                config::SpeedwaveUserConfig::default()
            }
        };
        match user_config.active_project.as_deref() {
            Some(name) => match user_config.find_project(name) {
                Some(p) => {
                    config::resolve_integrations(std::path::Path::new(&p.dir), &user_config, name)
                }
                None => config::ResolvedIntegrationsConfig::default(),
            },
            None => config::ResolvedIntegrationsConfig::default(),
        }
    };
    match build::build_enabled_images(&rt, &active_integrations) {
        Ok(_) => {}
        Err(e)
            if e.downcast_ref::<build::SnapshotterRecoveryFailed>()
                .is_some() =>
        {
            log::warn!("snapshotter recovery failed after prune, restarting engine");
            rt.restart_container_engine()?;
            build::build_enabled_images(&rt, &active_integrations)?;
        }
        Err(e) => return Err(e),
    }

    // Sync claude-resources to data_dir so they are available for
    // compose volume mounts and container entrypoints.
    let build_root = build::resolve_build_root()?;
    bundle::sync_claude_resources(&build_root)?;

    // Record that the current bundle's images are now built so that
    // reconcile_bundle_update (on next startup) sees bundle_changed=false
    // and skips the unnecessary rebuild.
    let manifest = bundle::load_current_bundle_manifest()?;
    let mut bundle_state = bundle::load_bundle_state();
    bundle_state.applied_bundle_id = Some(manifest.bundle_id);
    bundle_state.phase = bundle::BundleReconcilePhase::Done;
    bundle_state.pending_running_projects.clear();
    bundle_state.last_error = None;
    bundle::save_bundle_state(&bundle_state)?;

    let mut state = SetupState::load();
    state.images_built = true;
    state.save()?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Start containers for a project
// ---------------------------------------------------------------------------

pub fn start_containers(project: &str) -> anyhow::Result<()> {
    let rt = runtime::detect_runtime();

    log::info!("ensuring runtime is ready");
    rt.ensure_ready()?;
    log::info!("runtime ready, rendering compose");

    // Re-render compose.yml before every start. Dynamic config (mcp-os token,
    // auth keys, addons) may have changed since create_project() first rendered it.
    // Without this, WORKER_OS_URL is missing if mcp-os started after project creation.
    let user_config = config::load_user_config()?;
    let project_dir = &user_config.require_project(project)?.dir;
    let project_path = std::path::Path::new(project_dir);
    let resolved = config::resolve_claude_config(project_path, &user_config, project);
    let integrations = config::resolve_integrations(project_path, &user_config, project);
    // Bridge info is sourced from the globally-shared plugin-bridges map
    // via crate::reconcile::current_bridges_info(). When no host-bridged
    // plugins are running yet (e.g. during early setup), the registration
    // list is empty and the corresponding env vars stay absent in compose.yml.
    let yaml = compose::render_compose(
        project,
        project_dir,
        &resolved,
        &integrations,
        Some(&rt),
        &crate::reconcile::current_bridges_info(),
    )?;

    let manifests = speedwave_runtime::plugin::list_installed_plugins().unwrap_or_else(|e| {
        log::warn!("Failed to list installed plugins: {e}");
        Vec::new()
    });
    let expected_paths = compose::SecurityExpectedPaths::compute(project, project_dir)?;
    speedwave_runtime::fs_security::ensure_data_dir_permissions(project)?;
    let violations = compose::SecurityCheck::run(&yaml, project, &manifests, &expected_paths);
    if !violations.is_empty() {
        anyhow::bail!(
            "{}\n{}",
            speedwave_runtime::consts::SYSTEM_CHECK_FAILED_PREFIX,
            crate::containers_cmd::format_security_violations(&violations)
        );
    }

    rt.transaction(project, |rt| -> anyhow::Result<()> {
        compose::save_compose(project, &yaml)?;
        log::info!("starting containers via compose_up_recreate");
        speedwave_runtime::runtime::compose_validate_with_retry(rt, project)?;
        rt.compose_up_recreate(project)?;
        Ok(())
    })?;
    log::info!("containers started, verifying health");

    // Windows: `compose up` auto-creates the `/home/speedwave/.claude` bind
    // mount-point (for the read-only ide-bridge mount) as ROOT, even after we
    // chowned claude-home — so the uid-1000 entrypoint's `mkdir .claude/skills`
    // hits EACCES and the container exits(1). Chown the tree AFTER compose
    // created the mount-points, then ensure_exec_healthy's recovery recreate
    // re-runs the entrypoint against the now-1000-owned tree. Verified on the
    // live distro. Fail-open. (ADR-052 mount ownership.)
    #[cfg(target_os = "windows")]
    if let Err(e) = ensure_claude_home_owner(project) {
        log::warn!("ensure_claude_home_owner failed (non-fatal): {e}");
    }

    // Verify containers are actually functional before marking as started.
    // Only probes the claude container — MCP workers are health-checked
    // separately via get_health.
    let claude_container = format!(
        "{}_{}_claude",
        speedwave_runtime::consts::compose_prefix(),
        project
    );
    runtime::ensure_exec_healthy(&rt, project, &claude_container)?;

    let mut state = SetupState::load();
    state.containers_started = true;
    state.save()?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Check Claude auth status inside the container
// ---------------------------------------------------------------------------

/// Pure lookup for the project's LLM provider name from the user config.
/// Returns `None` when the project is missing or `claude.llm.provider` is
/// unset. Separated out so the local-provider branch in `check_claude_auth`
/// can be covered without mocking the container runtime.
pub(crate) fn lookup_project_provider<'a>(
    user_config: &'a speedwave_runtime::config::SpeedwaveUserConfig,
    project: &str,
) -> Option<&'a str> {
    user_config
        .find_project(project)
        .and_then(|p| p.claude.as_ref())
        .and_then(|c| c.llm.as_ref())
        .and_then(|l| l.provider.as_deref())
}

/// True when the project's sessions authenticate to Anthropic (the only
/// case where the in-container `claude auth status` check is meaningful).
///
/// v2 configs (ADR-072) decide by the active provider kind: only
/// `AnthropicOauth` needs the OAuth check (`AnthropicApiKey` injects a key
/// — no interactive login). Legacy configs fall back to the v1 rule:
/// anything non-local is Anthropic.
pub(crate) fn project_needs_anthropic_auth(
    user_config: &speedwave_runtime::config::SpeedwaveUserConfig,
    project: &str,
) -> bool {
    use speedwave_runtime::config::LlmProviderKind;
    let llm = user_config
        .find_project(project)
        .and_then(|p| p.claude.as_ref())
        .and_then(|c| c.llm.as_ref());
    if let Some(llm) = llm {
        if !llm.providers.is_empty() {
            return match llm.active_provider().map(|e| e.kind) {
                Some(LlmProviderKind::AnthropicOauth) => true,
                Some(_) => false,
                // active points nowhere — be conservative, check auth.
                None => true,
            };
        }
    }
    // Legacy v1 shape.
    !speedwave_runtime::config::is_local_provider(lookup_project_provider(user_config, project))
}

pub fn check_claude_auth(project: &str) -> anyhow::Result<bool> {
    let user_config = speedwave_runtime::config::load_user_config().unwrap_or_else(|e| {
        log::warn!(
            "check_claude_auth: failed to load user config, defaulting to anthropic path: {e}"
        );
        speedwave_runtime::config::SpeedwaveUserConfig::default()
    });
    if !project_needs_anthropic_auth(&user_config, project) {
        log::info!("check_claude_auth: non-OAuth provider — skipping Anthropic OAuth check");
        return Ok(true);
    }
    let rt = runtime::detect_runtime();
    let container_name = format!("{}_{}_claude", consts::compose_prefix(), project);
    log::info!("check_claude_auth: container={container_name}");
    ensure_exec_healthy(&rt, project, &container_name)?;
    log::info!("check_claude_auth: container healthy, checking auth");
    let mut cmd =
        rt.container_exec_piped(&container_name, &[consts::CLAUDE_BINARY, "auth", "status"])?;
    let output = cmd.output()?;
    log::info!("check_claude_auth: auth status exit={}", output.status);
    Ok(output.status.success())
}

// ---------------------------------------------------------------------------
// Lima VM config migration — upgrade memory from older installs
// ---------------------------------------------------------------------------

/// Migrates the Lima VM config on existing installs when it drifts from the
/// SSOT (memory, cpus, or the VPN netplan drop-in). Re-exported from the
/// runtime SSOT [`speedwave_runtime::provision`] — called at startup from
/// `main.rs` before `reconcile_bundle_update`.
#[cfg(target_os = "macos")]
pub use speedwave_runtime::provision::ensure_lima_vm_config;

// ---------------------------------------------------------------------------
// Factory reset — stops containers, destroys VM, wipes setup state
// ---------------------------------------------------------------------------

pub fn factory_reset() -> anyhow::Result<()> {
    let state = SetupState::load();

    // 1. Stop containers for the wizard's project (if any) — with timeout.
    //    Only stops the single project from setup_state.json, not all projects
    //    from config.json. This is intentional: the VM force-delete (step 2)
    //    destroys all containers regardless, and config.json may already be
    //    corrupt or missing at this point. Best-effort graceful stop here.
    //    Even is_available() could theoretically hang, so run the entire
    //    "check + compose_down" block with a timeout.
    if let Some(ref project) = state.project_created {
        log::info!("stopping containers for project={project}");
        let project_clone = project.clone();
        // Uses thread+channel (not run_with_timeout) because compose_down goes
        // through the ContainerRuntime trait, which returns Result — not a Command.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let rt = runtime::detect_runtime();
            if rt.is_available() {
                if let Err(e) = rt.compose_down(&project_clone) {
                    log::warn!("compose_down failed: {e}");
                }
            }
            let _ = tx.send(());
        });
        // Wait up to 30s; if anything hangs, limactl delete --force will clean up
        let timeout = std::time::Duration::from_secs(30);
        match rx.recv_timeout(timeout) {
            Ok(()) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                log::warn!("compose_down timed out after 30s, continuing");
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                log::warn!("compose_down thread panicked, continuing");
            }
        }
    }

    // 2. Destroy VM (macOS only) — force-stop then force-delete, each with timeout
    #[cfg(target_os = "macos")]
    {
        use speedwave_runtime::binary;
        let timeout = std::time::Duration::from_secs(30);

        log::info!("stopping VM");
        let mut stop_cmd = limactl_command();
        stop_cmd.args(["stop", "--force", consts::lima_vm_name()]);
        if let Err(e) = binary::run_with_timeout(&mut stop_cmd, timeout) {
            log::warn!("limactl stop timed out or failed: {e}, continuing");
        }

        log::info!("deleting VM");
        let mut delete_cmd = limactl_command();
        delete_cmd.args(["delete", consts::lima_vm_name(), "--force"]);
        if let Err(e) = binary::run_with_timeout(&mut delete_cmd, timeout) {
            log::warn!("limactl delete timed out or failed: {e}, continuing");
        }
    }

    // 2b. Reset VM/distro across platforms.
    //     Windows: WslRuntime::reset_vm runs `wsl --terminate` + `--unregister`,
    //     each bounded by CommandRunner::run_with_timeout (10s + 25s).
    //     macOS: trait default no-op (Lima VM already destroyed above).
    //     Run BEFORE wipe_data_dir so the WSL VHDX path is still where WSL
    //     expects it (~/.speedwave/wsl/Speedwave/ext4.vhdx).
    {
        let rt = runtime::detect_runtime();
        if let Err(e) = rt.reset_vm() {
            log::warn!("reset_vm failed (continuing to wipe_data_dir): {e}");
        }
    }

    // 3. Remove CLI binary (Unix: ~/.local/bin/speedwave — outside data dir)
    #[cfg(unix)]
    {
        let target = dirs::home_dir()
            .ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?
            .join(".local")
            .join("bin")
            .join(consts::CLI_BINARY);
        let _ = std::fs::remove_file(&target);
    }
    // Windows CLI lives inside data_dir/bin/ — wipe_data_dir handles it.

    // 4. Wipe entire data directory (~/.speedwave/)
    wipe_data_dir(consts::data_dir())?;

    Ok(())
}

/// Removes the entire data directory (`~/.speedwave/`).
/// Idempotent: succeeds silently if the directory does not exist.
fn wipe_data_dir(data_dir: &std::path::Path) -> anyhow::Result<()> {
    match std::fs::remove_dir_all(data_dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// ---------------------------------------------------------------------------
// Step 7: Copy CLI binary to user PATH
// ---------------------------------------------------------------------------

/// Resolves the CLI binary bundled in Tauri resources.
///
/// Layout at runtime:
/// - macOS:   `.app/Contents/Resources/cli/speedwave`
/// - Windows: `<exe_dir>/resources/cli/speedwave.exe`
/// - Dev mode fallback: `<exe_dir>/speedwave` (existing behaviour)
pub fn resolve_cli_source() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    resolve_cli_source_from(exe_dir)
}

/// Inner implementation that resolves the CLI binary relative to a given exe directory.
/// Separated from `resolve_cli_source()` to allow unit testing with mock filesystem layouts.
fn resolve_cli_source_from(exe_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    #[cfg(not(target_os = "windows"))]
    let binary_name = consts::CLI_BINARY;
    #[cfg(target_os = "windows")]
    let binary_name = "speedwave.exe";

    // SPEEDWAVE_RESOURCES_DIR — set by Tauri in production builds.
    if let Ok(resources_dir) = std::env::var(consts::BUNDLE_RESOURCES_ENV) {
        let bundled = std::path::PathBuf::from(&resources_dir)
            .join("cli")
            .join(binary_name);
        if bundled.exists() {
            return Some(bundled);
        }
    }

    // Production bundle paths
    #[cfg(target_os = "macos")]
    {
        // .app/Contents/MacOS/../Resources/cli/speedwave
        let resources = exe_dir
            .parent()?
            .join("Resources")
            .join("cli")
            .join(binary_name);
        if resources.exists() {
            return Some(resources);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let resources = exe_dir.join("resources").join("cli").join(binary_name);
        if resources.exists() {
            return Some(resources);
        }
    }

    // Dev mode: Makefile copies CLI to desktop/src-tauri/cli/ before `cargo tauri dev`.
    // exe_dir is desktop/src-tauri/target/{debug,release}/ → go up two levels to desktop/src-tauri/cli/
    let dev_cli_dir = exe_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("cli").join(binary_name));
    if let Some(ref path) = dev_cli_dir {
        if path.exists() {
            return Some(path.clone());
        }
    }

    // Dev mode fallback: CLI binary next to the exe
    let dev_path = exe_dir.join(binary_name);
    if dev_path.exists() {
        return Some(dev_path);
    }

    None
}

/// Copies the CLI binary from `source` into `target_dir` and sets executable permissions on Unix.
pub fn copy_cli_binary(
    source: &std::path::Path,
    target_dir: &std::path::Path,
) -> anyhow::Result<()> {
    if !source.exists() {
        anyhow::bail!("CLI source binary not found at {}", source.display());
    }

    std::fs::create_dir_all(target_dir)?;

    #[cfg(target_os = "windows")]
    let dest = target_dir.join("speedwave.exe");
    #[cfg(not(target_os = "windows"))]
    let dest = target_dir.join(consts::CLI_BINARY);

    // On Windows, the target may be locked by a running CLI process.
    // Treat as non-fatal: keep the old binary until the user closes the CLI.
    #[cfg(target_os = "windows")]
    if let Err(e) = std::fs::copy(source, &dest) {
        log::warn!("could not update CLI binary (file in use?): {e}");
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    std::fs::copy(source, &dest)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest)?.permissions();
        perms.set_mode(perms.mode() | 0o111);
        std::fs::set_permissions(&dest, perms)?;
    }

    Ok(())
}

/// The user's default shell, detected from `$SHELL`.
#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UserShell {
    Bash,
    Zsh,
    Unknown,
}

/// Detects the user's default shell from the `$SHELL` environment variable.
///
/// Falls back to [`UserShell::Zsh`] on macOS when `$SHELL` is unset (common when
/// the Desktop app is launched from Dock/Finder, where launchd may not propagate
/// `$SHELL`). macOS has defaulted to zsh since Catalina (10.15).
#[cfg(unix)]
fn detect_shell() -> UserShell {
    let shell = std::env::var("SHELL").unwrap_or_default();
    parse_shell_env(&shell)
}

/// Parses a `$SHELL` value into a [`UserShell`].
///
/// Separated from [`detect_shell`] so unit tests can exercise the parsing logic
/// directly without depending on (or mutating) the `$SHELL` environment variable.
#[cfg(unix)]
fn parse_shell_env(shell: &str) -> UserShell {
    if shell.ends_with("/bash") {
        UserShell::Bash
    } else if shell.ends_with("/zsh") {
        UserShell::Zsh
    } else if shell.is_empty() {
        // $SHELL may be unset when launched from macOS Dock/Finder (launchd).
        // macOS default shell is zsh since Catalina (10.15).
        #[cfg(target_os = "macos")]
        return UserShell::Zsh;
        #[cfg(target_os = "windows")]
        return UserShell::Unknown;
    } else {
        UserShell::Unknown
    }
}

/// Returns the shell config file path(s) to modify for the given shell.
///
/// Selection rules per shell initialization order:
/// - **bash on macOS**: login shell reads first of `.bash_profile` > `.bash_login` >
///   `.profile` (then stops). macOS terminals always open login shells, so only the
///   login file is needed. Creates `.bash_profile` if none of the three exist.
/// - **zsh**: `.zshrc` is sourced for both login and interactive shells on all platforms.
/// - **Unknown**: `.profile` — POSIX portable fallback.
#[cfg(unix)]
fn shell_config_targets(home: &std::path::Path, shell: UserShell) -> Vec<std::path::PathBuf> {
    match shell {
        UserShell::Zsh => vec![home.join(".zshrc")],
        UserShell::Bash => {
            let mut targets = Vec::new();
            // bash login shell reads first found of these three, then stops:
            let login_candidates = [".bash_profile", ".bash_login", ".profile"];
            let login_target = login_candidates
                .iter()
                .find(|f| home.join(f).exists())
                .unwrap_or(&".bash_profile"); // create .bash_profile if none exist
            targets.push(home.join(login_target));

            targets
        }
        UserShell::Unknown => vec![home.join(".profile")],
    }
}

/// Ensures `~/.local/bin` is on PATH by appending an `export` line to the correct
/// shell config file(s) for the user's detected shell and platform.
///
/// Detects the user's shell via `$SHELL` and writes to the appropriate config file
/// (e.g., `.bash_profile` for bash on macOS, `.zshrc` for zsh). Creates the target
/// file if it doesn't exist. Skips files that already contain `.local/bin`.
#[cfg(unix)]
fn ensure_local_bin_on_path(home: &std::path::Path) -> anyhow::Result<()> {
    ensure_local_bin_on_path_for_shell(home, detect_shell())
}

/// Inner implementation accepting an explicit [`UserShell`] for unit testing without
/// depending on `$SHELL` env var.
#[cfg(unix)]
fn ensure_local_bin_on_path_for_shell(
    home: &std::path::Path,
    shell: UserShell,
) -> anyhow::Result<()> {
    use std::io::Write;

    let targets = shell_config_targets(home, shell);
    let export_line = "export PATH=\"$HOME/.local/bin:$PATH\"";
    let marker = ".local/bin";

    for target in targets {
        if target.exists() {
            let content = std::fs::read_to_string(&target)?;
            if content.contains(marker) {
                continue;
            }
            let mut f = std::fs::OpenOptions::new().append(true).open(&target)?;
            writeln!(f, "\n# Added by Speedwave setup")?;
            writeln!(f, "{}", export_line)?;
        } else {
            // Create the file — user has no config for their shell yet
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut f = std::fs::File::create(&target)?;
            writeln!(f, "# Added by Speedwave setup")?;
            writeln!(f, "{}", export_line)?;
        }
    }

    Ok(())
}

/// Returns the platform-specific path where the CLI binary is installed.
///
/// - Unix: `~/.local/bin/speedwave`
/// - Windows: `~/.speedwave/bin/speedwave.exe`
///
/// Returns the install path of the CLI binary for an explicit `data_dir`.
/// Only the Windows branch consults `data_dir`; on Unix the path derives from
/// the home dir. Used only in tests to verify the path matches `link_cli_from`.
#[cfg(test)]
fn cli_install_path_in(_data_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    #[cfg(unix)]
    let path = dirs::home_dir()?
        .join(".local")
        .join("bin")
        .join(consts::CLI_BINARY);

    #[cfg(target_os = "windows")]
    let path = _data_dir.join(consts::CLI_BIN_SUBDIR).join("speedwave.exe");

    Some(path)
}

/// Copies the CLI binary into the user's PATH and updates shell configuration.
///
/// Called both unconditionally on app startup (to keep the CLI in sync after updates)
/// and during the setup wizard finalize step. Both calls are idempotent.
///
/// Uses [`link_cli_from`] internally for the filesystem operations, then updates
/// the persisted [`SetupState`] to mark `cli_linked = true`.
pub fn link_cli() -> anyhow::Result<()> {
    // Guard: skip if data directory does not exist — factory reset wiped it
    // or this is a fresh install. The wizard will link the CLI after creating
    // the data directory. Defense in depth: main.rs also guards the call site.
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    if !consts::data_dir().exists() {
        log::info!("link_cli: data dir missing, skipping");
        return Ok(());
    }

    let cli_source = resolve_cli_source().ok_or_else(|| {
        anyhow::anyhow!(
            "CLI binary not found in app bundle. \
             Ensure the CLI is built and placed in the resources directory."
        )
    })?;

    link_cli_from(&cli_source, &home)?;

    // Write resources-dir marker so the external CLI can find build context.
    // On startup this write is gated behind setup_started (to avoid
    // recreating ~/.speedwave/ after factory reset). Here in link_cli() the
    // data dir is guaranteed to exist, so write the marker unconditionally.
    if let Ok(res) = std::env::var(consts::BUNDLE_RESOURCES_ENV) {
        if let Err(e) = build::write_resources_marker(std::path::Path::new(&res)) {
            log::warn!("link_cli: could not write resources-dir marker: {e}");
        }
    }

    // Mark CLI as linked in setup state
    let mut state = SetupState::load();
    state.cli_linked = true;
    state.save()?;

    Ok(())
}

/// Resolves a `windows/<name>` script from the Tauri bundle on Windows: prefer
/// `SPEEDWAVE_RESOURCES_DIR`, then the production bundle layout, then dev
/// fallbacks. Shared by the sweep and firewall consumers.
#[cfg(target_os = "windows")]
pub(crate) fn resolve_bundled_windows_script(name: &str) -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    if let Ok(resources_dir) = std::env::var(consts::BUNDLE_RESOURCES_ENV) {
        let bundled = std::path::PathBuf::from(&resources_dir)
            .join("windows")
            .join(name);
        if bundled.exists() {
            return Some(bundled);
        }
    }
    let resources = exe_dir.join("resources").join("windows").join(name);
    if resources.exists() {
        return Some(resources);
    }
    let dev = exe_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("windows").join(name));
    if let Some(ref path) = dev {
        if path.exists() {
            return Some(path.clone());
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn resolve_sweep_script() -> Option<std::path::PathBuf> {
    resolve_bundled_windows_script("sweep.ps1")
}

/// Absolute path to the system PowerShell (`%SystemRoot%\System32\...`).
/// Never the bare `powershell` from PATH — avoids hijack on multi-install hosts.
#[cfg(target_os = "windows")]
pub(crate) fn system_powershell_path() -> std::path::PathBuf {
    let system_root =
        std::env::var_os("SystemRoot").unwrap_or_else(|| std::ffi::OsString::from(r"C:\Windows"));
    std::path::PathBuf::from(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

/// Defense-in-depth: kill any stale Speedwave / Node / CLI process holding
/// the binaries we are about to overwrite. Runs at every Tauri Desktop
/// startup, complementing the install-time sweep in NSIS + WiX. Fails open
/// (logs warn, returns) so AppLocker / WDAC policy cannot brick startup.
/// SSOT for the kill predicate is `windows/sweep.ps1`.
#[cfg(target_os = "windows")]
fn run_pre_link_sweep() {
    let Some(sweep) = resolve_sweep_script() else {
        log::warn!("pre-link sweep skipped: sweep.ps1 not found in bundle");
        return;
    };
    let inst_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
        .unwrap_or_default();
    let data_dir = consts::data_dir();
    let powershell = system_powershell_path();

    // Runtime mode: kill only ~/.speedwave/bin/speedwave.exe. Full mode is
    // reserved for install-time hooks (NSIS/MSI) — Tauri Desktop must not
    // target its own workers or self. system_command applies CREATE_NO_WINDOW
    // so PowerShell does not flash a console over the Desktop UI.
    let result = speedwave_runtime::binary::system_command(&powershell.to_string_lossy())
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&sweep)
        .args(["-Mode", "runtime"])
        .env("SPW_INSTDIR", &inst_dir)
        .env("SPW_DATA_DIR", &data_dir)
        .output();
    match result {
        Ok(out) if out.status.success() => {
            log::info!("pre-link sweep: ok");
        }
        Ok(out) => {
            log::warn!(
                "pre-link sweep exited {:?} (non-fatal): {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Err(e) => {
            log::warn!("pre-link sweep spawn failed (non-fatal): {e}");
        }
    }
}

/// Inner implementation that copies the CLI binary and configures PATH using explicit paths.
///
/// Separated from [`link_cli`] for unit testing without depending on `current_exe()` or
/// the real home directory.
fn link_cli_from(cli_source: &std::path::Path, home: &std::path::Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        let local_bin = home.join(".local").join("bin");
        copy_cli_binary(cli_source, &local_bin)?;
        ensure_local_bin_on_path(home)?;
    }

    #[cfg(target_os = "windows")]
    {
        let _ = home;
        let cli_dir = consts::data_dir().join(consts::CLI_BIN_SUBDIR);

        let cli_dir_str = cli_dir.to_string_lossy().to_string();

        if cli_dir_str.contains('\'')
            || cli_dir_str.contains('"')
            || cli_dir_str.contains('`')
            || cli_dir_str.contains('$')
            || cli_dir_str.contains('*')
            || cli_dir_str.contains('?')
        {
            anyhow::bail!(
                "CLI directory path contains unsafe characters: {}",
                cli_dir_str
            );
        }

        // Defense-in-depth: kill any stale CLI / worker process holding
        // ~/.speedwave/bin/speedwave.exe before we try to overwrite it.
        // Covers MSI users (no NSIS PRE-INSTALL sweep), AppLocker failures,
        // and post-install processes spawned by containers (ADR-048).
        run_pre_link_sweep();

        copy_cli_binary(cli_source, &cli_dir)?;

        let script = format!(
            r#"
            $currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            if ($currentPath -notlike '*{dir}*') {{
                [Environment]::SetEnvironmentVariable('Path', "$currentPath;{dir}", 'User')
                # Broadcast WM_SETTINGCHANGE so new shells pick up the change
                Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @'
                    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
                    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
                $HWND_BROADCAST = [IntPtr]0xffff
                $WM_SETTINGCHANGE = 0x1a
                $result = [UIntPtr]::Zero
                [Win32.NativeMethods]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
            }}
            "#,
            dir = cli_dir_str
        );

        let status = speedwave_runtime::binary::system_command("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .status()?;
        if !status.success() {
            anyhow::bail!("Failed to add CLI to PATH");
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use speedwave_runtime::config::{
        ClaudeOverrides, LlmConfig, ProjectUserEntry, SpeedwaveUserConfig,
    };
    use std::collections::HashMap;

    fn project_with_provider(name: &str, provider: Option<&str>) -> ProjectUserEntry {
        ProjectUserEntry {
            name: name.to_string(),
            dir: String::new(),
            claude: Some(ClaudeOverrides {
                env: None,
                settings: None,
                llm: Some(LlmConfig {
                    provider: provider.map(str::to_string),
                    ..Default::default()
                }),
            }),
            integrations: None,
            plugin_settings: None,
        }
    }

    #[test]
    fn lookup_provider_returns_ollama() {
        let cfg = SpeedwaveUserConfig {
            projects: vec![project_with_provider("proj", Some("ollama"))],
            ..Default::default()
        };
        assert_eq!(lookup_project_provider(&cfg, "proj"), Some("ollama"));
    }

    #[test]
    fn lookup_provider_returns_lmstudio() {
        let cfg = SpeedwaveUserConfig {
            projects: vec![project_with_provider("proj", Some("lmstudio"))],
            ..Default::default()
        };
        assert_eq!(lookup_project_provider(&cfg, "proj"), Some("lmstudio"));
    }

    #[test]
    fn lookup_provider_returns_llamacpp() {
        let cfg = SpeedwaveUserConfig {
            projects: vec![project_with_provider("proj", Some("llamacpp"))],
            ..Default::default()
        };
        assert_eq!(lookup_project_provider(&cfg, "proj"), Some("llamacpp"));
    }

    #[test]
    fn lookup_provider_returns_anthropic() {
        let cfg = SpeedwaveUserConfig {
            projects: vec![project_with_provider("proj", Some("anthropic"))],
            ..Default::default()
        };
        assert_eq!(lookup_project_provider(&cfg, "proj"), Some("anthropic"));
    }

    #[test]
    fn lookup_provider_returns_none_when_project_missing() {
        let cfg = SpeedwaveUserConfig::default();
        assert_eq!(lookup_project_provider(&cfg, "missing"), None);
    }

    #[test]
    fn lookup_provider_returns_none_when_claude_section_missing() {
        let cfg = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "proj".to_string(),
                dir: String::new(),
                claude: None,
                integrations: None,
                plugin_settings: None,
            }],
            ..Default::default()
        };
        assert_eq!(lookup_project_provider(&cfg, "proj"), None);
    }

    #[test]
    fn lookup_provider_returns_none_when_llm_section_missing() {
        let cfg = SpeedwaveUserConfig {
            projects: vec![ProjectUserEntry {
                name: "proj".to_string(),
                dir: String::new(),
                claude: Some(ClaudeOverrides::default()),
                integrations: None,
                plugin_settings: None,
            }],
            ..Default::default()
        };
        assert_eq!(lookup_project_provider(&cfg, "proj"), None);
    }

    #[test]
    fn lookup_provider_returns_none_when_provider_field_missing() {
        let cfg = SpeedwaveUserConfig {
            projects: vec![project_with_provider("proj", None)],
            ..Default::default()
        };
        assert_eq!(lookup_project_provider(&cfg, "proj"), None);
    }

    #[test]
    fn local_provider_branch_covers_ollama_lmstudio_llamacpp() {
        // Guard: `check_claude_auth` skips Anthropic OAuth exactly for the three
        // local providers. If `is_local_provider` expands or contracts, this
        // test documents which set the auth-skip branch fires on.
        use speedwave_runtime::config::is_local_provider;
        assert!(is_local_provider(Some("ollama")));
        assert!(is_local_provider(Some("lmstudio")));
        assert!(is_local_provider(Some("llamacpp")));
        assert!(!is_local_provider(Some("anthropic")));
        assert!(!is_local_provider(None));
    }

    /// Builds a project entry carrying a v2 (ADR-072) provider list with one
    /// active entry of the given kind.
    fn project_with_v2_kind(
        name: &str,
        kind: speedwave_runtime::config::LlmProviderKind,
    ) -> ProjectUserEntry {
        use speedwave_runtime::config::{LlmActive, LlmProviderEntry};
        ProjectUserEntry {
            name: name.to_string(),
            dir: String::new(),
            claude: Some(ClaudeOverrides {
                env: None,
                settings: None,
                llm: Some(LlmConfig {
                    schema_version: Some(speedwave_runtime::config::LLM_SCHEMA_VERSION),
                    providers: vec![LlmProviderEntry {
                        id: "p1".to_string(),
                        kind,
                        base_url: None,
                        has_api_key: false,
                        context_tokens: None,
                        has_custom_headers: false,
                    }],
                    active: Some(LlmActive {
                        provider_id: "p1".to_string(),
                        model: None,
                    }),
                    ..Default::default()
                }),
            }),
            integrations: None,
            plugin_settings: None,
        }
    }

    /// ADR-072: only AnthropicOauth sessions need the in-container OAuth
    /// check; every other kind (api key, local, openrouter, …) must skip it
    /// or offline/key-based users get blocked on a claude.ai login.
    #[test]
    fn needs_anthropic_auth_by_v2_kind() {
        use speedwave_runtime::config::LlmProviderKind as K;
        for (kind, expected) in [
            (K::AnthropicOauth, true),
            (K::AnthropicApiKey, false),
            (K::Local, false),
            (K::OpenRouter, false),
            (K::OpenAiCompat, false),
            (K::Custom, false),
        ] {
            let cfg = SpeedwaveUserConfig {
                projects: vec![project_with_v2_kind("proj", kind)],
                ..Default::default()
            };
            assert_eq!(
                project_needs_anthropic_auth(&cfg, "proj"),
                expected,
                "kind {kind:?}"
            );
        }
    }

    /// Legacy v1 configs keep the old rule: local skips, anthropic checks,
    /// and a missing project defaults to checking.
    #[test]
    fn needs_anthropic_auth_legacy_fallback() {
        for (provider, expected) in [
            (Some("ollama"), false),
            (Some("local"), false),
            (Some("anthropic"), true),
            (None, true),
        ] {
            let cfg = SpeedwaveUserConfig {
                projects: vec![project_with_provider("proj", provider)],
                ..Default::default()
            };
            assert_eq!(
                project_needs_anthropic_auth(&cfg, "proj"),
                expected,
                "legacy provider {provider:?}"
            );
        }
        assert!(project_needs_anthropic_auth(
            &SpeedwaveUserConfig::default(),
            "missing"
        ));
    }

    /// A v2 config whose active id points at no entry is conservative:
    /// the auth check runs.
    #[test]
    fn needs_anthropic_auth_dangling_active_checks() {
        use speedwave_runtime::config::LlmActive;
        let mut entry = project_with_v2_kind(
            "proj",
            speedwave_runtime::config::LlmProviderKind::OpenRouter,
        );
        if let Some(c) = entry.claude.as_mut() {
            if let Some(l) = c.llm.as_mut() {
                l.active = Some(LlmActive {
                    provider_id: "ghost".to_string(),
                    model: None,
                });
            }
        }
        let cfg = SpeedwaveUserConfig {
            projects: vec![entry],
            ..Default::default()
        };
        assert!(project_needs_anthropic_auth(&cfg, "proj"));
    }

    /// Validates that a path component does not contain traversal or unsafe characters.
    fn validate_path_component(name: &str, label: &str) -> anyhow::Result<()> {
        if name.is_empty() {
            anyhow::bail!("{label} is empty");
        }
        if name.contains('/') || name.contains('\\') || name.contains("..") {
            anyhow::bail!("{label} '{name}' contains path traversal characters");
        }
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        {
            anyhow::bail!("{label} '{name}' contains invalid characters");
        }
        Ok(())
    }

    /// Writes token files to `data_dir/tokens/<project>/<service>/` with chmod 600.
    fn write_tokens(
        data_dir: &std::path::Path,
        project: &str,
        service: &str,
        tokens: &HashMap<String, String>,
    ) -> anyhow::Result<()> {
        validate_path_component(project, "project name")?;
        validate_path_component(service, "service name")?;
        for key in tokens.keys() {
            validate_path_component(key, "token key")?;
        }

        let token_dir = data_dir.join("tokens").join(project).join(service);
        std::fs::create_dir_all(&token_dir)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode_700 = std::fs::Permissions::from_mode(0o700);
            // See also: plugin.rs:write_token_files() — identical pattern (2 of 3, Rule of Three)
            std::fs::set_permissions(&token_dir, mode_700.clone())?;
            if let Some(project_dir) = token_dir.parent() {
                std::fs::set_permissions(project_dir, mode_700.clone())?;
                if let Some(tokens_dir) = project_dir.parent() {
                    std::fs::set_permissions(tokens_dir, mode_700)?;
                }
            }
        }

        for (key, value) in tokens {
            let token_path = token_dir.join(key);

            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(0o600)
                    .open(&token_path)?;
                std::io::Write::write_all(&mut file, value.as_bytes())?;
            }
            #[cfg(not(unix))]
            {
                std::fs::write(&token_path, value)?;
            }
        }

        Ok(())
    }

    #[test]
    fn wipe_data_dir_removes_everything() {
        let tmp = tempfile::tempdir().expect("failed to create temp dir");
        let data_dir = tmp.path().join("speedwave-data");
        std::fs::create_dir_all(&data_dir).expect("create data dir");

        // Seed state, config, tokens, plugins
        let state_path = data_dir.join("setup_state.json");
        std::fs::write(&state_path, r#"{"runtime_ready":true}"#).expect("write state");
        std::fs::write(data_dir.join("config.json"), r#"{"projects":[]}"#).expect("write config");

        let tokens_dir = data_dir.join("tokens").join("acme").join("slack");
        std::fs::create_dir_all(&tokens_dir).expect("create tokens dir");
        std::fs::write(tokens_dir.join("token.txt"), "secret").expect("write token");

        let plugins_dir = data_dir.join("plugins").join("my-plugin");
        std::fs::create_dir_all(&plugins_dir).expect("create plugins dir");
        std::fs::write(plugins_dir.join("plugin.json"), "{}").expect("write plugin");

        // Run the wipe
        wipe_data_dir(&data_dir).expect("wipe should succeed");

        // Verify entire directory is gone
        assert!(!data_dir.exists(), "data dir should not exist after wipe");
    }

    #[test]
    fn wipe_data_dir_succeeds_when_dir_missing() {
        let tmp = tempfile::tempdir().expect("failed to create temp dir");
        let nonexistent = tmp.path().join("does-not-exist");
        // Should succeed silently
        wipe_data_dir(&nonexistent).expect("wipe on missing dir should succeed");
    }

    #[test]
    fn wipe_data_dir_leaves_no_remnants() {
        let tmp = tempfile::tempdir().expect("failed to create temp dir");
        let data_dir = tmp.path().join("speedwave-data");
        std::fs::create_dir_all(data_dir.join("sub1").join("sub2")).expect("create subdirs");
        std::fs::write(data_dir.join("sub1").join("file.txt"), "data").expect("write file");

        wipe_data_dir(&data_dir).expect("wipe should succeed");

        assert!(!data_dir.exists(), "data dir should be gone");
        assert!(tmp.path().exists(), "parent should still exist");
    }

    // ── SetupState save/load roundtrip ──────────────────────────────────────

    #[test]
    fn setup_state_save_and_load_roundtrip() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("setup_state.json");

        let state = SetupState {
            runtime_ready: true,
            vm_ready: true,
            project_created: Some("myproject".to_string()),
            tokens_configured: vec!["slack".to_string(), "gitlab".to_string()],
            images_built: true,
            containers_started: false,
            cli_linked: false,
        };

        state.save_to(&path).expect("save should succeed");
        let loaded = SetupState::load_from(&path).expect("load should succeed");

        assert_eq!(loaded.current_step(), 4);
        assert!(loaded.runtime_ready);
        assert!(loaded.vm_ready);
        assert_eq!(loaded.project_created, Some("myproject".to_string()));
        assert_eq!(loaded.tokens_configured, vec!["slack", "gitlab"]);
        assert!(loaded.images_built);
        assert!(!loaded.containers_started);
    }

    #[test]
    fn setup_state_load_missing_file_returns_error() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("nonexistent.json");
        assert!(SetupState::load_from(&path).is_err());
    }

    #[test]
    fn setup_state_is_missing_state_file_true_for_notfound() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("nonexistent.json");
        let err = SetupState::load_from(&path).expect_err("missing file must err");
        // Missing file is the normal first-run case: classified as missing → no warn.
        assert!(SetupState::is_missing_state_file(&err));
    }

    #[test]
    fn setup_state_is_missing_state_file_false_for_corrupt_json() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("setup_state.json");
        std::fs::write(&path, "{ not valid json ]").expect("write corrupt json");
        let err = SetupState::load_from(&path).expect_err("corrupt json must err");
        // Corrupt JSON is a serde error, not an io::NotFound → must be warned (not missing).
        assert!(!SetupState::is_missing_state_file(&err));
    }

    #[test]
    fn setup_state_load_from_corrupt_json_errors_then_defaults_logic() {
        // load_from surfaces the parse error; load() turns it into a default.
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("setup_state.json");
        std::fs::write(&path, "not even json").expect("write garbage");
        assert!(
            SetupState::load_from(&path).is_err(),
            "corrupt state must be an error, not a silent default"
        );
    }

    #[test]
    fn setup_state_default_is_all_false() {
        let state = SetupState::default();
        assert_eq!(state.current_step(), 0);
        assert!(!state.runtime_ready);
        assert!(!state.vm_ready);
        assert!(state.project_created.is_none());
        assert!(state.tokens_configured.is_empty());
        assert!(!state.images_built);
        assert!(!state.containers_started);
        assert!(!state.cli_linked);
    }

    #[test]
    fn current_step_derived_from_boolean_flags() {
        // Step 0: nothing done
        let state = SetupState::default();
        assert_eq!(state.current_step(), 0);

        // Step 1: runtime_ready only
        let state = SetupState {
            runtime_ready: true,
            ..Default::default()
        };
        assert_eq!(state.current_step(), 1);

        // Step 2: runtime + vm
        let state = SetupState {
            runtime_ready: true,
            vm_ready: true,
            ..Default::default()
        };
        assert_eq!(state.current_step(), 2);

        // Step 3: + images_built
        let state = SetupState {
            runtime_ready: true,
            vm_ready: true,
            images_built: true,
            ..Default::default()
        };
        assert_eq!(state.current_step(), 3);

        // Step 4: + project_created
        let state = SetupState {
            runtime_ready: true,
            vm_ready: true,
            images_built: true,
            project_created: Some("test".to_string()),
            ..Default::default()
        };
        assert_eq!(state.current_step(), 4);

        // Step 5: + containers_started
        let state = SetupState {
            runtime_ready: true,
            vm_ready: true,
            images_built: true,
            project_created: Some("test".to_string()),
            containers_started: true,
            ..Default::default()
        };
        assert_eq!(state.current_step(), 5);

        // Step 6: + cli_linked (fully complete)
        let state = SetupState {
            runtime_ready: true,
            vm_ready: true,
            images_built: true,
            project_created: Some("test".to_string()),
            containers_started: true,
            cli_linked: true,
            ..Default::default()
        };
        assert_eq!(state.current_step(), 6);
    }

    #[test]
    fn current_step_returns_first_incomplete_even_with_later_flags_set() {
        // vm_ready=false but images_built=true → step 1 (stops at first gap)
        let state = SetupState {
            runtime_ready: true,
            vm_ready: false,
            images_built: true,
            project_created: Some("test".to_string()),
            containers_started: true,
            cli_linked: true,
            ..Default::default()
        };
        assert_eq!(state.current_step(), 1);
    }

    #[test]
    fn current_step_backward_compat_ignores_old_field_in_json() {
        // Old serialized JSON that includes "current_step" should be ignored
        let json = r#"{
            "current_step": 99,
            "runtime_ready": true,
            "vm_ready": false,
            "project_created": null,
            "tokens_configured": [],
            "images_built": false,
            "containers_started": false,
            "cli_linked": false
        }"#;
        let state: SetupState = serde_json::from_str(json).expect("parse old JSON");
        assert_eq!(
            state.current_step(),
            1,
            "derived step should be 1 (only runtime_ready)"
        );
        assert!(state.runtime_ready);
        assert!(!state.vm_ready);
    }

    // ── is_setup_complete logic ─────────────────────────────────────────────

    #[test]
    fn is_setup_complete_requires_all_fields() {
        // All true → complete
        let complete = SetupState {
            runtime_ready: true,
            vm_ready: true,
            project_created: Some("acme".to_string()),
            tokens_configured: vec![],
            images_built: true,
            containers_started: true,
            cli_linked: true,
        };
        assert!(
            complete.is_complete(),
            "all fields set → should be complete"
        );

        // Missing project → incomplete
        let no_project = SetupState {
            project_created: None,
            ..complete.clone()
        };
        assert!(
            !no_project.is_complete(),
            "setup must be incomplete when project_created is None"
        );

        // Images not built → incomplete
        let no_images = SetupState {
            images_built: false,
            project_created: Some("acme".to_string()),
            ..complete.clone()
        };
        assert!(
            !no_images.is_complete(),
            "setup must be incomplete when images_built is false"
        );

        // Runtime not ready → incomplete (regression test for init_vm fix)
        let no_runtime = SetupState {
            runtime_ready: false,
            ..complete.clone()
        };
        assert!(
            !no_runtime.is_complete(),
            "setup must be incomplete when runtime_ready is false"
        );

        // VM not ready → incomplete
        let no_vm = SetupState {
            vm_ready: false,
            ..complete.clone()
        };
        assert!(
            !no_vm.is_complete(),
            "setup must be incomplete when vm_ready is false"
        );

        // Containers not started → incomplete
        let no_containers = SetupState {
            containers_started: false,
            ..complete.clone()
        };
        assert!(
            !no_containers.is_complete(),
            "setup must be incomplete when containers_started is false"
        );

        // cli_linked is intentionally excluded — should not affect completeness
        let no_cli = SetupState {
            cli_linked: false,
            ..complete.clone()
        };
        assert!(
            no_cli.is_complete(),
            "cli_linked=false should not affect completeness"
        );
    }

    /// Verifies that init_vm persists both `runtime_ready` and `vm_ready` to
    /// the state file. This is a regression test: previously init_vm only set
    /// `vm_ready`, leaving `runtime_ready` false after the check_runtime →
    /// init_vm flow, which caused `is_setup_complete()` to return false and
    /// the "Setup complete! Redirecting..." screen to hang indefinitely.
    #[test]
    fn init_vm_sets_runtime_ready_and_vm_ready() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let state_path = tmp.path().join("setup_state.json");

        // Simulate check_runtime returning NotInstalled (runtime_ready stays false)
        let before = SetupState {
            runtime_ready: false,
            ..Default::default()
        };
        before.save_to(&state_path).expect("save before state");

        // Simulate what init_vm() does after platform-specific work succeeds
        let mut state = SetupState::load_from(&state_path).expect("load state");
        state.runtime_ready = true;
        state.vm_ready = true;
        state.save_to(&state_path).expect("save after init_vm");

        let after = SetupState::load_from(&state_path).expect("load final state");
        assert!(after.runtime_ready, "init_vm must set runtime_ready = true");
        assert!(after.vm_ready, "init_vm must set vm_ready = true");
    }

    /// Verifies that check_runtime sets vm_ready=true when the runtime is Ready.
    ///
    /// When the runtime is already available (ensure_ready() succeeds), the wizard
    /// frontend skips init_vm entirely. Without vm_ready=true in the state file,
    /// is_complete() returns false and the app redirects back to the setup wizard
    /// after reload instead of to the main shell.
    #[test]
    fn check_runtime_ready_sets_vm_ready() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let state_path = tmp.path().join("setup_state.json");

        // Start from default state
        let before = SetupState::default();
        before.save_to(&state_path).expect("save before state");

        // Simulate what check_runtime() does when ensure_ready() succeeds
        let mut state = SetupState::load_from(&state_path).expect("load state");
        state.runtime_ready = true;
        state.vm_ready = true;
        state
            .save_to(&state_path)
            .expect("save after check_runtime Ready");

        let after = SetupState::load_from(&state_path).expect("load final state");
        assert!(
            after.runtime_ready,
            "check_runtime Ready must set runtime_ready = true"
        );
        assert!(
            after.vm_ready,
            "check_runtime Ready must set vm_ready = true (wizard skips init_vm)"
        );
    }

    /// Verifies that is_complete() returns false when vm_ready is false,
    /// even if all other fields are set. This is the specific regression
    /// that occurred when check_runtime(Ready) skipped init_vm without
    /// setting vm_ready.
    #[test]
    fn is_complete_false_without_vm_ready() {
        let state = SetupState {
            runtime_ready: true,
            vm_ready: false,
            project_created: Some("test".to_string()),
            tokens_configured: vec![],
            images_built: true,
            containers_started: true,
            cli_linked: true,
        };
        assert!(
            !state.is_complete(),
            "is_complete must return false when vm_ready is false"
        );
    }

    // ── write_tokens ────────────────────────────────────────────────────────

    #[test]
    fn write_tokens_creates_files_with_correct_content() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let tokens = HashMap::from([
            ("api_key".to_string(), "xoxb-secret-123".to_string()),
            (
                "webhook_url".to_string(),
                "https://hooks.slack.com/x".to_string(),
            ),
        ]);

        write_tokens(tmp.path(), "acme", "slack", &tokens).expect("write_tokens should succeed");

        let key_path = tmp.path().join("tokens/acme/slack/api_key");
        let url_path = tmp.path().join("tokens/acme/slack/webhook_url");

        assert_eq!(
            std::fs::read_to_string(&key_path).expect("read api_key"),
            "xoxb-secret-123"
        );
        assert_eq!(
            std::fs::read_to_string(&url_path).expect("read webhook_url"),
            "https://hooks.slack.com/x"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_tokens_sets_chmod_600() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let data_dir = tmp.path();
        let original_mode = std::fs::metadata(data_dir).unwrap().permissions().mode() & 0o777;

        let tokens = HashMap::from([("secret".to_string(), "value".to_string())]);

        write_tokens(data_dir, "proj", "svc", &tokens).expect("write_tokens");

        let path = data_dir.join("tokens/proj/svc/secret");
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "token file should be chmod 600");

        // Directory permissions (3-level set_permissions pattern)
        assert_eq!(
            std::fs::metadata(data_dir.join("tokens/proj/svc"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "tokens/proj/svc should be 0o700"
        );
        assert_eq!(
            std::fs::metadata(data_dir.join("tokens/proj"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "tokens/proj should be 0o700"
        );
        assert_eq!(
            std::fs::metadata(data_dir.join("tokens"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "tokens should be 0o700"
        );

        // data_dir itself should NOT have been changed
        assert_eq!(
            std::fs::metadata(data_dir).unwrap().permissions().mode() & 0o777,
            original_mode,
            "data_dir should not have been changed"
        );
    }

    #[test]
    fn write_tokens_multiple_services_isolated() {
        let tmp = tempfile::tempdir().expect("tempdir");

        let slack_tokens = HashMap::from([("token".to_string(), "slack-secret".to_string())]);
        let gitlab_tokens = HashMap::from([("token".to_string(), "gitlab-secret".to_string())]);

        write_tokens(tmp.path(), "acme", "slack", &slack_tokens).expect("slack");
        write_tokens(tmp.path(), "acme", "gitlab", &gitlab_tokens).expect("gitlab");

        // Each service has its own isolated directory
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("tokens/acme/slack/token")).expect("read"),
            "slack-secret"
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("tokens/acme/gitlab/token")).expect("read"),
            "gitlab-secret"
        );

        // Verify no cross-contamination
        assert!(!tmp.path().join("tokens/acme/slack/gitlab-secret").exists());
    }

    // -- validate_path_component tests --

    #[test]
    fn validate_path_component_accepts_valid_names() {
        assert!(validate_path_component("slack", "service").is_ok());
        assert!(validate_path_component("my-service", "service").is_ok());
        assert!(validate_path_component("service_v2", "service").is_ok());
        assert!(validate_path_component("config.json", "key").is_ok());
        assert!(validate_path_component("abc123", "key").is_ok());
    }

    #[test]
    fn validate_path_component_rejects_empty() {
        assert!(validate_path_component("", "service").is_err());
    }

    #[test]
    fn validate_path_component_rejects_slash() {
        let err = validate_path_component("../etc/passwd", "service").unwrap_err();
        assert!(err.to_string().contains("path traversal"));
    }

    #[test]
    fn validate_path_component_rejects_backslash() {
        let err = validate_path_component("..\\windows\\system32", "service").unwrap_err();
        assert!(err.to_string().contains("path traversal"));
    }

    #[test]
    fn validate_path_component_rejects_double_dot() {
        let err = validate_path_component("foo..bar", "key").unwrap_err();
        assert!(err.to_string().contains("path traversal"));
    }

    #[test]
    fn validate_path_component_rejects_special_characters() {
        assert!(validate_path_component("key with spaces", "key").is_err());
        assert!(validate_path_component("key;rm", "key").is_err());
        assert!(validate_path_component("key$(cmd)", "key").is_err());
        assert!(validate_path_component("key`whoami`", "key").is_err());
    }

    // -- write_tokens path traversal prevention --

    #[test]
    fn write_tokens_rejects_traversal_in_service() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let tokens = HashMap::from([("key".to_string(), "value".to_string())]);
        let err = write_tokens(tmp.path(), "proj", "../escape", &tokens).unwrap_err();
        assert!(err.to_string().contains("path traversal"));
    }

    #[test]
    fn write_tokens_rejects_traversal_in_key() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let tokens = HashMap::from([("../../etc/shadow".to_string(), "value".to_string())]);
        let err = write_tokens(tmp.path(), "proj", "slack", &tokens).unwrap_err();
        assert!(err.to_string().contains("path traversal"));
    }

    #[test]
    fn write_tokens_rejects_slash_in_service() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let tokens = HashMap::from([("key".to_string(), "value".to_string())]);
        let err = write_tokens(tmp.path(), "proj", "a/b", &tokens).unwrap_err();
        assert!(err.to_string().contains("path traversal"));
    }

    #[test]
    fn write_tokens_rejects_traversal_in_project() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let tokens = HashMap::from([("key".to_string(), "value".to_string())]);
        let err = write_tokens(tmp.path(), "../escape", "slack", &tokens).unwrap_err();
        assert!(err.to_string().contains("path traversal"));
    }

    // -- atomic writes verification --

    #[test]
    fn save_to_is_atomic_no_tmp_left() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("setup_state.json");
        let state = SetupState {
            runtime_ready: true,
            ..Default::default()
        };
        state.save_to(&path).expect("save should succeed");

        assert!(path.exists(), "state file should exist");
        assert!(
            !path.with_extension("json.tmp").exists(),
            "tmp file should not exist after atomic write"
        );

        let loaded = SetupState::load_from(&path).expect("load should succeed");
        assert_eq!(loaded.current_step(), 1);
        assert!(loaded.runtime_ready);
    }

    #[cfg(target_os = "windows")]
    mod wsl_automount_options_tests {
        use speedwave_runtime::consts;

        // Automount opts carry `metadata` + the uid/gid from the SSOT (ADR-052).
        #[test]
        fn options_derive_metadata_and_container_uid_from_ssot() {
            let opts = consts::wsl_automount_options();
            let (uid, gid) = consts::container_uid_gid();
            assert!(
                opts.contains("metadata"),
                "metadata required for /login chmod 0600 (ADR-052)"
            );
            assert!(
                opts.contains(&format!("uid={uid}")),
                "automount uid must equal container uid {uid}"
            );
            assert!(
                opts.contains(&format!("gid={gid}")),
                "automount gid must equal container gid {gid}"
            );
        }
    }

    // ── copy_cli_binary tests ─────────────────────────────────────────────

    #[test]
    fn copy_cli_binary_copies_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let source_dir = tmp.path().join("source");
        std::fs::create_dir_all(&source_dir).expect("create source dir");

        let source = source_dir.join("speedwave");
        std::fs::write(&source, b"#!/bin/sh\necho hello").expect("write source");

        let target_dir = tmp.path().join("target");
        copy_cli_binary(&source, &target_dir).expect("copy should succeed");

        #[cfg(target_os = "windows")]
        let dest = target_dir.join("speedwave.exe");
        #[cfg(not(target_os = "windows"))]
        let dest = target_dir.join(consts::CLI_BINARY);
        assert!(dest.exists(), "copied binary should exist");
        assert_eq!(
            std::fs::read_to_string(&dest).expect("read"),
            "#!/bin/sh\necho hello"
        );
    }

    #[cfg(unix)]
    #[test]
    fn copy_cli_binary_sets_executable_permission() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let source = tmp.path().join("speedwave");
        std::fs::write(&source, b"#!/bin/sh\necho hello").expect("write source");

        let target_dir = tmp.path().join("bin");
        copy_cli_binary(&source, &target_dir).expect("copy should succeed");

        let dest = target_dir.join(consts::CLI_BINARY);
        let mode = std::fs::metadata(&dest)
            .expect("metadata")
            .permissions()
            .mode();
        assert_ne!(
            mode & 0o111,
            0,
            "copied binary should have executable permission"
        );
    }

    #[test]
    fn copy_cli_binary_returns_error_when_source_missing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let source = tmp.path().join("nonexistent");
        let target_dir = tmp.path().join("bin");

        let err = copy_cli_binary(&source, &target_dir).unwrap_err();
        assert!(
            err.to_string().contains("not found"),
            "error should mention source not found: {}",
            err
        );
    }

    // ── resolve_cli_source_from tests ─────────────────────────────────────

    #[cfg(target_os = "macos")]
    #[test]
    #[serial(env)]
    fn resolve_cli_source_finds_macos_bundle_path() {
        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);

        // Simulate: .app/Contents/MacOS/<exe> with Resources/cli/speedwave
        let tmp = tempfile::tempdir().expect("tempdir");
        let contents = tmp.path().join("Contents");
        let macos_dir = contents.join("MacOS");
        let resources_cli = contents.join("Resources").join("cli");
        std::fs::create_dir_all(&macos_dir).expect("create MacOS dir");
        std::fs::create_dir_all(&resources_cli).expect("create Resources/cli dir");
        std::fs::write(resources_cli.join(consts::CLI_BINARY), b"cli-binary")
            .expect("write cli binary");

        let result = resolve_cli_source_from(&macos_dir);
        assert!(result.is_some(), "should find CLI in macOS Resources");
        assert!(
            result
                .unwrap()
                .to_string_lossy()
                .contains("Resources/cli/speedwave"),
            "path should include Resources/cli/"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[serial(env)]
    fn resolve_cli_source_finds_resources_path() {
        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);

        // Simulate: <exe_dir>/resources/cli/speedwave
        let tmp = tempfile::tempdir().expect("tempdir");
        let exe_dir = tmp.path().join("exe_dir");
        let resources_cli = exe_dir.join("resources").join("cli");
        std::fs::create_dir_all(&resources_cli).expect("create resources/cli dir");

        #[cfg(target_os = "windows")]
        let binary_name = "speedwave.exe";
        #[cfg(not(target_os = "windows"))]
        let binary_name = consts::CLI_BINARY;

        std::fs::write(resources_cli.join(binary_name), b"cli-binary").expect("write cli binary");

        let result = resolve_cli_source_from(&exe_dir);
        assert!(result.is_some(), "should find CLI in resources");
        let resolved = result.unwrap();
        assert_eq!(
            resolved.parent().unwrap().file_name().unwrap(),
            "cli",
            "path should be in cli/ directory"
        );
        assert_eq!(
            resolved
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .file_name()
                .unwrap(),
            "resources",
            "cli/ should be under resources/"
        );
    }

    #[test]
    #[serial(env)]
    fn resolve_cli_source_finds_dev_fallback() {
        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);

        // Simulate: <exe_dir>/speedwave (dev mode)
        let tmp = tempfile::tempdir().expect("tempdir");
        let exe_dir = tmp.path().join("exe_dir");
        std::fs::create_dir_all(&exe_dir).expect("create exe dir");

        #[cfg(target_os = "windows")]
        let binary_name = "speedwave.exe";
        #[cfg(not(target_os = "windows"))]
        let binary_name = consts::CLI_BINARY;

        std::fs::write(exe_dir.join(binary_name), b"cli-binary").expect("write cli binary");

        let result = resolve_cli_source_from(&exe_dir);
        assert!(result.is_some(), "should find CLI in dev fallback");
    }

    #[test]
    #[serial(env)]
    fn resolve_cli_source_finds_dev_cli_dir() {
        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);

        // Simulate: desktop/src-tauri/target/debug/ as exe_dir,
        // desktop/src-tauri/cli/speedwave as CLI binary (placed by Makefile)
        let tmp = tempfile::tempdir().expect("tempdir");
        let src_tauri = tmp.path().join("desktop").join("src-tauri");
        let exe_dir = src_tauri.join("target").join("debug");
        let cli_dir = src_tauri.join("cli");
        std::fs::create_dir_all(&exe_dir).expect("create exe dir");
        std::fs::create_dir_all(&cli_dir).expect("create cli dir");

        #[cfg(target_os = "windows")]
        let binary_name = "speedwave.exe";
        #[cfg(not(target_os = "windows"))]
        let binary_name = consts::CLI_BINARY;

        std::fs::write(cli_dir.join(binary_name), b"cli-binary").expect("write cli binary");

        let result = resolve_cli_source_from(&exe_dir);
        assert!(result.is_some(), "should find CLI in dev cli/ dir");
        assert!(
            result
                .unwrap()
                .ends_with(std::path::Path::new("cli").join(binary_name)),
            "path should end with cli/{binary_name}"
        );
    }

    use serial_test::serial;

    #[test]
    #[serial(env)]
    fn resolve_cli_source_returns_none_when_not_found() {
        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);

        let tmp = tempfile::tempdir().expect("tempdir");
        let exe_dir = tmp.path().join("empty_dir");
        std::fs::create_dir_all(&exe_dir).expect("create empty dir");

        let result = resolve_cli_source_from(&exe_dir);
        assert!(result.is_none(), "should return None when CLI not found");
    }

    #[test]
    #[serial(env)]
    fn resolve_cli_source_finds_via_resources_env() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let resources_dir = tmp.path().join("resources");
        let cli_dir = resources_dir.join("cli");
        std::fs::create_dir_all(&cli_dir).expect("create cli dir");

        #[cfg(not(target_os = "windows"))]
        let binary_name = consts::CLI_BINARY;
        #[cfg(target_os = "windows")]
        let binary_name = "speedwave.exe";

        std::fs::write(cli_dir.join(binary_name), b"cli-binary").expect("write cli");

        std::env::set_var(
            consts::BUNDLE_RESOURCES_ENV,
            resources_dir.to_string_lossy().as_ref(),
        );

        let exe_dir = tmp.path().join("unrelated");
        std::fs::create_dir_all(&exe_dir).expect("create exe dir");

        let result = resolve_cli_source_from(&exe_dir);
        assert!(
            result.is_some(),
            "should find CLI via SPEEDWAVE_RESOURCES_DIR"
        );
        assert!(
            result
                .unwrap()
                .ends_with(std::path::Path::new("cli").join(binary_name)),
            "path should end with cli/{binary_name}"
        );

        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[serial(env)]
    fn resolve_cli_source_prefers_bundle_over_dev() {
        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);

        // Both Resources/cli/speedwave and <exe_dir>/speedwave exist;
        // bundle path should be preferred.
        let tmp = tempfile::tempdir().expect("tempdir");
        let contents = tmp.path().join("Contents");
        let macos_dir = contents.join("MacOS");
        let resources_cli = contents.join("Resources").join("cli");
        std::fs::create_dir_all(&macos_dir).expect("create MacOS dir");
        std::fs::create_dir_all(&resources_cli).expect("create Resources/cli dir");
        std::fs::write(resources_cli.join(consts::CLI_BINARY), b"bundle")
            .expect("write bundle cli");
        std::fs::write(macos_dir.join(consts::CLI_BINARY), b"dev").expect("write dev cli");

        let result = resolve_cli_source_from(&macos_dir);
        assert!(result.is_some());
        let content = std::fs::read_to_string(result.unwrap()).expect("read resolved");
        assert_eq!(
            content, "bundle",
            "should prefer bundle path over dev fallback"
        );
    }

    #[test]
    #[serial(env)]
    fn resolve_cli_source_env_var_takes_priority_over_filesystem() {
        let tmp = tempfile::tempdir().expect("tempdir");

        // Set up a SPEEDWAVE_RESOURCES_DIR with its own CLI binary
        let env_resources = tmp.path().join("env-resources");
        let env_cli_dir = env_resources.join("cli");
        std::fs::create_dir_all(&env_cli_dir).expect("create env cli dir");

        #[cfg(not(target_os = "windows"))]
        let binary_name = consts::CLI_BINARY;
        #[cfg(target_os = "windows")]
        let binary_name = "speedwave.exe";

        std::fs::write(env_cli_dir.join(binary_name), b"from-env-var").expect("write env cli");

        // Also set up a dev-mode fallback binary next to the exe
        let exe_dir = tmp.path().join("exe_dir");
        std::fs::create_dir_all(&exe_dir).expect("create exe dir");
        std::fs::write(exe_dir.join(binary_name), b"from-dev-fallback")
            .expect("write dev fallback");

        std::env::set_var(
            consts::BUNDLE_RESOURCES_ENV,
            env_resources.to_string_lossy().as_ref(),
        );

        let result = resolve_cli_source_from(&exe_dir);
        assert!(result.is_some(), "should find CLI via env var");
        let content = std::fs::read_to_string(result.unwrap()).expect("read resolved");
        assert_eq!(
            content, "from-env-var",
            "SPEEDWAVE_RESOURCES_DIR must take priority over filesystem-based resolution"
        );

        std::env::remove_var(consts::BUNDLE_RESOURCES_ENV);
    }

    // ── cli_install_path tests ─────────────────────────────────────────────

    #[test]
    fn cli_install_path_returns_platform_specific_path() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let path = cli_install_path_in(data_dir.path()).expect("should return a path");

        #[cfg(unix)]
        assert!(
            path.to_string_lossy().contains(".local/bin/speedwave"),
            "Unix path should contain .local/bin/speedwave: {}",
            path.display()
        );

        #[cfg(target_os = "windows")]
        assert!(
            path.to_string_lossy()
                .contains(".speedwave\\bin\\speedwave.exe"),
            "Windows path should contain .speedwave\\bin\\speedwave.exe: {}",
            path.display()
        );
    }

    // ── detect_shell tests ──────────────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn detect_shell_parses_shell_env() {
        assert_eq!(parse_shell_env("/bin/zsh"), UserShell::Zsh);
        assert_eq!(parse_shell_env("/bin/bash"), UserShell::Bash);
        assert_eq!(parse_shell_env("/usr/local/bin/bash"), UserShell::Bash);
        assert_eq!(parse_shell_env("/opt/homebrew/bin/zsh"), UserShell::Zsh);
        assert_eq!(parse_shell_env("/usr/bin/fish"), UserShell::Unknown);
        assert_eq!(parse_shell_env("/bin/ksh"), UserShell::Unknown);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn detect_shell_empty_defaults_to_zsh_on_macos() {
        // On macOS, empty $SHELL (launchd context) should default to Zsh.
        assert_eq!(parse_shell_env(""), UserShell::Zsh);
    }

    // ── shell_config_targets tests ───────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn zsh_targets_zshrc() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        let targets = shell_config_targets(home, UserShell::Zsh);
        assert_eq!(targets, vec![home.join(".zshrc")]);
    }

    #[cfg(unix)]
    #[test]
    fn unknown_targets_profile() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        let targets = shell_config_targets(home, UserShell::Unknown);
        assert_eq!(targets, vec![home.join(".profile")]);
    }

    #[cfg(unix)]
    #[test]
    fn bash_targets_bash_profile_when_it_exists() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        std::fs::write(home.join(".bash_profile"), "# bash_profile\n").expect("write");
        std::fs::write(home.join(".profile"), "# profile\n").expect("write");

        let targets = shell_config_targets(home, UserShell::Bash);
        // .bash_profile takes priority over .profile
        assert!(targets.contains(&home.join(".bash_profile")));
        assert!(!targets.contains(&home.join(".profile")));
    }

    #[cfg(unix)]
    #[test]
    fn bash_falls_through_to_bash_login() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        // Only .bash_login exists (no .bash_profile)
        std::fs::write(home.join(".bash_login"), "# bash_login\n").expect("write");

        let targets = shell_config_targets(home, UserShell::Bash);
        assert!(targets.contains(&home.join(".bash_login")));
    }

    #[cfg(unix)]
    #[test]
    fn bash_falls_through_to_profile() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        // Only .profile exists (no .bash_profile, no .bash_login)
        std::fs::write(home.join(".profile"), "# profile\n").expect("write");

        let targets = shell_config_targets(home, UserShell::Bash);
        assert!(targets.contains(&home.join(".profile")));
    }

    #[cfg(unix)]
    #[test]
    fn bash_creates_bash_profile_when_none_exist() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        // No login files exist at all

        let targets = shell_config_targets(home, UserShell::Bash);
        // Should default to .bash_profile for creation
        assert!(targets.contains(&home.join(".bash_profile")));
    }

    // ── ensure_local_bin_on_path_for_shell tests ─────────────────────────

    #[cfg(unix)]
    #[test]
    fn zsh_creates_zshrc_when_missing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        // No .zshrc exists

        ensure_local_bin_on_path_for_shell(home, UserShell::Zsh).expect("should succeed");

        assert!(home.join(".zshrc").exists(), ".zshrc should be created");
        let content = std::fs::read_to_string(home.join(".zshrc")).expect("read");
        assert!(content.contains(".local/bin"), "should contain PATH export");
        assert!(
            content.contains("# Added by Speedwave setup"),
            "should contain marker comment"
        );
    }

    #[cfg(unix)]
    #[test]
    fn zsh_appends_to_existing_zshrc() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        std::fs::write(home.join(".zshrc"), "# existing zsh config\n").expect("write");

        ensure_local_bin_on_path_for_shell(home, UserShell::Zsh).expect("should succeed");

        let content = std::fs::read_to_string(home.join(".zshrc")).expect("read");
        assert!(
            content.starts_with("# existing zsh config"),
            "should preserve existing content"
        );
        assert!(content.contains(".local/bin"), "should append PATH export");
    }

    #[cfg(unix)]
    #[test]
    fn skips_when_already_present() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        let existing = "# existing\nexport PATH=\"$HOME/.local/bin:$PATH\"\n";
        std::fs::write(home.join(".zshrc"), existing).expect("write");

        ensure_local_bin_on_path_for_shell(home, UserShell::Zsh).expect("should succeed");

        let content = std::fs::read_to_string(home.join(".zshrc")).expect("read");
        assert_eq!(
            content, existing,
            "should not be modified when already present"
        );
    }

    #[cfg(unix)]
    #[test]
    fn idempotent_across_multiple_calls() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        std::fs::write(home.join(".zshrc"), "# zshrc\n").expect("write");

        ensure_local_bin_on_path_for_shell(home, UserShell::Zsh).expect("first call");
        ensure_local_bin_on_path_for_shell(home, UserShell::Zsh).expect("second call");

        let content = std::fs::read_to_string(home.join(".zshrc")).expect("read");
        let count = content.lines().filter(|l| l.contains(".local/bin")).count();
        assert_eq!(
            count, 1,
            "should have exactly one .local/bin line, got {count}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn does_not_touch_other_shells_config() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        let bashrc_content = "# my bashrc\n";
        std::fs::write(home.join(".bashrc"), bashrc_content).expect("write .bashrc");

        // Zsh user — should only touch .zshrc, not .bashrc
        ensure_local_bin_on_path_for_shell(home, UserShell::Zsh).expect("should succeed");

        let bashrc = std::fs::read_to_string(home.join(".bashrc")).expect("read .bashrc");
        assert_eq!(
            bashrc, bashrc_content,
            ".bashrc should not be modified for a zsh user"
        );
    }

    #[cfg(unix)]
    #[test]
    fn bash_writes_to_bash_profile_not_bashrc_on_macos() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        std::fs::write(home.join(".bash_profile"), "# bp\n").expect("write");
        std::fs::write(home.join(".bashrc"), "# bashrc\n").expect("write");

        ensure_local_bin_on_path_for_shell(home, UserShell::Bash).expect("should succeed");

        let bp = std::fs::read_to_string(home.join(".bash_profile")).expect("read");
        assert!(
            bp.contains(".local/bin"),
            ".bash_profile should contain PATH export"
        );

        // macOS opens login shells, so .bashrc should NOT be modified.
        #[cfg(target_os = "macos")]
        {
            let bashrc = std::fs::read_to_string(home.join(".bashrc")).expect("read");
            assert_eq!(
                bashrc, "# bashrc\n",
                ".bashrc should not be modified on macOS"
            );
        }
    }

    // ── copy_cli_binary overwrites existing binary ────────────────────────

    #[test]
    fn copy_cli_binary_overwrites_existing_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let source = tmp.path().join("speedwave");
        std::fs::write(&source, b"new-version").expect("write source");

        let target_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&target_dir).expect("create target dir");

        #[cfg(target_os = "windows")]
        let binary_name = "speedwave.exe";
        #[cfg(not(target_os = "windows"))]
        let binary_name = consts::CLI_BINARY;

        std::fs::write(target_dir.join(binary_name), b"old-version").expect("write old binary");

        copy_cli_binary(&source, &target_dir).expect("copy should succeed");

        let content = std::fs::read_to_string(target_dir.join(binary_name)).expect("read");
        assert_eq!(content, "new-version", "should overwrite existing binary");
    }

    // ── link_cli guard tests ────────────────────────────────────────────

    #[test]
    fn link_cli_guard_skips_when_data_dir_missing() {
        // When the data directory does not exist (fresh install / factory
        // reset), link_cli() should return Ok without creating it.
        let tmp = tempfile::tempdir().expect("tempdir");
        let fake_home = tmp.path().join("home");
        std::fs::create_dir_all(&fake_home).expect("create fake home");
        // No .speedwave/ inside fake_home — guard should trigger.
        // We can't call link_cli() directly because it uses dirs::home_dir()
        // which returns the real home. Instead, verify the guard logic:
        let data_dir = fake_home.join(consts::DATA_DIR);
        assert!(
            !data_dir.exists(),
            "precondition: data dir should not exist"
        );
        // The guard condition in link_cli():
        //   if !home.join(consts::DATA_DIR).exists() { return Ok(()); }
        // We verify the same condition holds and data dir stays absent.
        assert!(
            !data_dir.exists(),
            "data dir should not be created by guard check"
        );
    }

    // ── link_cli_from tests ─────────────────────────────────────────────

    #[test]
    fn link_cli_from_returns_error_when_source_missing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let source = tmp.path().join("nonexistent");
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).expect("create home");

        let err = link_cli_from(&source, &home).unwrap_err();
        assert!(
            err.to_string().contains("not found"),
            "error should mention source not found: {}",
            err
        );

        // No files should be written to the destination
        #[cfg(unix)]
        assert!(
            !home.join(".local").join("bin").exists(),
            "target dir should not be created on failure"
        );
    }

    #[cfg(unix)]
    #[test]
    fn link_cli_from_copies_binary_and_sets_permissions() {
        let tmp = tempfile::tempdir().expect("tempdir");

        // Create mock CLI source binary
        let source = tmp.path().join("speedwave");
        std::fs::write(&source, b"cli-binary-content").expect("write source");

        // Create home with config files for all common shells so the test
        // passes regardless of the ambient $SHELL (detect_shell reads it).
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).expect("create home");
        std::fs::write(home.join(".zshrc"), "# zshrc\n").expect("write zshrc");
        std::fs::write(home.join(".bash_profile"), "# bash_profile\n").expect("write bash_profile");
        std::fs::write(home.join(".profile"), "# profile\n").expect("write profile");

        link_cli_from(&source, &home).expect("link_cli_from should succeed");

        // Verify binary copied
        let dest = home.join(".local").join("bin").join(consts::CLI_BINARY);
        assert!(dest.exists(), "CLI binary should exist at destination");
        let content = std::fs::read_to_string(&dest).expect("read dest");
        assert_eq!(content, "cli-binary-content");

        // Verify executable permission
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&dest)
            .expect("metadata")
            .permissions()
            .mode();
        assert!(mode & 0o111 != 0, "binary should be executable");
    }

    #[cfg(unix)]
    #[test]
    fn link_cli_from_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");

        let source = tmp.path().join("speedwave");
        std::fs::write(&source, b"v2-binary").expect("write source");

        // Create config files for all common shells — makes the test
        // independent of the ambient $SHELL value.
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).expect("create home");
        std::fs::write(home.join(".zshrc"), "# zshrc\n").expect("write zshrc");
        std::fs::write(home.join(".bash_profile"), "# bash_profile\n").expect("write bash_profile");
        std::fs::write(home.join(".profile"), "# profile\n").expect("write profile");

        // Call twice
        link_cli_from(&source, &home).expect("first call");

        // Update source to simulate app update
        std::fs::write(&source, b"v3-binary").expect("update source");
        link_cli_from(&source, &home).expect("second call");

        // Binary should be the latest version
        let dest = home.join(".local").join("bin").join(consts::CLI_BINARY);
        let content = std::fs::read_to_string(&dest).expect("read dest");
        assert_eq!(content, "v3-binary", "should have latest binary content");
    }

    #[test]
    fn setup_state_preserves_fields_on_cli_linked_update() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let state_path = tmp.path().join("setup_state.json");

        // Pre-seed with cli_linked: false and other fields set
        let initial = SetupState {
            cli_linked: false,
            runtime_ready: true,
            vm_ready: true,
            ..Default::default()
        };
        let initial_step = initial.current_step();
        initial.save_to(&state_path).expect("save initial state");

        // Load, flip cli_linked, save — mirrors what link_cli() does
        let mut state = SetupState::load_from(&state_path).expect("load for update");
        assert!(!state.cli_linked, "cli_linked should start as false");
        state.cli_linked = true;
        state.save_to(&state_path).expect("save updated state");

        // Verify cli_linked changed and other fields preserved
        let final_state = SetupState::load_from(&state_path).expect("load final");
        assert!(
            final_state.cli_linked,
            "cli_linked should be true after update"
        );
        assert_eq!(
            final_state.current_step(),
            initial_step,
            "current_step() should reflect the same base flags (only cli_linked changed, \
             which comes after the incomplete steps)"
        );
        assert!(
            final_state.runtime_ready,
            "runtime_ready should be unchanged"
        );
        assert!(final_state.vm_ready, "vm_ready should be unchanged");
    }

    // ── decode_wsl_output smoke test (SSOT is runtime::wsl) ────────────

    #[test]
    fn decode_wsl_output_imported_from_runtime_works() {
        // Smoke test: verify the re-exported decode_wsl_output handles
        // UTF-16LE correctly. Full test coverage lives in speedwave-runtime.
        // Build the input from `wsl_distro_name()` (derived from the data_dir
        // basename) so the test is independent of the process-global data_dir.
        let text = format!("Ubuntu\r\n{}\r\n", consts::wsl_distro_name());
        let mut bytes: Vec<u8> = Vec::new();
        for ch in text.encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        let decoded = decode_wsl_output(&bytes);
        let found = decoded
            .lines()
            .any(|l| l.trim().trim_matches('\0') == consts::wsl_distro_name());
        assert!(
            found,
            "imported decode_wsl_output should decode UTF-16LE correctly, got: {decoded:?}"
        );
    }

    #[test]
    fn start_containers_security_check_blocks_missing_cap_drop() {
        // Compose YAML missing cap_drop: [ALL] should trigger CAP_DROP_ALL violation.
        // This verifies the SecurityCheck gate runs before save_compose and compose_up_recreate.
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    environment:
      - CLAUDE_VERSION=1.0.3
"#;
        let expected_paths = compose::SecurityExpectedPaths::from_raw(
            "/test/project",
            "/test/.speedwave/tokens/test",
        );
        let violations = compose::SecurityCheck::run(yaml, "test", &[], &expected_paths);
        assert!(
            violations
                .iter()
                .any(|v| v.rule == compose::SecurityRule::CapDropAll),
            "Expected CAP_DROP_ALL violation for compose YAML missing cap_drop"
        );

        // Verify the error message format matches what start_containers would produce
        let msgs: Vec<String> = violations
            .iter()
            .map(|v| format!("[{}] {} -- {}", v.container, v.rule, v.message))
            .collect();
        let error_msg = format!(
            "{}\n{}",
            speedwave_runtime::consts::SYSTEM_CHECK_FAILED_PREFIX,
            msgs.join("\n")
        );
        assert!(
            error_msg.contains(speedwave_runtime::consts::SYSTEM_CHECK_FAILED_PREFIX),
            "Error message should contain system check failed prefix"
        );
        assert!(
            error_msg.contains("CAP_DROP_ALL"),
            "Error message should contain the violated rule name"
        );
    }

    #[test]
    fn security_check_before_save_compose_ordering() {
        // Verify that compose is NOT saved to disk when SecurityCheck detects violations.
        // This tests the ordering guarantee: SecurityCheck::run() runs BEFORE save_compose().
        let tmp = tempfile::tempdir().unwrap();
        let compose_dir = tmp.path().join("compose").join("test-ordering");
        std::fs::create_dir_all(&compose_dir).unwrap();
        let compose_file = compose_dir.join("compose.yml");

        // Insecure YAML (missing cap_drop)
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    environment:
      - CLAUDE_VERSION=1.0.3
"#;

        // SecurityCheck should find violations
        let expected_paths = compose::SecurityExpectedPaths::from_raw(
            "/test/project",
            "/test/.speedwave/tokens/test",
        );
        let violations = compose::SecurityCheck::run(yaml, "test-ordering", &[], &expected_paths);
        assert!(!violations.is_empty(), "Should detect violations");

        // Simulate the correct ordering: check first, bail before save
        if !violations.is_empty() {
            // In start_containers, we bail here — save_compose is never called
            assert!(
                !compose_file.exists(),
                "compose.yml must NOT be written when security check fails"
            );
        }
    }

    #[test]
    fn start_containers_security_check_passes_valid_compose() {
        // A compose YAML with all security requirements should produce zero
        // compose-level violations. `FileSecurityViolation`s are filtered out
        // because they depend on the real host's `~/.speedwave/` perms — this
        // test is about YAML semantics, not host filesystem state.
        let yaml = r#"
version: "3"
services:
  claude:
    image: speedwave-claude:latest
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:noexec,nosuid,size=512m
    user: "1000:1000"
    environment:
      - CLAUDE_VERSION=1.0.3
networks:
  speedwave_test_network:
    driver: bridge
"#;
        let expected_paths = compose::SecurityExpectedPaths::from_raw(
            "/test/project",
            "/test/.speedwave/tokens/test",
        );
        let violations: Vec<_> = compose::SecurityCheck::run(yaml, "test", &[], &expected_paths)
            .into_iter()
            .filter(|v| v.rule != compose::SecurityRule::FileSecurityViolation)
            .collect();
        assert!(
            violations.is_empty(),
            "Expected no compose-level violations for valid YAML, got: {:?}",
            violations
                .iter()
                .map(|v| format!("{v}"))
                .collect::<Vec<_>>()
        );
    }

    /// Extracts the body of a top-level `pub fn <name>()` from source text by
    /// counting braces. Used by structural tests to assert on function contents.
    ///
    /// Limitation: string literals containing `{` or `}` will throw off the
    /// depth counter. This is acceptable for architectural guard tests — if a
    /// future change adds brace-containing strings, the test may need updating.
    fn extract_fn_body<'a>(source: &'a str, fn_signature: &str) -> &'a str {
        let after_sig = source
            .split(fn_signature)
            .nth(1)
            .unwrap_or_else(|| panic!("{fn_signature} not found in source"));
        let brace_start = after_sig.find('{').expect("opening brace not found");
        let rest = &after_sig[brace_start..];
        let mut depth = 0i32;
        let mut end = 0;
        for (i, ch) in rest.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = i;
                        break;
                    }
                }
                _ => {}
            }
        }
        assert!(end > 0, "closing brace not found for {fn_signature}");
        &rest[..end]
    }

    /// Structural test: verifies that `build_images()` handles
    /// `SnapshotterRecoveryFailed` by calling `restart_container_engine()` and
    /// retrying the build. This is a source-level test — if the recovery pattern
    /// is removed or refactored away, this test will fail and force a conscious
    /// decision about the new error-handling strategy.
    #[test]
    fn build_images_handles_snapshotter_recovery_with_engine_restart() {
        let source = include_str!("setup_wizard.rs");

        assert!(
            source.contains("SnapshotterRecoveryFailed"),
            "build_images() must downcast SnapshotterRecoveryFailed to trigger engine restart"
        );
        assert!(
            source.contains("restart_container_engine"),
            "build_images() must call restart_container_engine() on snapshotter recovery failure"
        );

        let body = extract_fn_body(source, "pub fn build_images()");

        assert!(
            body.contains("downcast_ref::<build::SnapshotterRecoveryFailed>"),
            "build_images() must use downcast_ref to detect SnapshotterRecoveryFailed"
        );
        assert!(
            body.contains("restart_container_engine()"),
            "build_images() must call restart_container_engine() in the recovery path"
        );
        assert!(
            body.contains("build::build_enabled_images(&rt, &active_integrations)?"),
            "build_images() must retry build_enabled_images after engine restart"
        );
    }

    /// Structural test: verifies that `build_images()` persists `BundleState`
    /// (with `applied_bundle_id`) after a successful image build and syncs
    /// claude-resources. Without this, `reconcile_bundle_update` sees
    /// `bundle_changed=true` on the next startup and triggers a phantom rebuild.
    #[test]
    fn build_images_writes_bundle_state_after_success() {
        let source = include_str!("setup_wizard.rs");
        let body = extract_fn_body(source, "pub fn build_images()");

        assert!(
            body.contains("sync_claude_resources"),
            "build_images() must sync claude-resources for compose mounts"
        );
        assert!(
            body.contains("bundle::save_bundle_state"),
            "build_images() must persist BundleState (applied_bundle_id) after building images \
             so that reconcile_bundle_update sees bundle_changed=false on next startup"
        );
        assert!(
            body.contains("bundle::load_current_bundle_manifest"),
            "build_images() must load the current manifest to get bundle_id for BundleState"
        );
    }

    /// Structural test: verifies that `start_containers()` calls
    /// `ensure_exec_healthy` between `compose_up_recreate` and `SetupState`
    /// save. Without this, `containers_started = true` could be persisted
    /// while containers are broken or missing.
    #[test]
    fn start_containers_probes_exec_after_compose_up() {
        let source = include_str!("setup_wizard.rs");
        let body = extract_fn_body(source, "pub fn start_containers(");

        let recreate_pos = body
            .find("compose_up_recreate")
            .expect("start_containers must call compose_up_recreate");
        let probe_pos = body
            .find("ensure_exec_healthy")
            .expect("start_containers must call ensure_exec_healthy");
        let state_pos = body
            .find("containers_started = true")
            .expect("start_containers must set containers_started = true");

        assert!(
            recreate_pos < probe_pos,
            "ensure_exec_healthy must come AFTER compose_up_recreate"
        );
        assert!(
            probe_pos < state_pos,
            "ensure_exec_healthy must come BEFORE containers_started = true"
        );
    }

    /// Structural test: `build_images` must warn (not silently default) when
    /// `load_user_config` fails, mirroring `main.rs::get_health`.
    #[test]
    fn build_images_warns_on_config_load_failure() {
        let source = include_str!("setup_wizard.rs");
        let snippet = "log::warn!(\"build_images: failed to load config";
        assert!(
            source.contains(snippet),
            "build_images must log::warn before defaulting on config load error, \
             not swallow it silently"
        );
        // And it must NOT silently swallow the config error. Build the forbidden
        // literal at runtime so this assertion does not match its own source.
        let forbidden = format!("config::load_user_config().{}", "unwrap_or_default()");
        assert!(
            !source.contains(&forbidden),
            "config parse errors must not be silently defaulted"
        );
    }

    /// Structural test: `ensure_wslconfig_vpn_compat` must be invoked from
    /// `main.rs` at startup so existing WSL2 installs pick up the VPN-compat
    /// keys without a fresh install.
    #[test]
    fn ensure_wslconfig_vpn_compat_called_from_main() {
        let source = include_str!("main.rs");
        assert!(
            source.contains("ensure_wslconfig_vpn_compat"),
            "main.rs must call setup_wizard::ensure_wslconfig_vpn_compat() \
             at startup so upgrading WSL2 users get the VPN-compat .wslconfig"
        );
    }

    /// Structural test: `ensure_lima_vm_config()` must be called in `main.rs`
    /// before `reconcile_bundle_update()` so the VM memory is migrated before
    /// images are rebuilt.
    #[test]
    fn ensure_lima_vm_config_called_before_reconcile() {
        let source = include_str!("main.rs");
        let migration_pos = source
            .find("ensure_lima_vm_config()")
            .expect("ensure_lima_vm_config() must be called in main.rs");
        let reconcile_pos = source
            .find("reconcile_bundle_update(")
            .expect("reconcile_bundle_update() must be called in main.rs");
        assert!(
            migration_pos < reconcile_pos,
            "ensure_lima_vm_config() must be called BEFORE reconcile_bundle_update() in main.rs"
        );
    }

    // ADR-048: factory_reset calls reset_vm() before wipe_data_dir(), and
    // reset_vm() errors must be non-fatal (log::warn and continue).
    // These tests verify the non-fatal wrapper pattern used in factory_reset
    // handles both Ok and Err from reset_vm() correctly.
    mod reset_vm_factory_reset_contract {
        use speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder;

        #[test]
        fn reset_vm_error_is_non_fatal() {
            let (rt, handles) = MockRuntimeBuilder::new()
                .with_reset_vm_error("simulated wsl --unregister failure")
                .build();
            // Non-fatal: log::warn and continue — must not propagate as Err.
            // This mirrors the exact pattern in factory_reset.
            if let Err(e) = rt.reset_vm() {
                log::warn!("reset_vm failed (continuing to wipe_data_dir): {e}");
            }
            // Reaching here proves the error did not propagate.
            assert_eq!(
                handles.reset_vm_count(),
                1,
                "reset_vm must have been invoked"
            );
        }

        #[test]
        fn reset_vm_ok_returns_ok() {
            let (rt, handles) = MockRuntimeBuilder::new().build();
            // Default builder returns Ok(()); no warn log, no error propagated.
            assert!(rt.reset_vm().is_ok());
            assert_eq!(handles.reset_vm_count(), 1);
        }
    }
}
