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
pub const MCP_OS_LOG_FILE: &str = "mcp-os.log";
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
    /// as an individual credential file. Used by Redmine's `host_url`,
    /// `project_id`, and `project_name` fields.
    pub stored_in_config_json: bool,
}

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
            },
            McpAuthFieldDescriptor {
                key: "user_token",
                label: "User Token",
                field_type: "password",
                placeholder: "xoxp-...",
                is_secret: true,
                stored_in_config_json: false,
            },
        ],
        credential_files: &["bot_token", "user_token"],
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
            },
            McpAuthFieldDescriptor {
                key: "refresh_token",
                label: "Refresh Token",
                field_type: "password",
                placeholder: "0.AR...",
                is_secret: true,
                stored_in_config_json: false,
            },
            McpAuthFieldDescriptor {
                key: "client_id",
                label: "Client ID",
                field_type: "text",
                placeholder: "00000000-0000-...",
                is_secret: false,
                stored_in_config_json: false,
            },
            McpAuthFieldDescriptor {
                key: "tenant_id",
                label: "Tenant ID",
                field_type: "text",
                placeholder: "00000000-0000-...",
                is_secret: false,
                stored_in_config_json: false,
            },
            McpAuthFieldDescriptor {
                key: "site_id",
                label: "Site ID",
                field_type: "text",
                placeholder: "site-id",
                is_secret: false,
                stored_in_config_json: false,
            },
            McpAuthFieldDescriptor {
                key: "base_path",
                label: "Base Path",
                field_type: "text",
                placeholder: "/sites/MySite",
                is_secret: false,
                stored_in_config_json: false,
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
    },
    McpServiceDescriptor {
        config_key: "redmine",
        compose_name: "mcp-redmine",
        worker_env: "WORKER_REDMINE_URL",
        display_name: "Redmine",
        description: "Project management and issue tracking",
        auth_fields: &[
            McpAuthFieldDescriptor {
                key: "api_key",
                label: "API Key",
                field_type: "password",
                placeholder: "abcdef1234567890...",
                is_secret: true,
                stored_in_config_json: false,
            },
            McpAuthFieldDescriptor {
                key: "host_url",
                label: "Redmine URL",
                field_type: "url",
                placeholder: "https://redmine.company.com",
                is_secret: false,
                stored_in_config_json: true,
            },
            McpAuthFieldDescriptor {
                key: "project_id",
                label: "Project ID",
                field_type: "text",
                placeholder: "my-project",
                is_secret: false,
                stored_in_config_json: true,
            },
            McpAuthFieldDescriptor {
                key: "project_name",
                label: "Project Name",
                field_type: "text",
                placeholder: "My Project",
                is_secret: false,
                stored_in_config_json: true,
            },
        ],
        credential_files: &[
            "api_key",
            "config.json",
            "host_url",
            "project_id",
            "project_name",
        ],
    },
    McpServiceDescriptor {
        config_key: "gitlab",
        compose_name: "mcp-gitlab",
        worker_env: "WORKER_GITLAB_URL",
        display_name: "GitLab",
        description: "Git repository and CI/CD platform",
        auth_fields: &[
            McpAuthFieldDescriptor {
                key: "token",
                label: "Personal Access Token",
                field_type: "password",
                placeholder: "glpat-...",
                is_secret: true,
                stored_in_config_json: false,
            },
            McpAuthFieldDescriptor {
                key: "host_url",
                label: "GitLab URL",
                field_type: "url",
                placeholder: "https://gitlab.com",
                is_secret: false,
                stored_in_config_json: false,
            },
        ],
        credential_files: &["token", "host_url"],
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

/// Built-in services defined in containers/compose.template.yml.
/// Used by security checks and image build lists.
pub const BUILT_IN_SERVICES: &[&str] = &[
    "claude",
    "mcp-hub",
    "mcp-slack",
    "mcp-sharepoint",
    "mcp-redmine",
    "mcp-gitlab",
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
    #[test]
    fn test_toggleable_count_matches_resolved_config_fields() {
        let resolved = crate::config::ResolvedIntegrationsConfig::default();
        // Count non-OS fields by checking all 5 MCP service booleans
        let mcp_field_count = [
            resolved.slack,
            resolved.sharepoint,
            resolved.redmine,
            resolved.gitlab,
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
            ("redmine", 4),
            ("gitlab", 2),
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
    fn test_every_service_has_auth_fields() {
        for svc in TOGGLEABLE_MCP_SERVICES {
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
            vec!["host_url", "project_id", "project_name"],
            "only Redmine's host_url, project_id, project_name should be stored_in_config_json"
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
    fn test_wsl_service_start_delay_is_positive() {
        assert!(
            WSL_SERVICE_START_DELAY_SECS > 0,
            "WSL_SERVICE_START_DELAY_SECS must be positive"
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
        let os_field_count = [
            resolved.os_reminders,
            resolved.os_calendar,
            resolved.os_mail,
            resolved.os_notes,
        ]
        .len();
        assert_eq!(
            TOGGLEABLE_OS_SERVICES.len(),
            os_field_count,
            "TOGGLEABLE_OS_SERVICES count ({}) must match ResolvedIntegrationsConfig OS fields ({}). \
             Did you add a service to one but not the other?",
            TOGGLEABLE_OS_SERVICES.len(),
            os_field_count
        );
    }
}
