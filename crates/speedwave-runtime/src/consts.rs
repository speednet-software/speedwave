pub const APP_NAME: &str = "speedwave";
pub const LIMA_VM_NAME: &str = "speedwave";
pub const LIMA_SUBDIR: &str = "lima";
pub const DATA_DIR: &str = ".speedwave";
pub const CLI_BINARY: &str = "speedwave";
pub const COMPOSE_PREFIX: &str = "speedwave";
pub const PORT_BASE: u16 = 4000;
pub const MCP_OS_AUTH_TOKEN_FILE: &str = "mcp-os-auth-token";
pub const MCP_OS_PORT_FILE: &str = "mcp-os-port";
pub const MCP_OS_PID_FILE: &str = "mcp-os-pid";
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

/// IP of the macOS host as seen from inside nerdctl containers in the Lima vzNAT network.
/// Lima vzNAT always assigns 192.168.5.2 to the host — this is static, not DHCP.
pub const LIMA_VZ_HOST_IP: &str = "192.168.5.2";
/// IP of the Linux host as seen from inside rootless nerdctl containers (slirp4netns gateway).
pub const NERDCTL_LINUX_HOST_IP: &str = "10.0.2.2";
/// IP of the Windows host as seen from inside WSL2 containers.
pub const WSL_HOST_IP: &str = "192.168.65.1";

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

/// SHA256 checksum for the static AppImage type2-runtime (x86_64).
/// This runtime statically links libfuse, eliminating the libfuse2 system dependency.
/// Source: https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64
pub const APPIMAGE_RUNTIME_SHA256_X86_64: &str =
    "27ddd3f78e483fc5f7856e413d7c17092917f8c35bfe3318a0d378aa9435ad17";

/// SHA256 checksum for appimagetool used to repack AppImages with the static runtime.
/// Source: https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
pub const APPIMAGETOOL_SHA256_X86_64: &str =
    "a6d71e2b6cd66f8e8d16c37ad164658985e0cf5fcaa950c90a482890cb9d13e0";

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
    },
    McpServiceDescriptor {
        config_key: "sharepoint",
        compose_name: "mcp-sharepoint",
        worker_env: "WORKER_SHAREPOINT_URL",
        display_name: "SharePoint",
        description: "Microsoft 365 document management",
    },
    McpServiceDescriptor {
        config_key: "redmine",
        compose_name: "mcp-redmine",
        worker_env: "WORKER_REDMINE_URL",
        display_name: "Redmine",
        description: "Project management and issue tracking",
    },
    McpServiceDescriptor {
        config_key: "gitlab",
        compose_name: "mcp-gitlab",
        worker_env: "WORKER_GITLAB_URL",
        display_name: "GitLab",
        description: "Git repository and CI/CD platform",
    },
    McpServiceDescriptor {
        config_key: "gemini",
        compose_name: "mcp-gemini",
        worker_env: "WORKER_GEMINI_URL",
        display_name: "Gemini",
        description: "Google AI content analysis",
    },
];

/// Built-in services defined in containers/compose.template.yml.
/// Used by security checks and image build lists.
pub const BUILT_IN_SERVICES: &[&str] = &[
    "claude",
    "mcp-hub",
    "mcp-slack",
    "mcp-sharepoint",
    "mcp-redmine",
    "mcp-gitlab",
    "mcp-gemini",
];

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

    #[test]
    fn test_appimage_runtime_sha256_are_64_hex_chars() {
        for (name, hash) in [
            (
                "APPIMAGE_RUNTIME_SHA256_X86_64",
                APPIMAGE_RUNTIME_SHA256_X86_64,
            ),
            ("APPIMAGETOOL_SHA256_X86_64", APPIMAGETOOL_SHA256_X86_64),
        ] {
            assert_eq!(
                hash.len(),
                64,
                "{name}: SHA256 must be 64 hex chars, got: {hash}"
            );
            assert!(
                hash.chars().all(|c| c.is_ascii_hexdigit()),
                "{name}: SHA256 must be hex only, got: {hash}"
            );
        }
    }

    /// Guard against service list drift: TOGGLEABLE_MCP_SERVICES count must match
    /// the number of non-OS boolean fields in ResolvedIntegrationsConfig.
    /// If this test fails, a new service was added to one but not the other.
    #[test]
    fn test_toggleable_count_matches_resolved_config_fields() {
        let resolved = crate::config::ResolvedIntegrationsConfig::default();
        // Count non-OS fields by checking all 5 MCP service booleans
        let mcp_field_count = [
            resolved.slack,
            resolved.sharepoint,
            resolved.redmine,
            resolved.gitlab,
            resolved.gemini,
        ]
        .len();
        assert_eq!(
            TOGGLEABLE_MCP_SERVICES.len(),
            mcp_field_count,
            "TOGGLEABLE_MCP_SERVICES count ({}) must match ResolvedIntegrationsConfig MCP fields ({}). \
             Did you add a service to one but not the other?",
            TOGGLEABLE_MCP_SERVICES.len(),
            mcp_field_count
        );
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
}
