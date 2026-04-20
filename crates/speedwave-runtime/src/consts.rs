pub const APP_NAME: &str = "speedwave";
pub const DATA_DIR_ENV: &str = "SPEEDWAVE_DATA_DIR";
pub const LIMA_VM_NAME: &str = "speedwave";
pub const LIMA_SUBDIR: &str = "lima";
pub const DATA_DIR: &str = ".speedwave";
pub const CLI_BINARY: &str = "speedwave";
pub const COMPOSE_PREFIX: &str = "speedwave";
/// Port on which `mcp-hub` listens inside the compose network.
///
/// This is the single external contract: the `claude` container reaches the
/// hub at `http://mcp-hub:4000`. See ADR-038.
pub const PORT_BASE: u16 = 4000;

/// Port on which every MCP worker listens inside its own container.
///
/// All workers — built-in services (slack, sharepoint, redmine, gitlab)
/// and plugin workers — share this port. Each container has its own
/// network namespace, so port reuse is safe; the compose network
/// disambiguates by DNS service name
/// (`http://mcp-slack:3000`, `http://mcp-gitlab:3000`, etc.).
///
/// See ADR-038 for the rationale behind the single-internal-port model.
pub const PORT_WORKER: u16 = 3000;
pub const MCP_OS_AUTH_TOKEN_FILE: &str = "mcp-os-auth-token";
pub const MCP_OS_PORT_FILE: &str = "mcp-os-port";
pub const MCP_OS_PID_FILE: &str = "mcp-os-pid";
pub const MCP_OS_LOG_FILE: &str = "mcp-os.log";
pub const CLAUDE_SESSION_LOG_FILE: &str = "claude-session.log";
pub const CLAUDE_BINARY: &str = "/usr/local/bin/claude";

/// PATH set inside containers for the `speedwave` user.
/// Claude Code installs to `~/.local/bin`, so it must be on PATH.
pub const CONTAINER_PATH: &str = "/home/speedwave/.local/bin:/usr/local/bin:/usr/bin:/bin";

/// Hostname reachable from inside Lima VM pointing to the macOS host.
pub const LIMA_HOST: &str = "host.lima.internal";
/// Hostname reachable from inside nerdctl rootless containers pointing to the Linux host.
pub const NERDCTL_LINUX_HOST: &str = "host.docker.internal";
/// Hostname reachable from inside WSL2/nerdctl containers pointing to the Windows host.
pub const WSL_HOST: &str = "host.speedwave.internal";
/// Podman-compatibility alias injected via `extra_hosts` in compose.template.yml.
/// Containers use this when built for environments that expect the Podman convention.
pub const CONTAINERS_HOST: &str = "host.containers.internal";

/// All hostnames resolved inside containers to the host gateway via `extra_hosts`
/// in `compose.template.yml`. Used by host-side code (Desktop settings) that needs
/// to probe the same endpoint a container would hit: each alias is rewritten to
/// `127.0.0.1` before a local HTTP probe because the aliases are not present in
/// the host's resolver (Lima/WSL2/rootless nerdctl inject them only inside the VM).
pub const CONTAINER_HOST_ALIASES: &[&str] =
    &[LIMA_HOST, NERDCTL_LINUX_HOST, WSL_HOST, CONTAINERS_HOST];

/// IP of the macOS host as seen from inside nerdctl containers in the Lima vzNAT network.
/// Lima vzNAT always assigns 192.168.5.2 to the host — this is static, not DHCP.
pub const LIMA_VZ_HOST_IP: &str = "192.168.5.2";
/// IP of the Linux host as seen from inside rootless nerdctl containers (slirp4netns gateway).
pub const NERDCTL_LINUX_HOST_IP: &str = "10.0.2.2";
/// IP of the Windows host as seen from inside WSL2 containers.
pub const WSL_HOST_IP: &str = "192.168.65.1";

