//! Crate-wide constants: data-dir names, service registry, reserved env keys.

use crate::resources::{ContainerResources, STANDARD_WORKER_RESOURCES};

/// Env var overriding the data-dir location.
pub const DATA_DIR_ENV: &str = "SPEEDWAVE_DATA_DIR";
/// Subdirectory under the data dir holding the Lima VM state.
pub const LIMA_SUBDIR: &str = "lima";
/// Default data-dir basename under the user's home.
pub const DATA_DIR: &str = ".speedwave";
/// Per-project Claude Code home (`<data_dir>/claude-home/<project>/`) — SSOT;
/// don't hard-code the `"claude-home"` literal at call sites.
pub const CLAUDE_HOME_SUBDIR: &str = "claude-home";
/// Per-project native Claude Code managed-settings dir
/// (`<data_dir>/claude-managed/<project>/`) — SSOT; don't hard-code the literal.
pub const CLAUDE_MANAGED_SUBDIR: &str = "claude-managed";
/// Native Claude Code managed-settings filename — SSOT for both the host file
/// and the container mount-target basename (`/etc/claude-code/<this>`).
pub const MANAGED_SETTINGS_FILE: &str = "managed-settings.json";
/// Vendor dir name under the OS system-config root holding the MDM-deployed
/// `managed-config.json` — SSOT; don't hard-code "Speedwave" at call sites.
pub const MANAGED_CONFIG_VENDOR_DIR: &str = "Speedwave";
/// MDM managed-config filename — SSOT.
pub const MANAGED_CONFIG_FILE: &str = "managed-config.json";
/// CLI binary name.
pub const CLI_BINARY: &str = "speedwave";
/// Prefix for per-project compose project names and networks.
pub const COMPOSE_PREFIX: &str = "speedwave";
/// Port on which `mcp-hub` listens inside the compose network. Single external
/// contract: `claude` reaches the hub at `http://mcp-hub:4000`. See ADR-038.
pub const PORT_BASE: u16 = 4000;

/// Port every MCP worker (built-in + plugin) listens on inside its own
/// container; per-container namespaces make reuse safe, DNS disambiguates. ADR-038.
pub const PORT_WORKER: u16 = 3000;
/// mcp-os bind-mount token file (hub mounts `/secrets/os-auth-token:ro`).
/// Dual-written by `mcp_os_process::spawn` so the container sees a token-only file.
pub const MCP_OS_AUTH_TOKEN_FILE: &str = "mcp-os-auth-token";
/// Legacy `mcp-os` port file. **Migration-only** — pre-lock.json builds (≤ 0.10)
/// wrote this; `mcp_os_process::spawn` folds it into the lock then removes it.
pub const MCP_OS_LEGACY_PORT_FILE: &str = "mcp-os-port";
/// Legacy `mcp-os` PID file. **Migration-only** — see
/// [`MCP_OS_LEGACY_PORT_FILE`].
pub const MCP_OS_LEGACY_PID_FILE: &str = "mcp-os-pid";
/// Single-file lock for the mcp-os singleton in `data_dir` — carries `{service,
/// pid, port, authToken, transport}`; SSOT for compose port injection + watchdog.
pub const MCP_OS_LOCK_FILE: &str = "mcp-os.lock.json";
/// Log filename for the mcp-os host process.
pub const MCP_OS_LOG_FILE: &str = "mcp-os.log";

/// Per-project unified lock file in each per-project state dir; SSOT for compose
/// port injection + watchdog (supersedes the split `port`/`pid`/`auth-token` files).
pub const PER_PROJECT_LOCK_FILE: &str = "lock.json";

/// TCP connection probe timeout used by host-process liveness checks
/// (oauth_process). SSOT — see ADR-060.
pub const PORT_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);
/// TCP probe attempts where respawn is expensive (oauth: every respawn rotates
/// the port + recreates consumers). Single-shot probes elsewhere are unaffected.
pub const PORT_PROBE_ATTEMPTS: u8 = 3;
/// Backoff between TCP probe attempts.
pub const PORT_PROBE_BACKOFF: std::time::Duration = std::time::Duration::from_millis(200);

/// Subdirectory under the data dir holding per-project `oauth` worker state.
/// SSOT — do not hard-code `"oauth"` at call sites. See ADR-060.
pub const OAUTH_SUBDIR: &str = "oauth";
/// Per-project bearer-token → service map (`0o600`). Lets the oauth worker derive
/// `service` from the bearer instead of a model-controlled param.
pub const OAUTH_BEARER_MAP_FILE: &str = ".bearer-map.json";
/// Per-project audit log; refresh / forget events are appended here (no token contents).
pub const OAUTH_LOG_FILE: &str = "audit.log";
/// Mode for the per-project oauth state directory (owner-only).
pub const OAUTH_PROJECT_DIR_MODE: u32 = 0o700;

/// Log filename for the Claude session output.
pub const CLAUDE_SESSION_LOG_FILE: &str = "claude-session.log";
/// Path to the Claude Code binary inside the container.
pub const CLAUDE_BINARY: &str = "/usr/local/bin/claude";

/// PATH set inside containers for the `speedwave` user.
/// Claude Code installs to `~/.local/bin`, so it must be on PATH.
pub const CONTAINER_PATH: &str = "/home/speedwave/.local/bin:/usr/local/bin:/usr/bin:/bin";

/// Single hostname for "host gateway from inside containers", injected via
/// `extra_hosts` (static + dynamic per-service, ADR-062). See CLAUDE.md SSOT row.
pub const HOST_GATEWAY_ALIAS: &str = "host.docker.internal";

/// IP of the macOS host as seen from inside nerdctl containers in the Lima vzNAT network.
/// Lima vzNAT always assigns 192.168.5.2 to the host — this is static, not DHCP.
pub const LIMA_VZ_HOST_IP: &str = "192.168.5.2";

/// Guest-local gateway IP for the WSL2 mirrored-mode host relay (ADR-079): a `socat`
/// unit on the distro's `lo` forwards its relay port here to the bridge's loopback bind port.
pub const MIRROR_RELAY_GATEWAY_IP: &str = "10.200.0.1";

/// Container user for unprivileged mode (macOS Lima, Windows WSL2).
/// containerd runs as root inside the VM → UID 1000 maps to UID 1000 on host.
pub const CONTAINER_USER_UNPRIVILEGED: &str = "1000:1000";

/// (uid, gid) parsed from [`CONTAINER_USER_UNPRIVILEGED`] — SSOT for the compose
/// `user:`, WSL drvfs `chown`, and any host-side mount owner (ADR-052).
pub fn container_uid_gid() -> (u32, u32) {
    // Const pinned to "1000:1000" by a unit test; fall back rather than panic
    // on a runtime path (no expect/unwrap in production per the project rules).
    CONTAINER_USER_UNPRIVILEGED
        .split_once(':')
        .and_then(|(uid, gid)| Some((uid.parse().ok()?, gid.parse().ok()?)))
        .unwrap_or((1000, 1000))
}

/// drvfs `[automount]` options for the WSL distro (from [`container_uid_gid`]):
/// `metadata` honors Linux mode bits; `uid`/`gid` are best-effort (ADR-052).
#[cfg(target_os = "windows")]
pub fn wsl_automount_options() -> String {
    let (uid, gid) = container_uid_gid();
    format!("metadata,uid={uid},gid={gid},umask=022")
}

/// Subdirectory within resources for nerdctl-full binaries.
pub const NERDCTL_FULL_SUBDIR: &str = "nerdctl-full";

/// Subdirectory within resources for the bundled Node.js binary.
pub const NODEJS_SUBDIR: &str = "nodejs";

/// `data_dir()/bin/` — Windows CLI install dir; SSOT for `windows/sweep.ps1`.
pub const CLI_BIN_SUBDIR: &str = "bin";

/// WSL2 distro name on Windows, derived from [`data_dir()`] basename (mirrors
/// [`lima_vm_name`]). See [`derive_wsl_distro_name_from`] for the rules.
pub fn wsl_distro_name() -> &'static str {
    use std::sync::OnceLock;
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| derive_wsl_distro_name_from(data_dir()))
}

/// nerdctl-full bundle version (containerd + nerdctl + CNI + BuildKit) for WSL2.
/// SSOT-alignment: must match the nerdctl Lima bundles on macOS (`.lima-version`).
pub const NERDCTL_FULL_VERSION: &str = "2.2.2";

/// SHA256 of the amd64 nerdctl-full bundle. Source: nerdctl release SHA256SUMS;
/// update when bumping NERDCTL_FULL_VERSION.
pub const NERDCTL_FULL_SHA256_AMD64: &str =
    "8a477f35533c6cc1120c19558d8142967c74f25a4b952b481f48104e030de914";
/// SHA256 of the arm64 nerdctl-full bundle.
pub const NERDCTL_FULL_SHA256_ARM64: &str =
    "55d68d2613b5f065021146bac21f620cde9e7fdd4bd3eff74cd324f5462e107a";

/// Tauri Windows bundle layout: resources live in `<install>\resources`.
/// Aligned with `setup_wizard::resolve_cli_source_from` (Desktop side).
pub const TAURI_WINDOWS_RESOURCES_SUBDIR: &str = "resources";

/// Filename (under `data_dir()`) of the cross-process nerdctl install lock;
/// serializes Desktop `ensure_ready` and CLI startup reinstalls.
pub const NERDCTL_INSTALL_LOCK_FILE: &str = "nerdctl-install.lock";

/// Filename (under `data_dir()`) of the nerdctl download-backoff marker; a
/// failed in-distro download is recorded here so short-lived CLI processes
/// don't restart the full download on every invocation.
pub const NERDCTL_DOWNLOAD_BACKOFF_FILE: &str = "nerdctl-download-backoff.json";

/// Minimum delay before retrying a failed in-distro nerdctl-full download.
pub const NERDCTL_DOWNLOAD_RETRY_DELAY_SECS: u64 = 3600;

/// `curl --connect-timeout` for the in-distro nerdctl-full download.
pub const NERDCTL_DOWNLOAD_CONNECT_TIMEOUT_SECS: u64 = 30;

/// `curl --max-time` ceiling for the in-distro nerdctl-full download; bounds a
/// stalled multi-hundred-MB fetch instead of hanging CLI startup indefinitely.
pub const NERDCTL_DOWNLOAD_MAX_TIME_SECS: u64 = 900;

/// Host-side ceiling for the whole in-distro nerdctl-full install (download +
/// untar + service readiness). Must exceed the curl `--max-time` above.
pub const NERDCTL_INSTALL_TIMEOUT_SECS: u64 = 1200;

// Compile-time invariants: connect < max-time < host-side wait < retry delay.
const _: () = assert!(NERDCTL_DOWNLOAD_CONNECT_TIMEOUT_SECS < NERDCTL_DOWNLOAD_MAX_TIME_SECS);
const _: () = assert!(NERDCTL_DOWNLOAD_MAX_TIME_SECS < NERDCTL_INSTALL_TIMEOUT_SECS);
const _: () = assert!(NERDCTL_DOWNLOAD_RETRY_DELAY_SECS > NERDCTL_INSTALL_TIMEOUT_SECS);

/// amd64 Ubuntu WSL rootfs URL; SHA256 below pins the version. `current` is
/// rolling — a download/verify failure on clean dev/CI means bump the SHA256 (#183).
pub const WSL_ROOTFS_URL_AMD64: &str =
    "https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-amd64-24.04lts.rootfs.tar.gz";
/// arm64 Ubuntu WSL rootfs download URL.
pub const WSL_ROOTFS_URL_ARM64: &str =
    "https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-arm64-24.04lts.rootfs.tar.gz";

/// SHA256 of the amd64 WSL rootfs; update when bumping the rootfs version above.
pub const WSL_ROOTFS_SHA256_AMD64: &str =
    "2a790896740b14d637dbdc583cce1ba081ac53b9e9cdb46dc09a2f73abbd9934";
/// SHA256 of the arm64 WSL rootfs.
pub const WSL_ROOTFS_SHA256_ARM64: &str =
    "e113b8c49af3ab49b992b8e29550fc921e689f211abc338176f8243786173a32";

/// Env var set by the Tauri app to point at bundled resources. Used by
/// `binary::resolve_binary()`, `build::resolve_build_root()`, `resolve_mcp_os_script()`.
pub const BUNDLE_RESOURCES_ENV: &str = "SPEEDWAVE_RESOURCES_DIR";

/// Marker file name written by the Desktop app inside `~/.speedwave/`.
/// The CLI reads it to locate bundled resources without the env var.
pub const RESOURCES_MARKER: &str = "resources-dir";

// --- Meeting transcription (ADR-056) ---------------------------------------

/// Recorded meetings + transcripts (`<data_dir>/transcripts/<uuid>/...`).
/// Dir perms `0o700`, files `0o600` — contain microphone/system audio.
pub const TRANSCRIPTS_SUBDIR: &str = "transcripts";

/// Downloaded Whisper models (`<data_dir>/models/whisper/ggml-*.bin`).
/// Dir perms `0o700`, files `0o600`.
pub const MODELS_SUBDIR: &str = "models";

/// Global backstop on total downloaded transcription-model size (~12 GiB), above
/// a realistic per-role set yet catching a catalogue that would fill the disk.
pub const MAX_TOTAL_TRANSCRIPTION_MODELS_BYTES: u64 = 12 * 1024 * 1024 * 1024;

/// Hosts the model downloader may redirect to (HF/GitHub signed-URL CDNs); an
/// unrecognised host errors instead of following. ADR-056 spike 0C.
pub const TRANSCRIPTION_MODEL_ALLOWED_REDIRECT_HOSTS: &[&str] = &[
    "huggingface.co",
    "cdn.hf.co",
    "cas-bridge.xethub.hf.co",
    "github.com",
    "release-assets.githubusercontent.com",
];