/// Container user for unprivileged mode (macOS Lima, Windows WSL2).
/// containerd runs as root → UID 1000 maps to UID 1000 on host.
pub const CONTAINER_USER_UNPRIVILEGED: &str = "1000:1000";
/// Container user for rootless nerdctl (Linux native).
/// In rootless mode, UID 0 in container maps to the host user's UID.
/// UID 1000 would map to subuid range (~101000) and cannot access bind mounts.
/// Security maintained by: cap_drop ALL, no-new-privileges, read_only, user namespace.
pub const CONTAINER_USER_ROOTLESS: &str = "0:0";

/// Subdirectory within resources for nerdctl-full binaries.
pub const NERDCTL_FULL_SUBDIR: &str = "nerdctl-full";

/// Subdirectory within resources for the bundled Node.js binary.
pub const NODEJS_SUBDIR: &str = "nodejs";

/// WSL2 distribution name used by Speedwave on Windows.
pub const WSL_DISTRO_NAME: &str = "Speedwave";

/// nerdctl-full bundle version installed inside WSL2 on Windows.
/// Contains containerd + nerdctl + CNI plugins + BuildKit.
pub const NERDCTL_FULL_VERSION: &str = "2.1.2";

/// SHA256 checksums for the nerdctl-full bundle downloads.
/// Source: https://github.com/containerd/nerdctl/releases/download/v2.1.2/SHA256SUMS
/// Update these when bumping NERDCTL_FULL_VERSION above.
pub const NERDCTL_FULL_SHA256_AMD64: &str =
    "b3ab8564c8fa6feb89d09bee881211b700b047373c767bec38256d0d68f93074";
pub const NERDCTL_FULL_SHA256_ARM64: &str =
    "1b52f32b7d5bbf63005bceb6a3cacd237d2fa8f1d05bb590e8ce58731779b9ee";

/// Ubuntu rootfs download URLs for WSL2 import (per-architecture).
/// Uses the `releases/24.04/current` path (latest daily build of 24.04 LTS).
/// SHA256 checksums below pin the exact rootfs version — update both URL and SHA256 when bumping.
/// See issue #183 for planned migration to a self-built rootfs.
pub const WSL_ROOTFS_URL_AMD64: &str =
    "https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-amd64-24.04lts.rootfs.tar.gz";
pub const WSL_ROOTFS_URL_ARM64: &str =
    "https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-arm64-24.04lts.rootfs.tar.gz";

/// SHA256 checksums for the WSL2 rootfs downloads.
/// Update these when bumping the rootfs version above.
pub const WSL_ROOTFS_SHA256_AMD64: &str =
    "2a790896740b14d637dbdc583cce1ba081ac53b9e9cdb46dc09a2f73abbd9934";
pub const WSL_ROOTFS_SHA256_ARM64: &str =
    "e113b8c49af3ab49b992b8e29550fc921e689f211abc338176f8243786173a32";

/// Environment variable set by the Tauri app to point at bundled resources.
/// Used by `binary::resolve_binary()`, `build::resolve_build_root()`, and
/// the Desktop's `resolve_mcp_os_script()`.
pub const BUNDLE_RESOURCES_ENV: &str = "SPEEDWAVE_RESOURCES_DIR";

/// Marker file name written by the Desktop app inside `~/.speedwave/`.
/// The CLI reads it to locate bundled resources without the env var.
pub const RESOURCES_MARKER: &str = "resources-dir";

/// Error message returned when `newuidmap` is not found on the system.
/// Used by both `NerdctlRuntime::ensure_ready()` and `setup_wizard::init_vm_linux()`.
pub const UIDMAP_MISSING_MSG: &str = "newuidmap not found. Install the uidmap package:\n\
     - Debian/Ubuntu: sudo apt-get install -y uidmap\n\
     - Fedora/RHEL:   sudo dnf install -y shadow-utils\n\
     - openSUSE:      sudo zypper install -y shadow";

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