/// Error message with remediation steps when WSL2 is not available on Windows.
/// Used by `os_prereqs::check_os_prereqs()`.
pub const WSL_NOT_AVAILABLE_MSG: &str = "Enable required Windows features:\n\n\
    1. Run in elevated PowerShell (Run as Administrator):\n\
       dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart\n\
       dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart\n\n\
    2. Or open Settings > Apps > Optional Features > More Windows Features:\n\
       - Check 'Windows Subsystem for Linux'\n\
       - Check 'Virtual Machine Platform'\n\n\
    Then restart your computer and run Speedwave again.";

/// Non-blocking warning when nested virtualization is detected (e.g. WSL2 inside VMware).
/// Used by `os_prereqs::check_os_warnings()`.
pub const NESTED_VIRT_WARNING_MSG: &str = "\
    WSL2 uses Hyper-V, which may have degraded I/O performance in nested environments.\n\
    Image builds may be slower or fail.\n\n\
    If builds fail, try:\n\
    - Increase VM memory to at least 8 GB\n\
    - Enable nested virtualization in VM settings (VT-x/EPT or AMD-V/RVI)\n\
    - Close other memory-intensive applications";

/// Helpful error returned when a project is in a WSL distro other than Speedwave's own.
/// Reused by `windows_to_wsl_path` and `project::add_project` for consistent messaging.
pub fn wsl_other_distro_msg(other_distro: &str) -> String {
    format!(
        "Project is in WSL distribution '{other_distro}', but Speedwave runs in its own '{own}' \
         distribution and cannot access files in other WSL distributions natively.\n\n\
         To use this project, choose one of:\n\n\
         1. Copy the project into Speedwave's distribution (recommended — native performance):\n\
            From Windows PowerShell:\n\
              Copy-Item -Recurse '\\\\wsl.localhost\\{other_distro}\\home\\<you>\\<project>' \
         '\\\\wsl.localhost\\{own}\\projects\\<project>'\n\n\
         2. Move the project to a Windows drive (slower NTFS access, accessible from both):\n\
              mv ~/<project> /mnt/c/projects/<project>\n\n\
         3. Use Claude Code natively in your '{other_distro}' distribution without Speedwave \
         (loses MCP integrations).\n\n\
         See https://github.com/speednet-software/speedwave/blob/main/docs/getting-started/installation.md#wsl-native-workflow",
        own = wsl_distro_name(),
    )
}

/// Error prefix when SecurityCheck/OS prereqs fail; the frontend matches it to
/// distinguish blocking (check_failed) from dismissable (error) failures.
pub const SYSTEM_CHECK_FAILED_PREFIX: &str = "System check failed:";

/// Error prefix for a CloudStorage TCC failure (`"CloudStorage TCC required:
/// {stable_id}|{dir}"`); mirrored by TS `cloudstorage-prefix.ts`.
pub const CLOUDSTORAGE_TCC_PREFIX: &str = "CloudStorage TCC required: ";

/// Default hours between automatic update checks. Used by the CLI and the
/// Desktop updater (`UpdateSettings::check_interval_hours` default).
pub const UPDATE_CHECK_INTERVAL_HOURS: u32 = 24;

/// Delay in seconds after `compose_up_recreate` before checking container health.
/// Allows crash-looping containers to exit before `compose_ps` reports state.
pub const CONTAINER_STABILIZATION_DELAY_SECS: u64 = 3;

/// Delay in seconds after `systemctl start` inside WSL2 before retrying
/// a service health check. Gives systemd time to bring up containerd/buildkitd.
pub const WSL_SERVICE_START_DELAY_SECS: u64 = 3;

/// Max health-check retries after `systemctl start` in WSL2 (each waits
/// `WSL_SERVICE_START_DELAY_SECS`; worst case 10×3s=30s for cold-boot).
pub const WSL_SERVICE_CHECK_MAX_RETRIES: u32 = 10;

/// Delay in seconds after restarting containerd/buildkitd before checking readiness.
/// Gives systemd time to bring up the service after a `systemctl restart`.
pub const CONTAINERD_RESTART_READY_DELAY_SECS: u64 = 5;

/// Max readiness retries after restarting containerd/buildkitd (each waits
/// `CONTAINERD_RESTART_READY_DELAY_SECS`; worst case 6×5s=30s).
pub const CONTAINERD_RESTART_READY_MAX_RETRIES: u32 = 6;

/// Max seconds to wait for `limactl start` to boot the Lima VM (cold boot is
/// ~15-45s; 120s covers slow machines without an indefinite UI hang).
pub const LIMA_VM_START_TIMEOUT_SECS: u64 = 120;

/// Max seconds for a `limactl start` that may provision: the first start under
/// a newly bundled Lima downloads the guest nerdctl-full archive before boot.
/// Budget equals the Desktop image-rebuild wait (`RECONCILE_WAIT_TIMEOUT`).
pub const LIMA_VM_PROVISION_START_TIMEOUT_SECS: u64 = 600;

// Compile-time invariant: the provisioning window must extend the normal one.
const _: () = assert!(LIMA_VM_PROVISION_START_TIMEOUT_SECS > LIMA_VM_START_TIMEOUT_SECS);

/// Cause + remedy appended to `limactl start` failures on a provisioning start.
pub const LIMA_START_PROVISION_HINT: &str =
    "The first start after a Speedwave update downloads updated container \
     tooling (nerdctl-full) inside the VM; on a slow or offline connection \
     this download fails or times out. Check your internet connection and \
     relaunch Speedwave to retry.";

/// Max seconds for exit cleanup (teardown + VM stop) before force-exit; watchdog
/// in both the RunEvent::Exit handler and the ctrlc handler.
pub const EXIT_CLEANUP_TIMEOUT_SECS: u64 = 60;

/// Max seconds for `limactl stop --force` — outer safety net (Lima's `--force`
/// SIGKILLs after its own timeout) so exit cleanup can't block termination.
pub const LIMA_VM_STOP_TIMEOUT_SECS: u64 = 30;

/// Delay in seconds between status polls while waiting for a Lima VM
/// in `Stopping` state to finish. Used by `ensure_ready_inner`.
pub const LIMA_VM_STOP_POLL_DELAY_SECS: u64 = 3;

// Compile-time invariant: VM stop must complete before the exit cleanup
// watchdog fires, otherwise the watchdog kills the process mid-stop.
const _: () = assert!(LIMA_VM_STOP_TIMEOUT_SECS < EXIT_CLEANUP_TIMEOUT_SECS);

/// Physical storage tier per auth field (ADR-060).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldStorage {
    /// `~/.speedwave/tokens/<project>/<service>/<key>`, :ro into worker.
    WorkerMountedToken,
    /// Inside per-service `config.json`, :ro into worker.
    WorkerMountedConfig,
    /// Top-level key in host-only `oauth/<project>/<service>.json`.
    OAuthState,
    /// Nested under `providerData` in the same oauth.json.
    OAuthStateProviderData,
}

/// Descriptor for a single auth/credential field of an MCP service.
pub struct McpAuthFieldDescriptor {
    /// Field key used as filename in the tokens directory (e.g. "bot_token").
    pub key: &'static str,
    /// Human-readable label for the UI (e.g. "Bot Token").
    pub label: &'static str,
    /// HTML input type: "password", "text", or "url".
    pub field_type: &'static str,
    /// Placeholder text for the input field.
    pub placeholder: &'static str,
    /// Whether this field contains a secret (token, key, etc.).
    pub is_secret: bool,
    /// Mirror of `storage == WorkerMountedConfig`; prefer the
    /// [`McpAuthFieldDescriptor::stored_in_config_json`] method (kept until Desktop migrates).
    pub stored_in_config_json: bool,
    /// Obtained via OAuth rather than manual entry; `oauth_flow: true` hides the
    /// field from the credential form and fills it via the Device Code Flow.
    pub oauth_flow: bool,
    /// Optional for configuration — shown in the UI but does not block the
    /// "Configured" status when left empty.
    pub optional: bool,
    /// Physical storage tier (ADR-060) — drives credential routing in the
    /// Desktop crate (save/is-configured/delete).
    pub storage: FieldStorage,
    /// Optional help text rendered under the input. `None` = no hint.
    pub hint: Option<&'static str>,
}

impl McpAuthFieldDescriptor {
    /// True when the field lives in the per-service `config.json`
    /// (`WorkerMountedConfig`). SSOT — prefer this over the mirror field.
    pub fn stored_in_config_json(&self) -> bool {
        self.storage == FieldStorage::WorkerMountedConfig
    }
}

/// SharePoint Device Code Flow scopes; `Sites.Manage.All` covers the narrower
/// Sites scopes and is required by Graph `createList` (delegated).
pub const SHAREPOINT_OAUTH_SCOPES: &str = "https://graph.microsoft.com/Sites.Manage.All \
     https://graph.microsoft.com/Files.ReadWrite.All \
     https://graph.microsoft.com/User.Read offline_access";

/// GitHub OAuth App client ID (public identifier — not a secret). Registered
/// at <https://github.com/settings/developers> by Speednet, Device Flow enabled.
pub const GITHUB_OAUTH_CLIENT_ID: &str = "Ov23lifyXPigAcJ0d4tK";

/// GitHub OAuth scopes requested by Speedwave. Derived from the `mcp-github`
/// worker surface (`mcp-servers/github/src/client.ts`).
pub const GITHUB_OAUTH_SCOPES: &str = "repo read:user";

/// Slack app client ID (public, not a secret) — PKCE public client with token
/// rotation, shared across all users. See ADR-071.
pub const SLACK_OAUTH_CLIENT_ID: &str = "11058760208.11311852745015";

/// Slack user scopes (`user_scope` — never bot scopes). Derived from the
/// `mcp-slack` worker surface; must match the app's User Token Scopes.
pub const SLACK_OAUTH_USER_SCOPES: &[&str] = &[
    "chat:write",
    "channels:read",
    "groups:read",
    "channels:history",
    "groups:history",
    "im:read",
    "im:history",
    "im:write",
    "mpim:read",
    "mpim:history",
    "mpim:write",
    "users:read",
    "users:read.email",
    "files:read",
];

/// Slack OAuth authorize endpoint (fixed — slack.com is not instance-specific).
pub const SLACK_OAUTH_AUTHORIZE_URL: &str = "https://slack.com/oauth/v2/authorize";

/// Slack token endpoint. Mirrored by `SLACK_TOKEN_URL` in
/// `mcp-servers/oauth/src/providers/slack.ts` (the refresh side).
pub const SLACK_OAUTH_TOKEN_URL: &str = "https://slack.com/api/oauth.v2.access";

/// Fixed loopback port for the Slack OAuth redirect (exact match against the
/// app's registered `http://localhost:41739/callback`).
pub const SLACK_OAUTH_REDIRECT_PORT: u16 = 41739;

/// Descriptor for a toggleable MCP service.
pub struct McpServiceDescriptor {
    /// Config key used in integrations config (e.g. "slack").
    pub config_key: &'static str,
    /// Compose service name (e.g. "mcp-slack").
    pub compose_name: &'static str,
    /// Hub environment variable for worker URL (e.g. "WORKER_SLACK_URL").
    pub worker_env: &'static str,
    /// Human-readable display name (e.g. "Slack").
    pub display_name: &'static str,
    /// Short description for the UI.
    pub description: &'static str,
    /// Auth/credential fields for this service.
    pub auth_fields: &'static [McpAuthFieldDescriptor],
    /// Files mounted under `tokens/<project>/<service>/` into the worker (ADR-060).
    /// OAuth-state-only fields live off-mount — see `oauth_state_fields`.
    pub credential_files: &'static [&'static str],
    /// `Some(_)` = field names in `oauth/<project>/<service>.json` (off-mount);
    /// `None` for services without OAuth state. See ADR-060.
    pub oauth_state_fields: Option<&'static [&'static str]>,
    /// Optional UI badge label (e.g. "BETA", "NEW"). `None` = no badge.
    pub badge: Option<&'static str>,
    /// IdP brand name for OAuth button copy ("Sign in with <label>").
    /// `None` for services without an OAuth flow.
    pub oauth_provider_label: Option<&'static str>,
    /// True if the worker runs on its own egress-less network `{NETWORK_NAME}_{config_key}`
    /// (e.g. `office`); disabling it removes that network + the hub's attachment.
    pub egress_less: bool,
    /// True if the worker uses the host-side `oauth` worker (ADR-060): compose injects
    /// `WORKER_OAUTH_URL` + a per-service bearer mount. SSOT for OAuth-using integrations.
    pub uses_oauth_refresh: bool,
    /// Container resource limits (mem/cpu/tmpfs/shm) — SSOT the compose renderer
    /// reads; drift vs `compose.template.yml` is test-caught. See ADR-068.
    pub resources: ContainerResources,
}