/// Path inside the container to the system prompt file used when running a
/// local LLM (Ollama, LM Studio, llama.cpp). The slim prompt replaces
/// Claude Code's built-in ~16k-token prompt which exceeds local model context
/// windows. See ADR-040.
pub const LOCAL_LLM_SYSTEM_PROMPT_PATH: &str = "/speedwave/resources/system-prompts/local-llm.md";

/// Error prefix used by backend when SecurityCheck or OS prereqs fail.
/// Frontend matches on this string to distinguish blocking (check_failed)
/// from dismissable (error) failures.
pub const SYSTEM_CHECK_FAILED_PREFIX: &str = "System check failed:";

/// Default interval (in hours) between automatic update checks.
/// Used by both the CLI (converted to seconds) and the Desktop updater
/// (as the default for `UpdateSettings::check_interval_hours`).
pub const UPDATE_CHECK_INTERVAL_HOURS: u32 = 24;

/// Delay in seconds after `compose_up_recreate` before checking container health.
/// Allows crash-looping containers to exit before `compose_ps` reports state.
pub const CONTAINER_STABILIZATION_DELAY_SECS: u64 = 3;

/// Delay in seconds after `systemctl start` inside WSL2 before retrying
/// a service health check. Gives systemd time to bring up containerd/buildkitd.
pub const WSL_SERVICE_START_DELAY_SECS: u64 = 3;

/// Maximum number of health-check retries after `systemctl start` inside WSL2.
/// Each retry waits `WSL_SERVICE_START_DELAY_SECS` seconds. Total worst-case
/// wait per service: 10 × 3s = 30s. Needed because cold-boot WSL may take
/// longer than a single retry to bring up containerd/buildkitd.
pub const WSL_SERVICE_CHECK_MAX_RETRIES: u32 = 10;

/// Delay in seconds after restarting containerd/buildkitd before checking readiness.
/// Gives systemd time to bring up the service after a `systemctl restart`.
pub const CONTAINERD_RESTART_READY_DELAY_SECS: u64 = 5;

/// Maximum number of readiness retries after restarting containerd/buildkitd.
/// Each retry waits `CONTAINERD_RESTART_READY_DELAY_SECS` seconds. Worst-case wait
/// per phase: 6 × 5s = 30s. NerdctlRuntime runs two phases (systemd is-active then
/// nerdctl info), so Linux rootless worst-case is 60s. Lima/WSL2 are single-phase (30s).
pub const CONTAINERD_RESTART_READY_MAX_RETRIES: u32 = 6;

/// Maximum seconds to wait for `limactl start` to boot the Lima VM.
/// Lima VM cold boot typically takes 15-45s; 120s allows for slow machines
/// while preventing indefinite hangs that freeze the Desktop UI.
pub const LIMA_VM_START_TIMEOUT_SECS: u64 = 120;

/// Maximum seconds to wait for exit cleanup (container teardown + VM stop)
/// before the Desktop app force-exits. Used as a watchdog timeout in both
/// the RunEvent::Exit handler and the ctrlc signal handler.
pub const EXIT_CLEANUP_TIMEOUT_SECS: u64 = 60;

/// Maximum seconds to wait for `limactl stop --force` to stop the Lima VM.
/// 30s is generous — Lima's `--force` flag sends SIGKILL after its own
/// internal timeout, so this is an outer safety net preventing exit cleanup
/// from blocking app termination indefinitely.
pub const LIMA_VM_STOP_TIMEOUT_SECS: u64 = 30;

/// Delay in seconds between status polls while waiting for a Lima VM
/// in `Stopping` state to finish. Used by `ensure_ready_inner`.
pub const LIMA_VM_STOP_POLL_DELAY_SECS: u64 = 3;