/// Toggleable MCP services — Single Source of Truth for service metadata.
/// Used by compose filtering, integrations UI, credential management, and config toggles.
pub const TOGGLEABLE_MCP_SERVICES: &[McpServiceDescriptor] = &[
    McpServiceDescriptor {
        config_key: "slack",
        compose_name: "mcp-slack",
        worker_env: "WORKER_SLACK_URL",
        display_name: "Slack",
        description: "Team messaging and notifications",
        auth_fields: &[
            // Both fields are OAuth-managed ("Sign in with Slack", ADR-071);
            // the bundled SLACK_OAUTH_CLIENT_ID means no manual fields at all.
            McpAuthFieldDescriptor {
                key: "access_token",
                label: "Slack Access Token",
                field_type: "password",
                placeholder: "xoxe.xoxp-...",
                is_secret: true,
                stored_in_config_json: false,
                oauth_flow: true,
                optional: false,
                // Mounted into the worker — rotated on every refresh by the
                // host-side `oauth` worker (ADR-060) and re-read by slackCall.
                storage: FieldStorage::WorkerMountedToken,
                hint: None,
            },
            McpAuthFieldDescriptor {
                key: "refresh_token",
                label: "Refresh Token",
                field_type: "password",
                placeholder: "xoxe-1-...",
                is_secret: true,
                stored_in_config_json: false,
                oauth_flow: true,
                optional: false,
                // Off-mount (ADR-060 §"Threat model"): a container compromise
                // cannot exfiltrate the single-use rotating refresh token.
                storage: FieldStorage::OAuthState,
                hint: None,
            },
        ],
        credential_files: &["access_token"],
        oauth_state_fields: Some(&["refresh_token"]),
        badge: None,
        oauth_provider_label: Some("Slack"),
        egress_less: false,
        uses_oauth_refresh: true,
        resources: STANDARD_WORKER_RESOURCES,
    },
    McpServiceDescriptor {
        config_key: "sharepoint",
        compose_name: "mcp-sharepoint",
        worker_env: "WORKER_SHAREPOINT_URL",
        display_name: "SharePoint",
        description: "Microsoft 365 document management",
        auth_fields: &[
            McpAuthFieldDescriptor {
                key: "access_token",
                label: "Access Token",
                field_type: "password",
                placeholder: "eyJ0...",
                is_secret: true,
                stored_in_config_json: false,
                oauth_flow: true,
                optional: false,
                // Mounted into the worker — refreshed by the host-side `oauth`
                // worker (ADR-060) and read by the SharePoint client at runtime.
                storage: FieldStorage::WorkerMountedToken,
                hint: None,
            },
            McpAuthFieldDescriptor {
                key: "refresh_token",
                label: "Refresh Token",
                field_type: "password",
                placeholder: "0.AR...",
                is_secret: true,
                stored_in_config_json: false,
                oauth_flow: true,
                optional: false,
                // Off-mount (ADR-060 §"Threat model"): not in `/tokens`, so a
                // container compromise cannot exfiltrate the refresh_token.
                storage: FieldStorage::OAuthState,
                hint: None,
            },
            McpAuthFieldDescriptor {
                key: "client_id",
                label: "Client ID",
                field_type: "text",
                placeholder: "00000000-0000-...",
                is_secret: false,
                stored_in_config_json: false,
                oauth_flow: false,
                optional: false,
                storage: FieldStorage::OAuthStateProviderData,
                hint: None,
            },
            McpAuthFieldDescriptor {
                key: "tenant_id",
                label: "Tenant ID",
                field_type: "text",
                placeholder: "00000000-0000-...",
                is_secret: false,
                stored_in_config_json: false,
                oauth_flow: false,
                optional: false,
                storage: FieldStorage::OAuthStateProviderData,
                hint: None,
            },
            McpAuthFieldDescriptor {
                key: "site_id",
                label: "Site ID",
                field_type: "text",
                placeholder: "acme.sharepoint.com:/sites/Marketing:",
                is_secret: false,
                stored_in_config_json: false,
                oauth_flow: false,
                optional: false,
                // Site policy by omission (ADR-060): the worker reads its
                // stored site_id and Graph tools accept no `site_id` parameter.
                storage: FieldStorage::WorkerMountedToken,
                hint: Some(
                    "Path form: \"acme.sharepoint.com:/sites/Marketing:\" (mind both colons: \
                     one after the hostname (`:/`) and one at the end (`:`)). \
                     Or composite form: \"acme.sharepoint.com,{site-guid},{web-guid}\" \
                     (GET /sites/{hostname}:/sites/{path} in Graph Explorer, copy the response `id`). \
                     NOT a SharePoint URL.",
                ),
            },
        ],
        // Only files physically mounted into the worker (ADR-060); refresh_token /
        // client_id / tenant_id are off-mount — see `oauth_state_fields` below.
        credential_files: &["access_token", "site_id"],
        oauth_state_fields: Some(&[
            // LOGICAL allowlist of fields the UI may save into oauth.json.
            // logical→disk mapping: `integrations_cmd::{get_oauth_field,merge_oauth_state_json}`.
            "refresh_token",
            "client_id",
            "tenant_id",
            "scopes",
            "grantedScopes",
            "expiresAt",
            "lastRefreshAt",
        ]),
        badge: None,
        oauth_provider_label: Some("Microsoft"),
        egress_less: false,
        uses_oauth_refresh: true,
        resources: STANDARD_WORKER_RESOURCES,
    },
    McpServiceDescriptor {
        config_key: "redmine",
        compose_name: "mcp-redmine",
        worker_env: "WORKER_REDMINE_URL",
        display_name: "Redmine",
        description: "Project management and issue tracking",
        auth_fields: &[
            McpAuthFieldDescriptor {
                key: "host_url",
                label: "Redmine URL",
                field_type: "url",
                placeholder: "https://redmine.company.com",
                is_secret: false,
                stored_in_config_json: true,
                oauth_flow: false,
                optional: false,
                storage: FieldStorage::WorkerMountedConfig,
                hint: None,
            },
            McpAuthFieldDescriptor {
                key: "api_key",
                label: "API Key",
                field_type: "password",
                placeholder: "abcdef1234567890...",
                is_secret: true,
                stored_in_config_json: false,
                oauth_flow: false,
                optional: false,
                storage: FieldStorage::WorkerMountedToken,
                hint: None,
            },
            McpAuthFieldDescriptor {
                key: "project_id",
                label: "Project ID",
                field_type: "text",
                placeholder: "my-project",
                is_secret: false,
                stored_in_config_json: true,
                oauth_flow: false,
                optional: true,
                storage: FieldStorage::WorkerMountedConfig,
                hint: None,
            },
        ],
        credential_files: &[
            "api_key",
            "config.json",
            "host_url",
            "project_id",
            "project_name",
        ],
        oauth_state_fields: None,
        badge: None,
        oauth_provider_label: None,
        egress_less: false,
        uses_oauth_refresh: false,
        resources: STANDARD_WORKER_RESOURCES,
    },
    McpServiceDescriptor {
        config_key: "gitlab",
        compose_name: "mcp-gitlab",
        worker_env: "WORKER_GITLAB_URL",
        display_name: "GitLab",
        description: "Git repository and CI/CD platform",
        auth_fields: &[
            McpAuthFieldDescriptor {
                key: "host_url",
                label: "GitLab URL",
                field_type: "url",
                placeholder: "https://gitlab.com",
                is_secret: false,
                stored_in_config_json: false,
                oauth_flow: false,
                optional: false,
                storage: FieldStorage::WorkerMountedToken,
                hint: None,
            },
            McpAuthFieldDescriptor {
                key: "token",
                label: "Personal Access Token",
                field_type: "password",
                placeholder: "glpat-...",
                is_secret: true,
                stored_in_config_json: false,
                oauth_flow: false,
                optional: false,
                storage: FieldStorage::WorkerMountedToken,
                hint: None,
            },
        ],
        credential_files: &["token", "host_url"],
        oauth_state_fields: None,
        badge: None,
        oauth_provider_label: None,
        egress_less: false,
        uses_oauth_refresh: false,
        resources: STANDARD_WORKER_RESOURCES,
    },
    McpServiceDescriptor {
        config_key: "github",
        compose_name: "mcp-github",
        worker_env: "WORKER_GITHUB_URL",
        display_name: "GitHub",
        description: "Code hosting and CI/CD platform",
        auth_fields: &[McpAuthFieldDescriptor {
            key: "token",
            // Populated by the OAuth App device flow (`start_github_oauth`); no
            // manual entry — UI shows a "Connect to GitHub" button (`oauth_flow: true`).
            label: "GitHub Access Token",
            field_type: "password",
            placeholder: "gho_...",
            is_secret: true,
            stored_in_config_json: false,
            oauth_flow: true,
            optional: false,
            storage: FieldStorage::WorkerMountedToken,
            hint: None,
        }],
        credential_files: &["token"],
        // GitHub OAuth App tokens are long-lived (no refresh) → both None/false;
        // revocation is handled by the UI "Reconnect to GitHub" path.
        oauth_state_fields: None,
        badge: None,
        oauth_provider_label: Some("GitHub"),
        egress_less: false,
        uses_oauth_refresh: false,
        // 256m (not 128m): Octokit + throttling/retry plugins + octokit.paginate
        // buffer full result sets — a 128m cap OOM-kills listIssues on busy repos.
        resources: ContainerResources {
            mem_mib: 256,
            cpus: 0.5,
            tmpfs_mib: 64,
            shm_mib: None,
        },
    },
    McpServiceDescriptor {
        config_key: "atlassian",
        compose_name: "mcp-atlassian",
        worker_env: "WORKER_ATLASSIAN_URL",
        display_name: "Atlassian",
        description: "Jira and Confluence (Atlassian Cloud)",
        auth_fields: &[
            McpAuthFieldDescriptor {
                key: "site_url",
                label: "Atlassian site URL",
                field_type: "url",
                placeholder: "https://your-domain.atlassian.net",
                is_secret: false,
                stored_in_config_json: false,
                oauth_flow: false,
                optional: false,
                storage: FieldStorage::WorkerMountedToken,
                hint: None,
            },
            McpAuthFieldDescriptor {
                key: "email",
                label: "Account email",
                field_type: "text",
                placeholder: "you@example.com",
                is_secret: false,
                stored_in_config_json: false,
                oauth_flow: false,
                optional: false,
                storage: FieldStorage::WorkerMountedToken,
                hint: None,
            },
            McpAuthFieldDescriptor {
                key: "api_token",
                label: "API token",
                field_type: "password",
                placeholder: "ATATT3x...",
                is_secret: true,
                stored_in_config_json: false,
                oauth_flow: false,
                optional: false,
                storage: FieldStorage::WorkerMountedToken,
                hint: None,
            },
            McpAuthFieldDescriptor {
                key: "jira_project_keys",
                label: "Jira project keys (allowlist, optional)",
                field_type: "text",
                placeholder: "PROJ,OPS — empty = all",
                is_secret: false,
                stored_in_config_json: false,
                oauth_flow: false,
                optional: true,
                storage: FieldStorage::WorkerMountedToken,
                hint: None,
            },
            McpAuthFieldDescriptor {
                key: "confluence_space_keys",
                label: "Confluence space keys (allowlist, optional)",
                field_type: "text",
                placeholder: "DEV,DOCS — empty = all",
                is_secret: false,
                stored_in_config_json: false,
                oauth_flow: false,
                optional: true,
                storage: FieldStorage::WorkerMountedToken,
                hint: None,
            },
        ],
        credential_files: &[
            "site_url",
            "email",
            "api_token",
            "jira_project_keys",
            "confluence_space_keys",
        ],
        oauth_state_fields: None,
        badge: None,
        oauth_provider_label: None,
        egress_less: false,
        uses_oauth_refresh: false,
        resources: STANDARD_WORKER_RESOURCES,
    },
    McpServiceDescriptor {
        config_key: "office",
        compose_name: "mcp-office",
        worker_env: "WORKER_OFFICE_URL",
        display_name: "Office documents",
        description: "Read, write, convert Word/Excel/PowerPoint/PDF; render charts",
        // A pure file processor — no service credentials. Operates on /workspace files only.
        auth_fields: &[],
        credential_files: &[],
        oauth_state_fields: None,
        badge: Some("BETA"),
        oauth_provider_label: None,
        egress_less: true,
        uses_oauth_refresh: false,
        // 1g + 512m /tmp: LibreOffice headless on a non-trivial .pptx.
        resources: ContainerResources {
            mem_mib: 1024,
            cpus: 1.0,
            tmpfs_mib: 512,
            shm_mib: None,
        },
    },
    McpServiceDescriptor {
        config_key: "playwright",
        compose_name: "mcp-playwright",
        worker_env: "WORKER_PLAYWRIGHT_URL",
        display_name: "Playwright",
        description: "Headless browser automation (Chromium via Playwright)",
        // Playwright has no credentials — it scrapes public URLs only.
        auth_fields: &[],
        credential_files: &[],
        oauth_state_fields: None,
        badge: Some("BETA"),
        oauth_provider_label: None,
        egress_less: false,
        uses_oauth_refresh: false,
        // 2g + 1g /tmp + 2g shm: Chromium IPC needs shm above the 64m default
        // (ENOMEM at page load otherwise); shm is separate from the mem cap.
        resources: ContainerResources {
            mem_mib: 2048,
            cpus: 2.0,
            tmpfs_mib: 1024,
            shm_mib: Some(2048),
        },
    },
    McpServiceDescriptor {
        config_key: "context7",
        compose_name: "mcp-context7",
        worker_env: "WORKER_CONTEXT7_URL",
        display_name: "Context7",
        description: "Up-to-date library documentation (React, Spring, Django, …)",
        // `api_key` is optional (anonymous mode works); the Tauri layer overrides
        // the badge dynamically. Default here is the unconfigured display.
        auth_fields: &[McpAuthFieldDescriptor {
            key: "api_key",
            label: "API Key (optional — higher rate limits)",
            field_type: "password",
            placeholder: "ctx7sk_…",
            is_secret: true,
            stored_in_config_json: false,
            oauth_flow: false,
            optional: true,
            storage: FieldStorage::WorkerMountedToken,
            hint: None,
        }],
        credential_files: &["api_key"],
        oauth_state_fields: None,
        badge: Some("Anonymous"),
        oauth_provider_label: None,
        egress_less: false,
        uses_oauth_refresh: false,
        resources: STANDARD_WORKER_RESOURCES,
    },
];