// Compile-time invariant: VM stop must complete before the exit cleanup
// watchdog fires, otherwise the watchdog kills the process mid-stop.
const _: () = assert!(LIMA_VM_STOP_TIMEOUT_SECS < EXIT_CLEANUP_TIMEOUT_SECS);

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
    /// Whether this field is stored inside a `config.json` file rather than
    /// as an individual credential file. Used by Redmine's `host_url`
    /// and `project_id` fields.
    pub stored_in_config_json: bool,
    /// Whether this field is obtained via an OAuth flow rather than manual entry.
    /// Fields with `oauth_flow: true` are hidden from the credential form and
    /// populated automatically by the Device Code Flow.
    pub oauth_flow: bool,
    /// Whether this field is optional for service configuration.
    /// Optional fields are shown in the UI but do not block the
    /// "Configured" status when left empty.
    pub optional: bool,
}

/// OAuth scopes requested during the SharePoint Device Code Flow.
pub const SHAREPOINT_OAUTH_SCOPES: &str = "https://graph.microsoft.com/Sites.Read.All \
     https://graph.microsoft.com/Files.ReadWrite.All \
     https://graph.microsoft.com/User.Read offline_access";

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
    /// Credential file names allowed for this service (superset of auth field keys,
    /// may include extra files like "config.json").
    pub credential_files: &'static [&'static str],
    /// Optional UI badge label (e.g. "BETA", "NEW"). `None` = no badge.
    pub badge: Option<&'static str>,
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
            McpAuthFieldDescriptor {
                key: "bot_token",
                label: "Bot Token",
                field_type: "password",
                placeholder: "xoxb-...",
                is_secret: true,
                stored_in_config_json: false,
                oauth_flow: false,
                optional: false,
            },
            McpAuthFieldDescriptor {
                key: "user_token",
                label: "User Token",
                field_type: "password",
                placeholder: "xoxp-...",
                is_secret: true,
                stored_in_config_json: false,
                oauth_flow: false,
                optional: false,
            },
        ],
        credential_files: &["bot_token", "user_token"],
        badge: None,
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
            },
            McpAuthFieldDescriptor {
                key: "site_id",
                label: "Site ID",
                field_type: "text",
                placeholder: "site-id",
                is_secret: false,
                stored_in_config_json: false,
                oauth_flow: false,
                optional: false,
            },
            McpAuthFieldDescriptor {
                key: "base_path",
                label: "Base Path",
                field_type: "text",
                placeholder: "Projects/my-project",
                is_secret: false,
                stored_in_config_json: false,
                oauth_flow: false,
                optional: false,
            },
        ],
        credential_files: &[
            "access_token",
            "refresh_token",
            "client_id",
            "tenant_id",
            "site_id",
            "base_path",
        ],
        badge: None,
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
            },
        ],
        credential_files: &[
            "api_key",
            "config.json",
            "host_url",
            "project_id",
            "project_name",
        ],
        badge: None,
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
            },
        ],
        credential_files: &["token", "host_url"],
        badge: None,
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
        badge: Some("BETA"),
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

/// Build the per-project Claude session log path.
pub fn claude_session_log_path(project: &str) -> std::path::PathBuf {
    data_dir()
        .join("logs")
        .join(project)
        .join(CLAUDE_SESSION_LOG_FILE)
}

/// Built-in services defined in containers/compose.template.yml.
/// Used by security checks and image build lists.
pub const BUILT_IN_SERVICES: &[&str] = &[
    "claude",
    "mcp-hub",
    "mcp-slack",
    "mcp-sharepoint",
    "mcp-redmine",
    "mcp-gitlab",
    "mcp-playwright",
];

/// Built-in service IDs (logical names, not compose names).
/// Used by plugin install to prevent slug collisions.
pub const BUILT_IN_SERVICE_IDS: &[&str] = &[
    "slack",
    "sharepoint",
    "redmine",
    "gitlab",
    "playwright",
    "os",
];

/// Pure, testable function for resolving the data directory.
/// `env_val` = None or empty string → `home.join(DATA_DIR)` (empty string treated as unset)
/// `env_val` = absolute path → returns that path
/// Panics if `env_val` is a relative path (including `~/...` — tilde is not expanded in Rust).
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