/// Descriptor for a toggleable OS integration service (macOS only).
pub struct OsServiceDescriptor {
    /// Config key used in OsIntegrationsConfig (e.g. "reminders").
    pub config_key: &'static str,
    /// Human-readable display name (e.g. "Reminders").
    pub display_name: &'static str,
    /// Short description for the UI.
    pub description: &'static str,
}

/// Toggleable OS integration services — Single Source of Truth for OS service metadata.
/// Used by compose filtering (DISABLED_OS_SERVICES), integrations UI, and config toggles.
pub const TOGGLEABLE_OS_SERVICES: &[OsServiceDescriptor] = &[
    OsServiceDescriptor {
        config_key: "reminders",
        display_name: "Reminders",
        description: "Native OS reminders and tasks",
    },
    OsServiceDescriptor {
        config_key: "calendar",
        display_name: "Calendar",
        description: "Native OS calendar events",
    },
    OsServiceDescriptor {
        config_key: "mail",
        display_name: "Mail",
        description: "Native OS email client",
    },
    OsServiceDescriptor {
        config_key: "notes",
        display_name: "Notes",
        description: "Native OS notes",
    },
];

/// Look up a toggleable MCP service by config key.
pub fn find_mcp_service(config_key: &str) -> Option<&'static McpServiceDescriptor> {
    TOGGLEABLE_MCP_SERVICES
        .iter()
        .find(|s| s.config_key == config_key)
}

/// Build the per-project Claude session log path using an injected home directory.
/// Testable variant — does not depend on `dirs::home_dir()`.
pub fn claude_session_log_path_in(home: &std::path::Path, project: &str) -> std::path::PathBuf {
    home.join(DATA_DIR)
        .join("logs")
        .join(project)
        .join(CLAUDE_SESSION_LOG_FILE)
}

/// SSOT for the Claude session log path under an explicit data dir — used by the
/// diagnostic-source registry. `claude_session_log_path` is the `data_dir()` shim.
pub fn claude_session_log_path_under(
    data_dir: &std::path::Path,
    project: &str,
) -> std::path::PathBuf {
    data_dir
        .join("logs")
        .join(project)
        .join(CLAUDE_SESSION_LOG_FILE)
}

/// Build the per-project Claude session log path.
pub fn claude_session_log_path(project: &str) -> std::path::PathBuf {
    claude_session_log_path_under(data_dir(), project)
}

/// SSOT for the mcp-os drain log path — never re-join `data_dir()` by hand.
pub fn mcp_os_log_path() -> std::path::PathBuf {
    data_dir().join(MCP_OS_LOG_FILE)
}

/// Built-in services defined in containers/compose.template.yml.
/// Used by security checks and image build lists.
pub const BUILT_IN_SERVICES: &[&str] = &[
    "claude",
    "proxy",
    "mcp-hub",
    "mcp-slack",
    "mcp-sharepoint",
    "mcp-redmine",
    "mcp-gitlab",
    "mcp-github",
    "mcp-atlassian",
    "mcp-office",
    "mcp-playwright",
    "mcp-context7",
];

/// Built-in service IDs (logical names) — plugin install rejects these slugs.
/// Hyphen→underscore normalization happens in both Rust and the hub TS.
pub const BUILT_IN_SERVICE_IDS: &[&str] = &[
    "slack",
    "sharepoint",
    "redmine",
    "gitlab",
    "github",
    "atlassian",
    "office",
    "playwright",
    "context7",
    "os",
    // Host-side OAuth refresh worker (ADR-060), reserved against plugin slug
    // collisions. Never enumerated to Claude (not in ENABLED_SERVICES).
    "oauth",
    // Reserved for the IDE bridge (`<data_dir>/ide-bridge/`) — a plugin slug
    // `"ide"` would collide on that directory. No compose service.
    "ide",
    // Reserves the `llm` token-dir namespace (per-provider Proxy keys, ADR-073)
    // against plugin slug collisions. `proxy` needs no entry (mcp-prefixed slugs).
    "llm",
];

/// Env names plugins can't set via `extra_env` (Speedwave-reserved or hijack
/// vectors); compared case-insensitively. SSOT for `validate_manifest()`.
pub const RESERVED_ENV_KEYS: &[&str] = &[
    // Reserved by Speedwave — auto-injected
    "PORT",
    "SPW_CREDENTIALS_DIGEST",
    "SPW_PLUGIN_DIGESTS",
    // Bundled-plugin install list/marketplace — a repo must not redirect which
    // plugins the container installs (defaults::BUNDLED_PLUGINS is the SSOT).
    "SPEEDWAVE_BUNDLED_PLUGINS",
    "SPEEDWAVE_BUNDLED_PLUGIN_MARKETPLACE",
    // Dynamic linker hijacks (Linux)
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    // Dynamic linker hijacks (macOS)
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FORCE_FLAT_NAMESPACE",
    // Language-runtime hijacks
    "NODE_OPTIONS",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    // Shell / process environment
    "PATH",
    "HOME",
    "SHELL",
    "IFS",
    "BASH_ENV",
    "ENV",
];

/// Upper bound for plugin `mem_limit` (MiB) — rejected above this at install.
/// 16 GiB covers ML-heavy workers while blocking host-OOM values. Built-ins exempt.
pub const PLUGIN_MEM_LIMIT_MAX_MIB: u64 = 16384;

/// Upper bound for plugin `cpu_limit` (cores). 4 cores is enough for any
/// MCP worker we ship; raising it requires an explicit ADR.
pub const PLUGIN_CPU_LIMIT_MAX: f32 = 4.0;

/// Default plugin mem limit when the manifest omits it (a floor). Capped by
/// `plugin_defaults_within_caps`; SSOT for `generate_plugin_service`.
pub const PLUGIN_DEFAULT_MEM: &str = "128m";
/// Default plugin CPU limit (cores) when the manifest omits it.
pub const PLUGIN_DEFAULT_CPU: &str = "2.0";
/// Default plugin tmpfs size when the manifest omits it.
pub const PLUGIN_DEFAULT_TMPFS: &str = "512m";

/// Byte cap for a plugin's `settings_schema` and per-plugin settings payload
/// (both inline in `user_config.json`). 64 KiB bounds the shared config file.
pub const PLUGIN_SETTINGS_MAX_BYTES: usize = 64 * 1024;

/// Byte cap for a manifest's `instructions` field (long-form Markdown shown on
/// the plugin Dashboard). 16 KiB bounds UI/`PluginStatusEntry` size, not safety.
pub const PLUGIN_INSTRUCTIONS_MAX_BYTES: usize = 16 * 1024;

/// Filename of the optional release-notes file shipped inside a plugin ZIP,
/// rendered on the plugin Changelog tab. Part of the signed tree.
pub const PLUGIN_CHANGELOG_FILE: &str = "CHANGELOG.md";

/// Byte cap for a plugin's `CHANGELOG.md` (grows with every release, so it
/// gets more headroom than `instructions`). Bounds `PluginStatusEntry` size.
pub const PLUGIN_CHANGELOG_MAX_BYTES: usize = 64 * 1024;

/// Max length of an `auth_fields[].validation.pattern` regex. 512 chars is an
/// engine-agnostic guard (the JS `<input pattern>` engine can backtrack).
pub const PLUGIN_AUTH_FIELD_PATTERN_MAX_LEN: usize = 512;

/// Max length of `host_bridge.url_env` / `token_env` names. 128 leaves headroom
/// over typical POSIX names without a manifest shipping a huge env name.
pub const PLUGIN_BRIDGE_ENV_NAME_MAX_LEN: usize = 128;

/// Max length of `host_bridge.display_name` (lands in the bridge lock `ideName`
/// + UI); 256 chars covers any reasonable name without bloating bridge state.
pub const PLUGIN_BRIDGE_DISPLAY_NAME_MAX_LEN: usize = 256;

/// Max length of a `host_bridge.roles` role key — prevents a multi-KB string
/// in per-connection event-channel payloads.
pub const PLUGIN_BRIDGE_ROLE_NAME_MAX_LEN: usize = 128;

/// Max length of a per-role auth scheme name — i.e. the `name` field on
/// `HostBridgeRoleAuth::Header { name }` / `QueryParam { name }`.
pub const PLUGIN_BRIDGE_AUTH_NAME_MAX_LEN: usize = 128;

/// Max role entries in `host_bridge.roles`. 16 far exceeds any plausible plugin
/// (pairing uses two) and blocks a manifest inflating bridge state.
pub const PLUGIN_BRIDGE_ROLES_MAX_COUNT: usize = 16;

/// Max length of an OAuth endpoint URL in a plugin manifest.
pub const PLUGIN_OAUTH_URL_MAX_LEN: usize = 2048;

/// Max length of an `oauth.{authorize,token}_suffix` path appended to a
/// per-instance base URL (e.g. `/authorize`). See ADR-069.
pub const PLUGIN_OAUTH_SUFFIX_MAX_LEN: usize = 128;

/// Max number of `oauth.scopes` entries.
pub const PLUGIN_OAUTH_SCOPES_MAX_COUNT: usize = 64;

/// Max length of a single `oauth.scopes` entry.
pub const PLUGIN_OAUTH_SCOPE_MAX_LEN: usize = 256;

/// OAuth grant types the host can execute; `validate_manifest` rejects others.
/// Widen in the PR that implements the grant, not before.
pub const SUPPORTED_OAUTH_GRANT_TYPES: &[&str] = &["authorization_code"];

/// Pure, testable data-dir resolution: None/empty → `home.join(DATA_DIR)`,
/// absolute → that path; panics on a relative path (incl. unexpanded `~/...`).
pub fn data_dir_from(env_val: Option<&str>, home: &std::path::Path) -> std::path::PathBuf {
    match env_val {
        Some(val) if !val.is_empty() => {
            let path = std::path::PathBuf::from(val);
            assert!(
                path.is_absolute(),
                "SPEEDWAVE_DATA_DIR must be an absolute path, got: {val}"
            );
            path
        }
        _ => home.join(DATA_DIR),
    }
}

/// Speedwave data dir (once per process): `SPEEDWAVE_DATA_DIR` else `~/.speedwave/`.
/// Panics only if neither that env var nor a usable HOME is available.
pub fn data_dir() -> &'static std::path::PathBuf {
    use std::sync::OnceLock;
    static DIR: OnceLock<std::path::PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let env_val = std::env::var(DATA_DIR_ENV).ok();
        let Some(home) = dirs::home_dir() else {
            panic!("cannot determine home directory and {DATA_DIR_ENV} is not set");
        };
        data_dir_from(env_val.as_deref(), &home)
    })
}

/// CLI install path as a platform-shaped string (Windows backslashes, not
/// `PathBuf::join`, so it is host-independent). Unix ignores `data_dir`. ADR-016.
pub fn cli_install_path_for(
    is_windows: bool,
    home: &std::path::Path,
    data_dir: &std::path::Path,
) -> String {
    if is_windows {
        format!(
            "{}\\{}\\{}",
            data_dir.to_string_lossy(),
            CLI_BIN_SUBDIR,
            cli_binary_filename(true)
        )
    } else {
        home.join(".local")
            .join("bin")
            .join(CLI_BINARY)
            .to_string_lossy()
            .into_owned()
    }
}

/// Production shim: resolves the install path for the host platform.
/// `None` only if the home directory cannot be determined.
pub fn cli_install_path() -> Option<String> {
    Some(cli_install_path_for(
        cfg!(target_os = "windows"),
        &dirs::home_dir()?,
        data_dir(),
    ))
}

/// CLI binary filename for the platform: `<CLI_BINARY>.exe` on Windows,
/// `CLI_BINARY` otherwise. Single-sourced from `CLI_BINARY`.
pub fn cli_binary_filename(is_windows: bool) -> String {
    if is_windows {
        format!("{CLI_BINARY}.exe")
    } else {
        CLI_BINARY.to_string()
    }
}

/// Instance name from a data-dir path: strips leading dots, panics unless the
/// basename matches `^[a-z][a-z0-9-]{0,63}$`. Shell SSOT: `scripts/e2e-vm.sh`.
pub fn derive_instance_name_from(data_dir: &std::path::Path) -> String {
    let Some(basename) = data_dir.file_name().and_then(|n| n.to_str()) else {
        panic!(
            "SPEEDWAVE_DATA_DIR must have a non-empty basename, got: {}",
            data_dir.display()
        );
    };
    let name = basename.trim_start_matches('.');
    assert!(
        !name.is_empty(),
        "SPEEDWAVE_DATA_DIR basename is empty after stripping dots: {basename}"
    );
    assert!(
        name.starts_with(|c: char| c.is_ascii_lowercase())
            && name.len() <= 64
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
        "SPEEDWAVE_DATA_DIR basename '{name}' must match ^[a-z][a-z0-9-]{{0,63}}$"
    );
    name.to_string()
}

/// WSL2 distro name from a data-dir path: `.speedwave`→`Speedwave`, else
/// `Speedwave-<suffix>` (no double prefix on already-`speedwave-` basenames).
pub fn derive_wsl_distro_name_from(data_dir: &std::path::Path) -> String {
    let basename = derive_instance_name_from(data_dir);
    if basename == "speedwave" {
        return "Speedwave".to_string();
    }
    let suffix = basename.strip_prefix("speedwave-").unwrap_or(&basename);
    format!("Speedwave-{suffix}")
}