/// Returns the Speedwave data directory, initialized once per process.
///
/// Resolution: reads `SPEEDWAVE_DATA_DIR` env var; falls back to `~/.speedwave/`.
/// Panics only if neither the env var nor `dirs::home_dir()` is available (i.e.
/// the process has no usable HOME — a fatal misconfiguration).
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

/// Derives an instance name from a data directory path.
///
/// Strips leading dots from the basename (`.speedwave` → `speedwave`).
/// Panics if the basename is empty or does not match `^[a-z][a-z0-9-]{0,63}$`.
///
/// # SSOT note
/// The shell equivalent lives in `scripts/e2e-vm.sh` (`basename | sed 's/^\.//'`).
/// Both must produce identical results.
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

/// Derives the Lima VM name from the data directory basename.
///
/// Default: `"speedwave"` (when data_dir is `~/.speedwave`).
/// Custom: basename of the data directory (e.g. `/opt/sw-test` -> `"sw-test"`).
pub fn lima_vm_name() -> &'static str {
    use std::sync::OnceLock;
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| derive_instance_name_from(data_dir()))
}

/// Derives the compose project prefix from the data directory basename.
///
/// Default: `"speedwave"` (when data_dir is `~/.speedwave`).
/// Custom: basename of the data directory (e.g. `/opt/sw-test` -> `"sw-test"`).
pub fn compose_prefix() -> &'static str {
    use std::sync::OnceLock;
    static PREFIX: OnceLock<String> = OnceLock::new();
    PREFIX.get_or_init(|| derive_instance_name_from(data_dir()))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Guard against service list drift: TOGGLEABLE_MCP_SERVICES count must match
    /// the number of non-OS boolean fields in ResolvedIntegrationsConfig.
    /// If this test fails, a new service was added to one but not the other.
    ///
    /// We assert both directions: the constant matches the struct field count
    /// AND each config_key in the constant resolves to a known field.
    #[test]
    fn test_toggleable_count_matches_resolved_config_fields() {
        let resolved = crate::config::ResolvedIntegrationsConfig::default();
        // Explicit field enumeration — update this when adding/removing MCP fields.
        // Using a const to force a compile-time reminder when struct changes.
        const EXPECTED_MCP_FIELDS: usize = 5; // slack, sharepoint, redmine, gitlab, playwright
        let _ = (
            resolved.slack,
            resolved.sharepoint,
            resolved.redmine,
            resolved.gitlab,
            resolved.playwright,
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

    /// Guard: every config_key in TOGGLEABLE_MCP_SERVICES must have a corresponding
    /// WORKER_*_URL env var name following the naming convention.
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
        }
    }

    #[test]
    fn test_container_user_constants_are_valid_uid_gid() {
        for (name, value) in [
            ("CONTAINER_USER_UNPRIVILEGED", CONTAINER_USER_UNPRIVILEGED),
            ("CONTAINER_USER_ROOTLESS", CONTAINER_USER_ROOTLESS),
        ] {
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
    fn test_auth_fields_count_per_service() {
        let expected: &[(&str, usize)] = &[
            ("slack", 2),
            ("sharepoint", 6),
            ("redmine", 3),
            ("gitlab", 2),
            ("playwright", 0),
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

    /// Services that intentionally have no credentials — they access only
    /// public resources (e.g. Playwright scrapes public URLs). Kept as a
    /// small explicit allowlist so forgetting to declare auth for a new
    /// service that actually needs it still fails this test.
    const CREDENTIAL_LESS_SERVICES: &[&str] = &["playwright"];

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
    fn test_auth_field_keys_subset_of_credential_files() {
        for svc in TOGGLEABLE_MCP_SERVICES {
            for field in svc.auth_fields {
                assert!(
                    svc.credential_files.contains(&field.key),
                    "auth field '{}' for service '{}' not in credential_files",
                    field.key,
                    svc.config_key
                );
            }
        }
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
            "only SharePoint's access_token and refresh_token should have oauth_flow=true"
        );

        // No other service should have oauth_flow fields
        for svc in TOGGLEABLE_MCP_SERVICES {
            if svc.config_key == "sharepoint" {
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
    fn test_optional_only_on_redmine_project_fields() {
        let redmine = find_mcp_service("redmine").unwrap();
        let optional_fields: Vec<&str> = redmine
            .auth_fields
            .iter()
            .filter(|f| f.optional)
            .map(|f| f.key)
            .collect();
        assert_eq!(
            optional_fields,
            vec!["project_id"],
            "only Redmine's project_id should be optional"
        );

        // No other service should have optional fields
        for svc in TOGGLEABLE_MCP_SERVICES {
            if svc.config_key == "redmine" {
                continue;
            }
            for field in svc.auth_fields {
                assert!(
                    !field.optional,
                    "field '{}' in service '{}' should not be optional",
                    field.key, svc.config_key
                );
            }
        }
    }

    #[test]
    fn test_sharepoint_oauth_scopes_contains_required_scopes() {
        assert!(SHAREPOINT_OAUTH_SCOPES.contains("Sites.Read.All"));
        assert!(SHAREPOINT_OAUTH_SCOPES.contains("Files.ReadWrite.All"));
        assert!(SHAREPOINT_OAUTH_SCOPES.contains("offline_access"));
    }

    #[test]
    fn test_find_mcp_service_found() {
        assert!(find_mcp_service("slack").is_some());
        assert!(find_mcp_service("sharepoint").is_some());
        assert!(find_mcp_service("redmine").is_some());
        assert!(find_mcp_service("gitlab").is_some());
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
    fn test_wsl_service_start_delay_is_positive() {
        assert!(
            WSL_SERVICE_START_DELAY_SECS > 0,
            "WSL_SERVICE_START_DELAY_SECS must be positive"
        );
    }

    #[test]
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

    #[test]
    fn test_exit_cleanup_timeout_is_positive() {
        assert!(
            EXIT_CLEANUP_TIMEOUT_SECS > 0,
            "EXIT_CLEANUP_TIMEOUT_SECS must be positive"
        );
    }

    #[test]
    fn test_lima_vm_stop_timeout_is_positive() {
        assert!(
            LIMA_VM_STOP_TIMEOUT_SECS > 0,
            "LIMA_VM_STOP_TIMEOUT_SECS must be positive"
        );
    }

    #[test]
    fn test_playwright_has_beta_badge() {
        let svc = find_mcp_service("playwright").expect("playwright service must exist");
        assert_eq!(svc.badge, Some("BETA"));
    }

    #[test]
    fn test_credential_services_have_no_badge() {
        for svc in TOGGLEABLE_MCP_SERVICES {
            if !svc.auth_fields.is_empty() {
                assert_eq!(
                    svc.badge, None,
                    "service '{}' with credentials should not have a badge",
                    svc.config_key
                );
            }
        }
    }

    #[test]
    fn test_container_host_aliases_contains_all_named_hosts() {
        // Alignment guard: CONTAINER_HOST_ALIASES is composed from the per-platform
        // host constants. If someone adds a new alias to `extra_hosts` in
        // compose.template.yml and forgets to name it here, this test doesn't catch
        // that (separate template test does). This test catches the inverse:
        // renaming one of the named hosts without updating the composition.
        assert!(CONTAINER_HOST_ALIASES.contains(&LIMA_HOST));
        assert!(CONTAINER_HOST_ALIASES.contains(&NERDCTL_LINUX_HOST));
        assert!(CONTAINER_HOST_ALIASES.contains(&WSL_HOST));
        assert!(CONTAINER_HOST_ALIASES.contains(&CONTAINERS_HOST));
        assert_eq!(
            CONTAINER_HOST_ALIASES.len(),
            4,
            "expected exactly 4 container host aliases; update this test if you added a new platform alias to compose.template.yml"
        );
    }
}