/// Lima VM name from the data-dir basename (default `"speedwave"`; custom e.g.
/// `/opt/sw-test` → `"sw-test"`).
pub fn lima_vm_name() -> &'static str {
    use std::sync::OnceLock;
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| derive_instance_name_from(data_dir()))
}

/// Compose project prefix from the data-dir basename (default `"speedwave"`;
/// custom e.g. `/opt/sw-test` → `"sw-test"`).
pub fn compose_prefix() -> &'static str {
    use std::sync::OnceLock;
    static PREFIX: OnceLock<String> = OnceLock::new();
    PREFIX.get_or_init(|| derive_instance_name_from(data_dir()))
}

/// Strips the `<compose_prefix>_<project>_` prefix to the bare service name;
/// returns the input unchanged when the prefix does not match.
pub fn strip_compose_container_prefix<'a>(name: &'a str, project: &str) -> &'a str {
    let prefix = format!("{}_{}_", compose_prefix(), project);
    name.strip_prefix(&prefix).unwrap_or(name)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn plugin_defaults_within_caps() {
        // Omitted-field defaults must respect the caps the validator enforces
        // for explicit values. (TMPFS has no cap constant — not checked.)
        let mem = crate::plugin::parse_mem_limit_to_mib(PLUGIN_DEFAULT_MEM)
            .expect("PLUGIN_DEFAULT_MEM must parse");
        assert!(
            mem <= PLUGIN_MEM_LIMIT_MAX_MIB,
            "PLUGIN_DEFAULT_MEM {mem} MiB exceeds cap {PLUGIN_MEM_LIMIT_MAX_MIB}"
        );
        let cpu: f32 = PLUGIN_DEFAULT_CPU
            .parse()
            .expect("PLUGIN_DEFAULT_CPU must parse");
        assert!(
            cpu <= PLUGIN_CPU_LIMIT_MAX,
            "PLUGIN_DEFAULT_CPU {cpu} exceeds cap {PLUGIN_CPU_LIMIT_MAX}"
        );
    }

    #[test]
    fn test_reserved_env_keys_complete_and_uppercase() {
        // Bumping this count is deliberate — signals a new hijack vector (grow
        // the plugin.rs test too). Catches accidental deletions.
        assert_eq!(RESERVED_ENV_KEYS.len(), 20);
        for &k in RESERVED_ENV_KEYS {
            assert_eq!(
                k,
                k.to_uppercase(),
                "RESERVED_ENV_KEYS entries are stored uppercase; comparison is case-insensitive at the call site"
            );
        }
        // Sanity: the dynamic-linker and Speedwave-reserved entries are present.
        for required in [
            "PORT",
            "SPW_CREDENTIALS_DIGEST",
            "SPW_PLUGIN_DIGESTS",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "NODE_OPTIONS",
            "PATH",
        ] {
            assert!(
                RESERVED_ENV_KEYS.contains(&required),
                "{required} must be reserved"
            );
        }
    }

    #[test]
    fn test_nerdctl_full_version_is_semver() {
        assert_eq!(
            NERDCTL_FULL_VERSION.split('.').count(),
            3,
            "NERDCTL_FULL_VERSION must be a semver triple (x.y.z)"
        );
        for part in NERDCTL_FULL_VERSION.split('.') {
            part.parse::<u32>()
                .expect("each semver component must be a valid number");
        }
    }

    #[test]
    fn test_wsl_rootfs_urls_are_https() {
        assert!(WSL_ROOTFS_URL_AMD64.starts_with("https://"));
        assert!(WSL_ROOTFS_URL_ARM64.starts_with("https://"));
    }

    // Lock and backoff markers are flat filenames directly under data_dir().
    #[test]
    fn nerdctl_lock_and_backoff_files_are_distinct_flat_names() {
        for name in [NERDCTL_INSTALL_LOCK_FILE, NERDCTL_DOWNLOAD_BACKOFF_FILE] {
            assert!(!name.is_empty(), "marker filename must not be empty");
            assert!(
                !name.contains('/') && !name.contains('\\'),
                "marker must be a flat filename under data_dir: {name}"
            );
        }
        assert_ne!(NERDCTL_INSTALL_LOCK_FILE, NERDCTL_DOWNLOAD_BACKOFF_FILE);
    }

    // TAURI_WINDOWS_RESOURCES_SUBDIR must match the Desktop's production
    // bundle layout (setup_wizard resolves `<exe_dir>\resources\...`).
    #[test]
    fn tauri_windows_resources_subdir_matches_desktop_layout() {
        let wizard = include_str!("../../../desktop/src-tauri/src/setup_wizard.rs");
        assert!(
            wizard.contains(&format!("join(\"{TAURI_WINDOWS_RESOURCES_SUBDIR}\")")),
            "setup_wizard must resolve the same '{TAURI_WINDOWS_RESOURCES_SUBDIR}' subdir; \
             rename it there too (SSOT alignment)"
        );
    }

    #[test]
    fn test_nerdctl_full_sha256_are_64_hex_chars() {
        for hash in [NERDCTL_FULL_SHA256_AMD64, NERDCTL_FULL_SHA256_ARM64] {
            assert_eq!(hash.len(), 64, "SHA256 must be 64 hex chars, got: {}", hash);
            assert!(
                hash.chars().all(|c| c.is_ascii_hexdigit()),
                "SHA256 must be hex only, got: {}",
                hash
            );
        }
    }

    #[test]
    fn test_mcp_os_log_file_is_non_empty() {
        assert!(
            !MCP_OS_LOG_FILE.is_empty(),
            "MCP_OS_LOG_FILE must not be empty"
        );
    }

    #[test]
    fn test_container_path_includes_local_bin() {
        assert!(
            CONTAINER_PATH.contains("/home/speedwave/.local/bin"),
            "CONTAINER_PATH must include ~/.local/bin for Claude Code"
        );
    }

    #[test]
    fn test_wsl_rootfs_sha256_are_64_hex_chars() {
        for hash in [WSL_ROOTFS_SHA256_AMD64, WSL_ROOTFS_SHA256_ARM64] {
            assert_eq!(hash.len(), 64, "SHA256 must be 64 hex chars, got: {}", hash);
            assert!(
                hash.chars().all(|c| c.is_ascii_hexdigit()),
                "SHA256 must be hex only, got: {}",
                hash
            );
        }
    }

    #[test]
    fn test_built_in_services_does_not_contain_addon() {
        assert!(!BUILT_IN_SERVICES.contains(&"mcp-custom-addon"));
    }

    #[test]
    fn test_toggleable_services_are_subset_of_built_in() {
        for svc in TOGGLEABLE_MCP_SERVICES {
            assert!(
                BUILT_IN_SERVICES.contains(&svc.compose_name),
                "Toggleable service '{}' must be in BUILT_IN_SERVICES",
                svc.compose_name
            );
        }
    }

    #[test]
    fn test_toggleable_services_exclude_claude_and_hub() {
        for svc in TOGGLEABLE_MCP_SERVICES {
            assert_ne!(svc.compose_name, "claude", "claude must not be toggleable");
            assert_ne!(
                svc.compose_name, "mcp-hub",
                "mcp-hub must not be toggleable"
            );
        }
    }

    /// Guard against service-list drift: TOGGLEABLE_MCP_SERVICES count must match
    /// the non-OS bool fields in ResolvedIntegrationsConfig, both directions.
    #[test]
    fn test_toggleable_count_matches_resolved_config_fields() {
        let resolved = crate::config::ResolvedIntegrationsConfig::default();
        // Explicit field enumeration — update when adding/removing MCP fields.
        const EXPECTED_MCP_FIELDS: usize = 9; // slack, sharepoint, redmine, gitlab, github, atlassian, office, playwright, context7
        let _ = (
            resolved.slack,
            resolved.sharepoint,
            resolved.redmine,
            resolved.gitlab,
            resolved.github,
            resolved.atlassian,
            resolved.office,
            resolved.playwright,
            resolved.context7,
        );
        assert_eq!(
            TOGGLEABLE_MCP_SERVICES.len(),
            EXPECTED_MCP_FIELDS,
            "TOGGLEABLE_MCP_SERVICES count ({}) must match ResolvedIntegrationsConfig MCP fields ({}). \
             Did you add a service to one but not the other?",
            TOGGLEABLE_MCP_SERVICES.len(),
            EXPECTED_MCP_FIELDS
        );
        // Verify each service config_key resolves to a known field
        for svc in TOGGLEABLE_MCP_SERVICES {
            assert!(
                resolved.is_service_enabled(svc.config_key).is_some(),
                "TOGGLEABLE_MCP_SERVICES entry '{}' has no matching field in ResolvedIntegrationsConfig",
                svc.config_key
            );
        }
    }

    /// Guard: each descriptor's `worker_env` / `compose_name` literal must equal
    /// the derivation-fn output for its `config_key` (triple-encoded SSOT).
    #[test]
    fn test_toggleable_worker_env_vars_follow_convention() {
        for svc in TOGGLEABLE_MCP_SERVICES {
            assert!(
                svc.worker_env.starts_with("WORKER_"),
                "Worker env var for '{}' must start with WORKER_, got: {}",
                svc.config_key,
                svc.worker_env
            );
            assert!(
                svc.worker_env.ends_with("_URL"),
                "Worker env var for '{}' must end with _URL, got: {}",
                svc.config_key,
                svc.worker_env
            );
            assert_eq!(
                svc.worker_env,
                crate::plugin::derive_worker_env(svc.config_key),
                "worker_env literal for '{}' must equal derive_worker_env(config_key)",
                svc.config_key
            );
            assert_eq!(
                svc.compose_name,
                crate::plugin::derive_compose_name(svc.config_key),
                "compose_name literal for '{}' must equal derive_compose_name(config_key)",
                svc.config_key
            );
        }
    }

    #[test]
    fn test_container_user_constants_are_valid_uid_gid() {
        for (name, value) in [("CONTAINER_USER_UNPRIVILEGED", CONTAINER_USER_UNPRIVILEGED)] {
            let parts: Vec<&str> = value.split(':').collect();
            assert_eq!(
                parts.len(),
                2,
                "{} must be UID:GID format, got: {}",
                name,
                value
            );
            for part in &parts {
                part.parse::<u32>().unwrap_or_else(|_| {
                    panic!("{} components must be numeric, got: {}", name, value)
                });
            }
        }
    }

    #[test]
    fn test_container_uid_gid_parses_ssot() {
        let (uid, gid) = container_uid_gid();
        // Derived from CONTAINER_USER_UNPRIVILEGED, not re-typed.
        let (expect_uid, expect_gid) = {
            let (u, g) = CONTAINER_USER_UNPRIVILEGED.split_once(':').unwrap();
            (u.parse::<u32>().unwrap(), g.parse::<u32>().unwrap())
        };
        assert_eq!(uid, expect_uid);
        assert_eq!(gid, expect_gid);
        // Current value pin — changing the container user is a deliberate act.
        assert_eq!((uid, gid), (1000, 1000));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_wsl_automount_options_uses_ssot_uid() {
        let (uid, gid) = container_uid_gid();
        let opts = wsl_automount_options();
        assert!(opts.contains("metadata"));
        assert!(opts.contains(&format!("uid={uid}")));
        assert!(opts.contains(&format!("gid={gid}")));
    }

    #[test]
    fn test_auth_fields_count_per_service() {
        let expected: &[(&str, usize)] = &[
            // 2 = access_token, refresh_token (both OAuth-managed, ADR-071)
            ("slack", 2),
            // 5 = access_token, refresh_token, client_id, tenant_id, site_id
            // (base_path was dropped — site_id alone scopes the worker)
            ("sharepoint", 5),
            ("redmine", 3),
            ("gitlab", 2),
            ("github", 1),
            ("atlassian", 5),
            ("office", 0),
            ("playwright", 0),
            ("context7", 1),
        ];
        for &(key, count) in expected {
            let svc =
                find_mcp_service(key).unwrap_or_else(|| panic!("service '{}' not found", key));
            assert_eq!(
                svc.auth_fields.len(),
                count,
                "service '{}' expected {} auth fields, got {}",
                key,
                count,
                svc.auth_fields.len()
            );
        }
    }

    #[test]
    fn test_slack_descriptor_is_oauth_shaped() {
        // Pins the ADR-071 shape: both fields OAuth-managed, access_token
        // worker-mounted, refresh_token off-mount, refresh worker enabled.
        let svc = find_mcp_service("slack").unwrap();
        assert!(svc.uses_oauth_refresh);
        assert_eq!(svc.credential_files, &["access_token"]);
        assert_eq!(svc.oauth_state_fields, Some(&["refresh_token"][..]));

        let access = &svc.auth_fields[0];
        assert_eq!(access.key, "access_token");
        assert!(access.oauth_flow);
        assert!(access.is_secret);
        assert!(matches!(access.storage, FieldStorage::WorkerMountedToken));

        let refresh = &svc.auth_fields[1];
        assert_eq!(refresh.key, "refresh_token");
        assert!(refresh.oauth_flow);
        assert!(refresh.is_secret);
        assert!(matches!(refresh.storage, FieldStorage::OAuthState));
    }

    #[test]
    #[allow(clippy::assertions_on_constants)] // SSOT guard: asserts SLACK_OAUTH_REDIRECT_PORT stays sane
    fn test_slack_oauth_consts_are_complete() {
        assert!(!SLACK_OAUTH_CLIENT_ID.is_empty());
        // client_id format: <app>.<id> — two numeric segments.
        assert!(SLACK_OAUTH_CLIENT_ID
            .split('.')
            .all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit())));
        assert_eq!(SLACK_OAUTH_USER_SCOPES.len(), 14);
        // DM support (ADR-071 point 10) — the six im/mpim scopes must stay present.
        for dm_scope in [
            "im:read",
            "im:history",
            "im:write",
            "mpim:read",
            "mpim:history",
            "mpim:write",
        ] {
            assert!(
                SLACK_OAUTH_USER_SCOPES.contains(&dm_scope),
                "missing DM scope: {dm_scope}"
            );
        }
        for scope in SLACK_OAUTH_USER_SCOPES {
            assert!(
                !scope.contains(' ') && !scope.contains(','),
                "scope: {scope}"
            );
        }
        assert!(SLACK_OAUTH_AUTHORIZE_URL.starts_with("https://slack.com/"));
        assert!(SLACK_OAUTH_TOKEN_URL.starts_with("https://slack.com/api/"));
        assert!(SLACK_OAUTH_REDIRECT_PORT > 1024);
    }

    /// Services that intentionally have no credentials (public resources only).
    /// Explicit allowlist so a new service needing auth still fails the test.
    const CREDENTIAL_LESS_SERVICES: &[&str] = &["playwright", "office"];

    #[test]
    fn test_every_service_has_auth_fields() {
        for svc in TOGGLEABLE_MCP_SERVICES {
            if CREDENTIAL_LESS_SERVICES.contains(&svc.config_key) {
                assert!(
                    svc.auth_fields.is_empty(),
                    "service '{}' is in CREDENTIAL_LESS_SERVICES but declares auth fields — \
                     move it out of the allowlist or remove the fields",
                    svc.config_key
                );
                continue;
            }
            assert!(
                !svc.auth_fields.is_empty(),
                "service '{}' must have at least one auth field",
                svc.config_key
            );
        }
    }

    #[test]
    fn test_every_service_has_credential_files() {
        for svc in TOGGLEABLE_MCP_SERVICES {
            if CREDENTIAL_LESS_SERVICES.contains(&svc.config_key) {
                assert!(
                    svc.credential_files.is_empty(),
                    "service '{}' is in CREDENTIAL_LESS_SERVICES but declares credential files",
                    svc.config_key
                );
                continue;
            }
            assert!(
                !svc.credential_files.is_empty(),
                "service '{}' must have at least one credential file",
                svc.config_key
            );
        }
    }

    #[test]
    fn test_auth_field_keys_subset_of_credential_files_or_oauth_state() {
        // Every UI field must land in one storage tier — `credential_files`
        // (mounted) or `oauth_state_fields` (off-mount). ADR-060.
        for svc in TOGGLEABLE_MCP_SERVICES {
            for field in svc.auth_fields {
                let in_creds = svc.credential_files.contains(&field.key);
                let in_oauth = svc
                    .oauth_state_fields
                    .map(|f| f.contains(&field.key))
                    .unwrap_or(false);
                assert!(
                    in_creds || in_oauth,
                    "auth field '{}' for service '{}' is in neither credential_files \
                     {:?} nor oauth_state_fields {:?}",
                    field.key,
                    svc.config_key,
                    svc.credential_files,
                    svc.oauth_state_fields,
                );
                // The FieldStorage tag must agree with the SSOT lists.
                match field.storage {
                    FieldStorage::WorkerMountedToken | FieldStorage::WorkerMountedConfig => {
                        assert!(
                            in_creds,
                            "service '{}': field '{}' tagged worker-mounted but missing from credential_files",
                            svc.config_key, field.key
                        );
                    }
                    FieldStorage::OAuthState | FieldStorage::OAuthStateProviderData => {
                        assert!(
                            in_oauth,
                            "service '{}': field '{}' tagged OAuthState* but missing from oauth_state_fields",
                            svc.config_key, field.key
                        );
                    }
                }
            }
        }
    }

    /// Pinned against TS `microsoftProvider.requiredFields`.
    #[test]
    fn microsoft_provider_data_fields_match_ts_required_fields() {
        let sharepoint = find_mcp_service("sharepoint").expect("sharepoint descriptor exists");
        let mut got: Vec<&str> = sharepoint
            .auth_fields
            .iter()
            .filter(|f| f.storage == FieldStorage::OAuthStateProviderData)
            .map(|f| f.key)
            .collect();
        got.sort();
        assert_eq!(
            got,
            ["client_id", "tenant_id"],
            "SharePoint providerData fields drifted from microsoftProvider.requiredFields"
        );
    }

    #[test]
    fn test_secret_fields_have_password_type() {
        for svc in TOGGLEABLE_MCP_SERVICES {
            for field in svc.auth_fields {
                if field.is_secret {
                    assert_eq!(
                        field.field_type, "password",
                        "secret field '{}' in service '{}' must use field_type 'password'",
                        field.key, svc.config_key
                    );
                } else {
                    assert_ne!(
                        field.field_type, "password",
                        "non-secret field '{}' in service '{}' must not use field_type 'password'",
                        field.key, svc.config_key
                    );
                }
            }
        }
    }

    #[test]
    fn test_stored_in_config_json_only_on_redmine() {
        let redmine = find_mcp_service("redmine").unwrap();
        let config_json_fields: Vec<&str> = redmine
            .auth_fields
            .iter()
            .filter(|f| f.stored_in_config_json)
            .map(|f| f.key)
            .collect();
        assert_eq!(
            config_json_fields,
            vec!["host_url", "project_id"],
            "only Redmine's host_url and project_id should be stored_in_config_json"
        );

        // No other service should have stored_in_config_json fields
        for svc in TOGGLEABLE_MCP_SERVICES {
            if svc.config_key == "redmine" {
                continue;
            }
            for field in svc.auth_fields {
                assert!(
                    !field.stored_in_config_json,
                    "field '{}' in service '{}' should not have stored_in_config_json=true",
                    field.key, svc.config_key
                );
            }
        }
    }

    #[test]
    fn stored_in_config_json_method_matches_storage_tier() {
        // The derived method is the SSOT; the temporary `stored_in_config_json`
        // field must agree with it until the Desktop call sites migrate.
        for svc in TOGGLEABLE_MCP_SERVICES {
            for field in svc.auth_fields {
                assert_eq!(
                    field.stored_in_config_json(),
                    field.storage == FieldStorage::WorkerMountedConfig,
                    "{}.{}: method must derive from storage tier",
                    svc.config_key,
                    field.key
                );
                assert_eq!(
                    field.stored_in_config_json(),
                    field.stored_in_config_json,
                    "{}.{}: derived method and mirror field disagree",
                    svc.config_key,
                    field.key
                );
            }
        }
    }

    #[test]
    fn test_update_check_interval_hours() {
        assert_eq!(UPDATE_CHECK_INTERVAL_HOURS, 24);
        assert_eq!(
            UPDATE_CHECK_INTERVAL_HOURS as u64 * 3600,
            86400,
            "UPDATE_CHECK_INTERVAL_HOURS * 3600 must equal 86400 seconds (24 hours)"
        );
    }

    #[test]
    fn test_oauth_flow_only_on_sharepoint_tokens() {
        let sharepoint = find_mcp_service("sharepoint").unwrap();
        let oauth_fields: Vec<&str> = sharepoint
            .auth_fields
            .iter()
            .filter(|f| f.oauth_flow)
            .map(|f| f.key)
            .collect();
        assert_eq!(
            oauth_fields,
            vec!["access_token", "refresh_token"],
            "SharePoint's oauth_flow fields drifted from the device-code contract"
        );

        let github = find_mcp_service("github").unwrap();
        let gh_oauth_fields: Vec<&str> = github
            .auth_fields
            .iter()
            .filter(|f| f.oauth_flow)
            .map(|f| f.key)
            .collect();
        assert_eq!(gh_oauth_fields, vec!["token"]);

        let oauth_services: std::collections::HashSet<&str> =
            ["sharepoint", "github", "slack"].into_iter().collect();
        for svc in TOGGLEABLE_MCP_SERVICES {
            if oauth_services.contains(svc.config_key) {
                continue;
            }
            for field in svc.auth_fields {
                assert!(
                    !field.oauth_flow,
                    "field '{}' in service '{}' should not have oauth_flow=true",
                    field.key, svc.config_key
                );
            }
        }
    }

    #[test]
    fn test_optional_auth_fields_are_only_where_expected() {
        // Optional auth fields are exception-listed: a service not in this map
        // must have every auth field required.
        let expected: std::collections::HashMap<&str, Vec<&str>> = [
            ("redmine", vec!["project_id"]),
            (
                "atlassian",
                vec!["jira_project_keys", "confluence_space_keys"],
            ),
            // Context7 works in anonymous mode; api_key is the only field and it is optional.
            ("context7", vec!["api_key"]),
        ]
        .into_iter()
        .collect();

        for svc in TOGGLEABLE_MCP_SERVICES {
            let optional_fields: Vec<&str> = svc
                .auth_fields
                .iter()
                .filter(|f| f.optional)
                .map(|f| f.key)
                .collect();
            match expected.get(svc.config_key) {
                Some(want) => assert_eq!(
                    &optional_fields, want,
                    "service '{}' optional fields changed unexpectedly",
                    svc.config_key
                ),
                None => assert!(
                    optional_fields.is_empty(),
                    "service '{}' has unexpected optional auth fields: {optional_fields:?}",
                    svc.config_key
                ),
            }
        }
    }

    #[test]
    fn test_sharepoint_oauth_scopes_contains_required_scopes() {
        assert!(
            SHAREPOINT_OAUTH_SCOPES.contains("Sites.Manage.All"),
            "Sites.Manage.All is required by createList per Microsoft Graph delegated permissions"
        );
        assert!(SHAREPOINT_OAUTH_SCOPES.contains("Files.ReadWrite.All"));
        assert!(SHAREPOINT_OAUTH_SCOPES.contains("offline_access"));
        // Sanity: the legacy narrower scope should NOT be requested as a separate
        // entry — Sites.Manage.All implicitly covers Sites.ReadWrite.All / Sites.Read.All.
        assert!(
            !SHAREPOINT_OAUTH_SCOPES.contains("Sites.Read.All"),
            "Sites.Read.All is a subset of Sites.Manage.All — do not list both"
        );
    }

    /// Every `auth_fields[*].key` must live in `credential_files` OR
    /// `oauth_state_fields` (ADR-060) — else it is silently dropped on save.
    #[test]
    fn test_auth_field_key_has_a_storage_tier() {
        for svc in TOGGLEABLE_MCP_SERVICES {
            for field in svc.auth_fields {
                let in_creds = svc.credential_files.contains(&field.key);
                let in_oauth = svc
                    .oauth_state_fields
                    .map(|f| f.contains(&field.key))
                    .unwrap_or(false);
                assert!(
                    in_creds || in_oauth,
                    "service '{}': auth field '{}' has no storage tier \
                     (neither credential_files {:?} nor oauth_state_fields {:?})",
                    svc.config_key,
                    field.key,
                    svc.credential_files,
                    svc.oauth_state_fields,
                );
            }
        }
    }

    #[test]
    fn test_find_mcp_service_found() {
        assert!(find_mcp_service("slack").is_some());
        assert!(find_mcp_service("sharepoint").is_some());
        assert!(find_mcp_service("redmine").is_some());
        assert!(find_mcp_service("gitlab").is_some());
        assert!(find_mcp_service("github").is_some());
    }

    #[test]
    fn test_find_mcp_service_not_found() {
        assert!(find_mcp_service("unknown").is_none());
        assert!(find_mcp_service("").is_none());
        assert!(find_mcp_service("os").is_none());
    }

    #[test]
    fn test_built_in_service_ids_no_overlap_with_built_in_services() {
        // Verify that no service_id in BUILT_IN_SERVICE_IDS appears in BUILT_IN_SERVICES
        // (they use different naming: "slack" vs "mcp-slack")
        for sid in BUILT_IN_SERVICE_IDS {
            assert!(
                !BUILT_IN_SERVICES.contains(sid),
                "BUILT_IN_SERVICE_IDS entry '{sid}' collides with BUILT_IN_SERVICES"
            );
        }
    }

    #[test]
    fn test_built_in_service_ids_covers_all_toggleable_services() {
        // SSOT: every TOGGLEABLE_MCP_SERVICES config_key must be in BUILT_IN_SERVICE_IDS (plugin blocklist).
        for svc in TOGGLEABLE_MCP_SERVICES {
            assert!(
                BUILT_IN_SERVICE_IDS.contains(&svc.config_key),
                "TOGGLEABLE_MCP_SERVICES entry '{}' is missing from BUILT_IN_SERVICE_IDS \
                 — plugins could shadow it; add it to the blocklist",
                svc.config_key
            );
        }
    }

    #[test]
    #[allow(clippy::assertions_on_constants)] // SSOT guard: asserts WSL_SERVICE_START_DELAY_SECS stays sane
    fn test_wsl_service_start_delay_is_positive() {
        assert!(
            WSL_SERVICE_START_DELAY_SECS > 0,
            "WSL_SERVICE_START_DELAY_SECS must be positive"
        );
    }

    #[test]
    #[allow(clippy::assertions_on_constants)] // SSOT guard: asserts WSL_SERVICE_CHECK_MAX_RETRIES stays sane
    fn test_wsl_service_check_max_retries_is_positive() {
        assert!(
            WSL_SERVICE_CHECK_MAX_RETRIES > 0,
            "WSL_SERVICE_CHECK_MAX_RETRIES must be positive"
        );
    }

    #[test]
    fn test_toggleable_os_services_count() {
        assert_eq!(
            TOGGLEABLE_OS_SERVICES.len(),
            4,
            "TOGGLEABLE_OS_SERVICES should contain exactly 4 services"
        );
    }

    #[test]
    fn test_toggleable_os_services_have_unique_keys() {
        let mut keys: Vec<&str> = TOGGLEABLE_OS_SERVICES
            .iter()
            .map(|s| s.config_key)
            .collect();
        let count_before = keys.len();
        keys.sort();
        keys.dedup();
        assert_eq!(
            keys.len(),
            count_before,
            "TOGGLEABLE_OS_SERVICES config keys must be unique"
        );
    }

    #[test]
    fn test_toggleable_os_services_have_display_names() {
        for svc in TOGGLEABLE_OS_SERVICES {
            assert!(
                !svc.display_name.is_empty(),
                "OS service '{}' must have a display name",
                svc.config_key
            );
            assert!(
                !svc.description.is_empty(),
                "OS service '{}' must have a description",
                svc.config_key
            );
        }
    }

    /// Guard against OS service list drift: TOGGLEABLE_OS_SERVICES count must match
    /// the number of os_ boolean fields in ResolvedIntegrationsConfig.
    #[test]
    fn test_toggleable_os_count_matches_resolved_config_fields() {
        let resolved = crate::config::ResolvedIntegrationsConfig::default();
        const EXPECTED_OS_FIELDS: usize = 4; // os_reminders, os_calendar, os_mail, os_notes
        let _ = (
            resolved.os_reminders,
            resolved.os_calendar,
            resolved.os_mail,
            resolved.os_notes,
        );
        assert_eq!(
            TOGGLEABLE_OS_SERVICES.len(),
            EXPECTED_OS_FIELDS,
            "TOGGLEABLE_OS_SERVICES count ({}) must match ResolvedIntegrationsConfig OS fields ({}). \
             Did you add a service to one but not the other?",
            TOGGLEABLE_OS_SERVICES.len(),
            EXPECTED_OS_FIELDS
        );
        for svc in TOGGLEABLE_OS_SERVICES {
            assert!(
                resolved.is_os_service_enabled(svc.config_key).is_some(),
                "TOGGLEABLE_OS_SERVICES entry '{}' has no matching field in ResolvedIntegrationsConfig",
                svc.config_key
            );
        }
    }

    #[test]
    fn test_claude_session_log_file_is_non_empty() {
        assert!(
            !CLAUDE_SESSION_LOG_FILE.is_empty(),
            "CLAUDE_SESSION_LOG_FILE must not be empty"
        );
    }

    #[test]
    fn test_claude_session_log_path_in_builds_correct_path() {
        let home = std::path::Path::new("/fake/home");
        let path = claude_session_log_path_in(home, "myproject");
        assert_eq!(
            path,
            std::path::PathBuf::from("/fake/home/.speedwave/logs/myproject/claude-session.log")
        );
    }

    #[test]
    fn test_claude_session_log_path_in_different_project() {
        let home = std::path::Path::new("/home/user");
        let path = claude_session_log_path_in(home, "proj.v1");
        assert_eq!(
            path,
            std::path::PathBuf::from("/home/user/.speedwave/logs/proj.v1/claude-session.log")
        );
    }

    #[test]
    fn mcp_os_log_path_ends_with_data_dir_and_log_file() {
        let path = mcp_os_log_path();
        assert!(
            path.ends_with(MCP_OS_LOG_FILE),
            "mcp_os_log_path must end with MCP_OS_LOG_FILE, got {path:?}"
        );
        assert_eq!(
            path,
            data_dir().join(MCP_OS_LOG_FILE),
            "mcp_os_log_path is the SSOT for data_dir()/MCP_OS_LOG_FILE"
        );
    }

    #[test]
    fn test_data_dir_from_default() {
        let home = std::path::Path::new("/fake/home");
        assert_eq!(
            data_dir_from(None, home),
            std::path::PathBuf::from("/fake/home/.speedwave")
        );
    }

    #[test]
    fn test_data_dir_from_empty_string_treated_as_unset() {
        let home = std::path::Path::new("/fake/home");
        assert_eq!(
            data_dir_from(Some(""), home),
            std::path::PathBuf::from("/fake/home/.speedwave")
        );
    }

    #[test]
    fn test_data_dir_from_absolute_path() {
        let home = std::path::Path::new("/fake/home");
        assert_eq!(
            data_dir_from(Some("/opt/sw-dev"), home),
            std::path::PathBuf::from("/opt/sw-dev")
        );
    }

    #[test]
    #[should_panic(expected = "must be an absolute path")]
    fn test_data_dir_from_relative_path_panics() {
        let home = std::path::Path::new("/fake/home");
        data_dir_from(Some("relative/path"), home);
    }

    #[test]
    #[should_panic(expected = "must be an absolute path")]
    fn test_data_dir_from_tilde_path_panics() {
        let home = std::path::Path::new("/fake/home");
        data_dir_from(Some("~/foo"), home);
    }

    #[test]
    fn test_data_dir_from_absolute_path_with_trailing_slash() {
        let home = std::path::Path::new("/fake/home");
        let result = data_dir_from(Some("/tmp/foo/"), home);
        // PathBuf preserves trailing slash but path resolution works the same
        assert!(result.starts_with("/tmp/foo"));
    }

    #[test]
    fn cli_install_path_for_unix_ignores_data_dir() {
        let home = std::path::Path::new("/Users/alice");
        let expected = "/Users/alice/.local/bin/speedwave";
        assert_eq!(
            cli_install_path_for(false, home, std::path::Path::new("/Users/alice/.speedwave")),
            expected
        );
        assert_eq!(
            cli_install_path_for(
                false,
                home,
                std::path::Path::new("/Users/alice/.speedwave-dev")
            ),
            expected,
            "unix path must ignore data_dir (install is ~/.local/bin regardless)"
        );
    }

    #[test]
    fn cli_install_path_for_windows_uses_backslashes() {
        let home = std::path::Path::new("C:\\Users\\alice");
        assert_eq!(
            cli_install_path_for(
                true,
                home,
                std::path::Path::new("C:\\Users\\alice\\.speedwave")
            ),
            "C:\\Users\\alice\\.speedwave\\bin\\speedwave.exe",
            "windows path must use backslashes so it is host-independent on the CI host"
        );
    }

    #[test]
    fn cli_binary_filename_is_single_sourced_from_cli_binary() {
        assert_eq!(cli_binary_filename(false), CLI_BINARY);
        assert_eq!(cli_binary_filename(true), format!("{CLI_BINARY}.exe"));
        // Concrete values today, so a rename that breaks the format is visible.
        assert_eq!(cli_binary_filename(false), "speedwave");
        assert_eq!(cli_binary_filename(true), "speedwave.exe");
    }

    #[test]
    fn test_derive_instance_name_strips_leading_dot() {
        assert_eq!(
            derive_instance_name_from(std::path::Path::new("/home/user/.speedwave")),
            "speedwave"
        );
    }

    #[test]
    fn test_derive_instance_name_strips_dot_keeps_suffix() {
        assert_eq!(
            derive_instance_name_from(std::path::Path::new("/home/user/.speedwave-dev")),
            "speedwave-dev"
        );
    }

    #[test]
    fn test_derive_instance_name_no_dot() {
        assert_eq!(
            derive_instance_name_from(std::path::Path::new("/some/path/mydata")),
            "mydata"
        );
    }

    #[test]
    #[should_panic(expected = "must have a non-empty basename")]
    fn test_derive_instance_name_root_panics() {
        derive_instance_name_from(std::path::Path::new("/"));
    }

    #[test]
    fn test_derive_wsl_distro_name_production_default() {
        assert_eq!(
            derive_wsl_distro_name_from(std::path::Path::new("/home/user/.speedwave")),
            "Speedwave"
        );
    }

    #[test]
    fn test_derive_wsl_distro_name_dev_default() {
        assert_eq!(
            derive_wsl_distro_name_from(std::path::Path::new("/home/user/.speedwave-dev")),
            "Speedwave-dev"
        );
    }

    #[test]
    fn test_derive_wsl_distro_name_custom_basename() {
        assert_eq!(
            derive_wsl_distro_name_from(std::path::Path::new("/opt/sw-test")),
            "Speedwave-sw-test"
        );
    }

    #[test]
    fn test_derive_wsl_distro_name_strips_speedwave_prefix() {
        // `.speedwave-anything` → `Speedwave-anything`, not `Speedwave-speedwave-anything`.
        assert_eq!(
            derive_wsl_distro_name_from(std::path::Path::new("/home/user/.speedwave-staging")),
            "Speedwave-staging"
        );
    }

    #[test]
    fn test_derive_instance_name_trailing_slash_normalised() {
        // Rust Path normalises trailing slashes: "/some/path/" → basename "path"
        assert_eq!(
            derive_instance_name_from(std::path::Path::new("/some/speedwave-dev/")),
            "speedwave-dev"
        );
    }

    #[test]
    #[should_panic(expected = "must match")]
    fn test_derive_instance_name_unicode_panics() {
        derive_instance_name_from(std::path::Path::new("/path/spëëdwavé"));
    }

    #[test]
    #[should_panic(expected = "must match")]
    fn test_derive_instance_name_uppercase_panics() {
        derive_instance_name_from(std::path::Path::new("/path/.Speedwave-Dev"));
    }

    #[test]
    #[should_panic(expected = "must match")]
    fn test_derive_instance_name_spaces_panics() {
        derive_instance_name_from(std::path::Path::new("/path/my data"));
    }

    #[test]
    #[should_panic(expected = "must match")]
    fn test_derive_instance_name_dots_in_name_panics() {
        derive_instance_name_from(std::path::Path::new("/path/my.data.dir"));
    }

    #[test]
    #[should_panic(expected = "must match")]
    fn test_derive_instance_name_leading_hyphen_panics() {
        derive_instance_name_from(std::path::Path::new("/path/-mydata"));
    }

    #[test]
    fn test_derive_instance_name_max_length_64() {
        let name = "a".repeat(64);
        let path_str = format!("/path/{name}");
        assert_eq!(
            derive_instance_name_from(std::path::Path::new(&path_str)),
            name
        );
    }

    #[test]
    #[should_panic(expected = "must match")]
    fn test_derive_instance_name_65_chars_panics() {
        let name = "a".repeat(65);
        let path_str = format!("/path/{name}");
        derive_instance_name_from(std::path::Path::new(&path_str));
    }

    /// Guard: SYSTEM_CHECK_FAILED_PREFIX must not change without updating
    /// the frontend match in project-state.service.ts (startsWith check).
    #[test]
    fn test_system_check_failed_prefix_is_stable() {
        assert_eq!(
            SYSTEM_CHECK_FAILED_PREFIX, "System check failed:",
            "Changing this prefix silently breaks the Desktop UI — \
             update project-state.service.ts startsWith check to match"
        );
    }

    /// Guard: CLOUDSTORAGE_TCC_PREFIX must be non-empty and end with ": ".
    #[test]
    fn test_cloudstorage_tcc_prefix_is_non_empty_and_ends_with_colon_space() {
        assert!(!CLOUDSTORAGE_TCC_PREFIX.is_empty());
        assert!(
            CLOUDSTORAGE_TCC_PREFIX.ends_with(": "),
            "CLOUDSTORAGE_TCC_PREFIX must end with ': ' for consistent parsing, got: {:?}",
            CLOUDSTORAGE_TCC_PREFIX
        );
    }

    /// Guard: the two error prefixes must be disjoint — neither is a prefix of the other.
    /// This prevents a single `starts_with` check from accidentally matching both.
    #[test]
    fn test_cloudstorage_and_system_check_prefixes_are_disjoint() {
        assert!(
            !CLOUDSTORAGE_TCC_PREFIX.starts_with(SYSTEM_CHECK_FAILED_PREFIX),
            "CLOUDSTORAGE_TCC_PREFIX must not start with SYSTEM_CHECK_FAILED_PREFIX"
        );
        assert!(
            !SYSTEM_CHECK_FAILED_PREFIX.starts_with(CLOUDSTORAGE_TCC_PREFIX),
            "SYSTEM_CHECK_FAILED_PREFIX must not start with CLOUDSTORAGE_TCC_PREFIX"
        );
    }

    #[test]
    #[allow(clippy::assertions_on_constants)] // SSOT guard: asserts EXIT_CLEANUP_TIMEOUT_SECS stays sane
    fn test_exit_cleanup_timeout_is_positive() {
        assert!(
            EXIT_CLEANUP_TIMEOUT_SECS > 0,
            "EXIT_CLEANUP_TIMEOUT_SECS must be positive"
        );
    }

    #[test]
    #[allow(clippy::assertions_on_constants)] // SSOT guard: asserts LIMA_VM_STOP_TIMEOUT_SECS stays sane
    fn test_lima_vm_stop_timeout_is_positive() {
        assert!(
            LIMA_VM_STOP_TIMEOUT_SECS > 0,
            "LIMA_VM_STOP_TIMEOUT_SECS must be positive"
        );
    }

    /// SSOT pair: the provisioning-start budget is derived from the Desktop
    /// image-rebuild wait (`RECONCILE_WAIT_TIMEOUT` in containers_cmd.rs).
    #[test]
    fn lima_provision_start_timeout_matches_desktop_reconcile_wait_budget() {
        let src = include_str!("../../../desktop/src-tauri/src/containers_cmd.rs");
        let re = regex::Regex::new(r"RECONCILE_WAIT_TIMEOUT[^;]*?from_secs\((\d+)\)").unwrap();
        let cap = re
            .captures(src)
            .expect("containers_cmd.rs must declare RECONCILE_WAIT_TIMEOUT via from_secs(N)");
        let desktop_budget: u64 = cap[1].parse().unwrap();
        assert_eq!(
            LIMA_VM_PROVISION_START_TIMEOUT_SECS, desktop_budget,
            "LIMA_VM_PROVISION_START_TIMEOUT_SECS must match the Desktop \
             RECONCILE_WAIT_TIMEOUT budget it is derived from"
        );
    }

    /// Error-path quality: the provisioning hint must name the likely cause
    /// (tooling download) and the remedy (network + retry).
    #[test]
    fn lima_provision_hint_names_cause_and_remedy() {
        assert!(LIMA_START_PROVISION_HINT.contains("nerdctl-full"));
        assert!(LIMA_START_PROVISION_HINT.contains("internet connection"));
        assert!(LIMA_START_PROVISION_HINT.contains("retry"));
    }

    #[test]
    fn test_playwright_has_beta_badge() {
        let svc = find_mcp_service("playwright").expect("playwright service must exist");
        assert_eq!(svc.badge, Some("BETA"));
    }

    #[test]
    fn test_credential_services_have_no_badge() {
        // Exception: all-optional-credential services may carry an info badge
        // ("Anonymous") overridden dynamically. See context7's descriptor.
        for svc in TOGGLEABLE_MCP_SERVICES {
            if svc.auth_fields.is_empty() {
                continue;
            }
            let all_optional = svc.auth_fields.iter().all(|f| f.optional);
            if all_optional {
                continue;
            }
            assert_eq!(
                svc.badge, None,
                "service '{}' with required credentials should not have a badge",
                svc.config_key
            );
        }
    }

    // SSOT alignment guards (CLAUDE.md "WSL distro name" row): pin the
    // production literal "Speedwave" across installer, E2E script, install guide.

    const PRODUCTION_WSL_DISTRO: &str = "Speedwave";

    #[test]
    fn production_wsl_distro_name_is_default() {
        // Sanity check that the literal below matches what
        // `derive_wsl_distro_name_from` produces for the production data_dir.
        assert_eq!(
            derive_wsl_distro_name_from(std::path::Path::new("/home/user/.speedwave")),
            PRODUCTION_WSL_DISTRO
        );
    }

    #[test]
    fn wsl_distro_name_appears_in_installer_hooks() {
        // Hand-edited source. The committed installer-hooks.nsh is generated
        // from this template + sweep.ps1 + firewall.ps1 — see CLAUDE.md.
        let src = include_str!("../../../desktop/src-tauri/windows/installer-hooks-template.nsh");
        assert!(
            src.contains(PRODUCTION_WSL_DISTRO),
            "production WSL distro name ({PRODUCTION_WSL_DISTRO}) not found in \
             installer-hooks-template.nsh; rename it there too (CLAUDE.md SSOT alignment)"
        );
    }

    #[test]
    fn wsl_distro_name_appears_in_e2e_vm_script() {
        let src = include_str!("../../../scripts/e2e-vm.sh");
        assert!(
            src.contains(PRODUCTION_WSL_DISTRO),
            "production WSL distro name ({PRODUCTION_WSL_DISTRO}) not found in \
             scripts/e2e-vm.sh; rename it there too (CLAUDE.md SSOT alignment)"
        );
    }

    #[test]
    fn wsl_distro_name_appears_in_installation_doc() {
        let src = include_str!("../../../docs/getting-started/installation.md");
        assert!(
            src.contains(PRODUCTION_WSL_DISTRO),
            "production WSL distro name ({PRODUCTION_WSL_DISTRO}) not found in \
             docs/getting-started/installation.md; rename it there too \
             (CLAUDE.md SSOT alignment)"
        );
    }

    #[test]
    fn data_dir_appears_in_installer_hooks_template() {
        // DATA_DIR = ".speedwave"; the NSIS hook hard-codes "$PROFILE\.speedwave"
        // in the hand-edited template.
        let src = include_str!("../../../desktop/src-tauri/windows/installer-hooks-template.nsh");
        assert!(
            src.contains(DATA_DIR),
            "DATA_DIR ({DATA_DIR}) not found in installer-hooks-template.nsh; \
             rename it there too (CLAUDE.md SSOT alignment)"
        );
    }

    #[test]
    fn nodejs_subdir_appears_in_sweep_script() {
        // NODEJS_SUBDIR = "nodejs"; the sweep script filters processes whose
        // ExecutablePath starts with $instDir\nodejs\.
        let src = include_str!("../../../desktop/src-tauri/windows/sweep.ps1");
        assert!(
            src.contains(NODEJS_SUBDIR),
            "NODEJS_SUBDIR ({NODEJS_SUBDIR}) not found in sweep.ps1; \
             rename it there too (ADR-048 SSOT alignment)"
        );
    }

    #[test]
    fn nerdctl_version_appears_in_e2e_vm_script() {
        // SSOT-alignment (CLAUDE.md): the E2E script hardcodes the nerdctl-full
        // URL (PS literal); a version bump must update it too.
        let src = include_str!("../../../scripts/e2e-vm.sh");
        let needle = format!("nerdctl-full-{NERDCTL_FULL_VERSION}-linux");
        assert!(
            src.contains(&needle),
            "scripts/e2e-vm.sh must reference nerdctl-full {NERDCTL_FULL_VERSION} \
             ('{needle}'); bump the URL there too"
        );
        assert!(
            src.contains(&format!("/v{NERDCTL_FULL_VERSION}/")),
            "scripts/e2e-vm.sh release path must be /v{NERDCTL_FULL_VERSION}/"
        );
    }

    /// Lima version → bundled nerdctl-full (macOS SSOT guard). Bumping
    /// `.lima-version` off-table fails until you add the entry + align the const.
    #[test]
    fn lima_version_and_nerdctl_full_version_are_aligned() {
        // Known Lima release → nerdctl-full version it bundles.
        // Source: https://github.com/lima-vm/lima/blob/vX.Y.Z/pkg/limayaml/containerd.yaml
        let known: &[(&str, &str)] = &[
            ("2.1.2", "2.2.2"), // Lima 2.1.2 bundles nerdctl-full 2.2.2 (verified in acc2c691)
            ("2.2.0", "2.2.2"),
            ("2.2.1", "2.2.2"),
            ("2.2.2", "2.2.2"),
            ("2.3.0", "2.3.0"),
        ];
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let lima_ver = std::fs::read_to_string(repo_root.join(".lima-version"))
            .expect(".lima-version must exist")
            .trim()
            .to_owned();
        let expected_nerdctl = known
            .iter()
            .find(|(lima, _)| *lima == lima_ver)
            .map(|(_, nerdctl)| *nerdctl)
            .unwrap_or_else(|| {
                panic!(
                    ".lima-version is '{lima_ver}' which is not in the known alignment table; \
                 look up what nerdctl-full Lima {lima_ver} bundles \
                 (pkg/limayaml/containerd.yaml at that tag), add the entry to this table, \
                 and set NERDCTL_FULL_VERSION to match"
                )
            });
        assert_eq!(
            NERDCTL_FULL_VERSION, expected_nerdctl,
            "Lima {lima_ver} bundles nerdctl-full {expected_nerdctl} but \
             NERDCTL_FULL_VERSION is '{NERDCTL_FULL_VERSION}'; \
             update NERDCTL_FULL_VERSION (and SHA256s) to match"
        );
    }

    // Cross-language SSOT for HOST_GATEWAY_ALIAS: TS MCP-shared mirrors it as
    // `export const`; compose template references the literal in `extra_hosts`.

    #[test]
    fn host_gateway_alias_matches_mcp_shared_ts() {
        let src = include_str!("../../../mcp-servers/shared/src/security.ts");
        let re = regex::Regex::new(r#"export\s+const\s+HOST_GATEWAY_ALIAS\s*=\s*['"]([^'"]+)['"]"#)
            .unwrap();
        let cap = re.captures(src).expect(
            "mcp-servers/shared/src/security.ts must declare `export const HOST_GATEWAY_ALIAS`",
        );
        assert_eq!(
            &cap[1], HOST_GATEWAY_ALIAS,
            "TS HOST_GATEWAY_ALIAS must match Rust consts::HOST_GATEWAY_ALIAS"
        );
    }

    #[test]
    fn slack_token_url_matches_oauth_worker_provider_ts() {
        // SSOT pair: consts::SLACK_OAUTH_TOKEN_URL (exchange side) mirrors
        // SLACK_TOKEN_URL in mcp-servers/oauth providers/slack.ts (refresh side).
        let src = include_str!("../../../mcp-servers/oauth/src/providers/slack.ts");
        let re = regex::Regex::new(r#"const\s+SLACK_TOKEN_URL\s*=\s*['"]([^'"]+)['"]"#).unwrap();
        let cap = re.captures(src).expect(
            "mcp-servers/oauth/src/providers/slack.ts must declare `const SLACK_TOKEN_URL`",
        );
        assert_eq!(
            &cap[1], SLACK_OAUTH_TOKEN_URL,
            "TS SLACK_TOKEN_URL must match Rust consts::SLACK_OAUTH_TOKEN_URL"
        );
    }

    #[test]
    fn host_gateway_alias_appears_in_compose_template() {
        let src = include_str!("../../../containers/compose.template.yml");
        let expected = format!(r#"- "{HOST_GATEWAY_ALIAS}:${{HOST_GATEWAY}}""#);
        assert!(
            src.lines().any(|l| l.trim() == expected),
            "compose.template.yml must contain '{expected}' in extra_hosts"
        );
    }

    // Cross-language SSOT: plugin.rs `SLUG_PATTERN` mirrored in the oauth worker
    // as `SERVICE_SLUG_RE` — extract both literals and compare.
    #[test]
    fn plugin_slug_pattern_matches_oauth_state_ts() {
        let plugin_src = include_str!("../../../crates/speedwave-runtime/src/plugin.rs");
        let slug_re = regex::Regex::new(r#"const SLUG_PATTERN: &str = r"([^"]+)";"#).unwrap();
        let rust_pattern = &slug_re
            .captures(plugin_src)
            .expect("plugin.rs must declare `const SLUG_PATTERN`")[1];

        let ts_src = include_str!("../../../mcp-servers/oauth/src/oauth-state.ts");
        let ts_re = regex::Regex::new(r"const SERVICE_SLUG_RE = /(.+?)/;").unwrap();
        let ts_pattern = &ts_re
            .captures(ts_src)
            .expect("oauth-state.ts must declare `const SERVICE_SLUG_RE`")[1];

        assert_eq!(
            ts_pattern, rust_pattern,
            "oauth-state.ts SERVICE_SLUG_RE must mirror plugin.rs SLUG_PATTERN"
        );
    }

    // Guard: only SharePoint `site_id` carries a hint today — a deliberate edit
    // should be needed to change that.
    #[test]
    fn only_sharepoint_site_id_has_hint() {
        for svc in TOGGLEABLE_MCP_SERVICES {
            for field in svc.auth_fields {
                let expected_some = svc.config_key == "sharepoint" && field.key == "site_id";
                assert_eq!(
                    field.hint.is_some(),
                    expected_some,
                    "auth field {}.{}: hint={:?} but expected_some={}",
                    svc.config_key,
                    field.key,
                    field.hint,
                    expected_some
                );
            }
        }
    }

    // Guard: every dir under claude-resources/<type>/integrations/ must match a
    // service key, else the entrypoint never links it.
    #[test]
    fn integrations_directories_match_known_service_keys() {
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .expect("repo root resolves three levels above the runtime crate");
        let resources_root = repo_root.join("containers").join("claude-resources");

        // Allowed names: TOGGLEABLE_MCP_SERVICES + OS sub-services. `oauth`/`ide`
        // are excluded — not user-toggleable, no per-integration resources.
        let mut allowed: std::collections::HashSet<&str> = TOGGLEABLE_MCP_SERVICES
            .iter()
            .map(|s| s.config_key)
            .collect();
        for sub in TOGGLEABLE_OS_SERVICES {
            allowed.insert(sub.config_key);
        }

        for resource_type in ["skills", "commands", "agents", "hooks"] {
            let integrations_dir = resources_root.join(resource_type).join("integrations");
            if !integrations_dir.is_dir() {
                continue;
            }
            for entry in std::fs::read_dir(&integrations_dir).expect("read integrations directory")
            {
                let entry = entry.expect("dir entry");
                if !entry.file_type().expect("file type").is_dir() {
                    continue;
                }
                let name = entry.file_name();
                let key = name.to_str().expect("non-UTF8 directory name");
                assert!(
                    allowed.contains(key),
                    "containers/claude-resources/{resource_type}/integrations/{key}/ \
                     does not match any TOGGLEABLE_MCP_SERVICES.config_key or \
                     TOGGLEABLE_OS_SERVICES.config_key — the \
                     entrypoint would never link it. Rename the directory or \
                     add a corresponding descriptor."
                );
            }
        }
    }

    #[test]
    fn strip_compose_container_prefix_removes_runtime_project_prefix() {
        // Build the input from the live `compose_prefix()` so the test is
        // independent of `SPEEDWAVE_DATA_DIR`.
        let prefix = compose_prefix();
        let input = format!("{prefix}_acme_mcp_hub");
        let out = strip_compose_container_prefix(&input, "acme");
        assert_eq!(out, "mcp_hub");
    }

    #[test]
    fn strip_compose_container_prefix_handles_multi_segment_project() {
        let prefix = compose_prefix();
        let input = format!("{prefix}_dev_downloads_mcp_office");
        let out = strip_compose_container_prefix(&input, "dev_downloads");
        assert_eq!(out, "mcp_office");
    }

    #[test]
    fn strip_compose_container_prefix_leaves_unrelated_name_unchanged() {
        let out = strip_compose_container_prefix("other_unrelated_thing", "acme");
        assert_eq!(out, "other_unrelated_thing");
    }
}
