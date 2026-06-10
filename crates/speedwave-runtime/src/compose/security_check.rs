//! Security validation framework: asserts every container-hardening, token
//! isolation, and plugin/SharePoint volume invariant on the rendered compose
//! YAML (+ host filesystem). The gate that blocks `compose_up` on any violation.

use crate::consts;
use crate::engine_path::to_engine_path;
use crate::plugin::{self, PluginManifest};
use strum::EnumProperty;

use super::{container_user, resolve_tokens_dir_in};

// --- SecurityCheck ---

/// Expected engine paths for security validation.
/// Single source of truth — used by both render_compose() and SecurityCheck.
pub struct SecurityExpectedPaths {
    project_engine_path: String,
    tokens_engine_dir: String,
}

impl SecurityExpectedPaths {
    /// Returns the engine-format project directory path.
    pub fn project_engine_path(&self) -> &str {
        &self.project_engine_path
    }

    /// Returns the engine-format tokens directory path.
    pub fn tokens_engine_dir(&self) -> &str {
        &self.tokens_engine_dir
    }

    /// Computes the expected engine-format paths for a project.
    pub fn compute(project_name: &str, project_dir: &str) -> anyhow::Result<Self> {
        let tokens_dir = resolve_tokens_dir_in(consts::data_dir(), project_name);
        Ok(Self {
            project_engine_path: to_engine_path(std::path::Path::new(project_dir))?,
            tokens_engine_dir: to_engine_path(&tokens_dir)?,
        })
    }

    /// Create from explicit paths (for tests in this crate and downstream crates).
    pub fn from_raw(project_engine_path: &str, tokens_engine_dir: &str) -> Self {
        Self {
            project_engine_path: project_engine_path.to_string(),
            tokens_engine_dir: tokens_engine_dir.to_string(),
        }
    }
}

/// Extracts (host_path, mode) for a known container target from a volume string.
/// Matches by searching for ":<target>:" or ":<target>" at end.
/// Returns None if the target is not found in the volume string.
pub(crate) fn extract_volume_for_target(
    vol: &str,
    target: &str,
) -> Option<(String, Option<String>)> {
    // Try :<target>:<mode> first (e.g., /path:/tokens:ro)
    let with_mode = format!(":{}:", target);
    if let Some(pos) = vol.find(&with_mode) {
        let host = &vol[..pos];
        let mode = &vol[pos + with_mode.len()..];
        return Some((host.to_string(), Some(mode.to_string())));
    }
    // Try :<target> at end (e.g., /path:/tokens)
    let at_end = format!(":{}", target);
    if vol.ends_with(&at_end) {
        let host = &vol[..vol.len() - at_end.len()];
        return Some((host.to_string(), None));
    }
    None
}

/// Validates a rendered compose file against Speedwave's security invariants.
pub struct SecurityCheck;

/// Compile-time enumeration of every security rule enforced by [`SecurityCheck`].
///
/// Using an enum instead of `&'static str` guarantees that rule identifiers are
/// unique and typo-free — a misspelled variant is a compile error, whereas a
/// misspelled string literal would silently pass.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    strum_macros::Display,
    strum_macros::EnumIter,
    strum_macros::EnumProperty,
)]
pub enum SecurityRule {
    /// Compose YAML is parseable.
    #[strum(to_string = "YAML_PARSE_ERROR")]
    #[strum(props(description = "Compose YAML is parseable"))]
    YamlParseError,

    /// All containers have `cap_drop: [ALL]`.
    #[strum(to_string = "CAP_DROP_ALL")]
    #[strum(props(description = "All containers have cap_drop: [ALL]"))]
    CapDropAll,
    /// All containers have `no-new-privileges`.
    #[strum(to_string = "NO_NEW_PRIVS")]
    #[strum(props(description = "All containers have no-new-privileges"))]
    NoNewPrivs,
    /// Core containers have a read-only filesystem.
    #[strum(to_string = "READ_ONLY_FS")]
    #[strum(props(description = "Core containers have read-only filesystem"))]
    ReadOnlyFs,
    /// Core containers mount `/tmp` as tmpfs with `noexec`.
    #[strum(to_string = "TMPFS_NOEXEC")]
    #[strum(props(description = "Core containers have /tmp as tmpfs with noexec"))]
    TmpfsNoexec,

    /// Claude container has no token/key/secret env vars.
    #[strum(to_string = "NO_TOKENS_CLAUDE")]
    #[strum(props(description = "Claude container has no token/key/secret env vars"))]
    NoTokensClaude,
    /// Hub has no token env vars (only `WORKER_*_URL`).
    #[strum(to_string = "NO_TOKENS_HUB")]
    #[strum(props(description = "Hub has no token env vars (only WORKER_*_URL)"))]
    NoTokensHub,

    /// All exposed ports bind to 127.0.0.1.
    #[strum(to_string = "PORTS_LOCALHOST")]
    #[strum(props(description = "All exposed ports bind to 127.0.0.1"))]
    PortsLocalhost,
    /// Claude container has no docker/nerdctl socket.
    #[strum(to_string = "NO_SOCKET_CLAUDE")]
    #[strum(props(description = "Claude container has no docker/nerdctl socket"))]
    NoSocketClaude,
    /// Claude container has no external LLM API keys.
    #[strum(to_string = "NO_EXTERNAL_LLM_KEYS_CLAUDE")]
    #[strum(props(description = "Claude container has no external LLM API keys"))]
    NoExternalLlmKeysClaude,
    /// Built-in workers do not expose ports.
    #[strum(to_string = "NO_PORTS_WORKERS")]
    #[strum(props(description = "Built-in workers do not expose ports"))]
    NoPortsWorkers,

    /// All containers use the correct platform user.
    #[strum(to_string = "CONTAINER_USER")]
    #[strum(props(description = "All containers use correct platform user"))]
    ContainerUser,

    /// Plugin containers are not privileged.
    #[strum(to_string = "PLUGIN_NO_PRIVILEGED")]
    #[strum(props(description = "Plugin containers are not privileged"))]
    PluginNoPrivileged,
    /// Plugin containers do not use host network.
    #[strum(to_string = "PLUGIN_NO_HOST_NETWORK")]
    #[strum(props(description = "Plugin containers do not use host network"))]
    PluginNoHostNetwork,
    /// All plugin services have signed manifests.
    #[strum(to_string = "PLUGIN_MANIFEST_MISSING")]
    #[strum(props(description = "All plugin services have signed manifests"))]
    PluginManifestMissing,
    /// Plugin volumes use short-form only.
    #[strum(to_string = "PLUGIN_VOLUME_LONG_FORM")]
    #[strum(props(description = "Plugin volumes use short-form only"))]
    PluginVolumeLongForm,
    /// Plugin token mount paths match expected.
    #[strum(to_string = "PLUGIN_TOKEN_PATH_MISMATCH")]
    #[strum(props(description = "Plugin token mount paths match expected"))]
    PluginTokenPathMismatch,
    /// Plugin token mount modes match the manifest.
    #[strum(to_string = "PLUGIN_TOKEN_MOUNT_MODE")]
    #[strum(props(description = "Plugin token mount modes match manifest"))]
    PluginTokenMountMode,
    /// Plugin workspace paths match expected.
    #[strum(to_string = "PLUGIN_WORKSPACE_PATH_MISMATCH")]
    #[strum(props(description = "Plugin workspace paths match expected"))]
    PluginWorkspacePathMismatch,
    /// Plugin workspace mount mode is `:rw`.
    #[strum(to_string = "PLUGIN_WORKSPACE_MOUNT_MODE")]
    #[strum(props(description = "Plugin workspace mount mode is :rw"))]
    PluginWorkspaceMountMode,
    /// Plugin containers have no extra volumes.
    #[strum(to_string = "PLUGIN_NO_EXTRA_VOLUMES")]
    #[strum(props(description = "Plugin containers have no extra volumes"))]
    PluginNoExtraVolumes,
    /// Plugin containers have a `/tokens` mount.
    #[strum(to_string = "PLUGIN_MISSING_TOKENS_MOUNT")]
    #[strum(props(description = "Plugin containers have /tokens mount"))]
    PluginMissingTokensMount,
    /// Plugin containers have a `/workspace` mount.
    #[strum(to_string = "PLUGIN_MISSING_WORKSPACE_MOUNT")]
    #[strum(props(description = "Plugin containers have /workspace mount"))]
    PluginMissingWorkspaceMount,

    /// SharePoint volumes use short-form only.
    #[strum(to_string = "SHAREPOINT_VOLUME_LONG_FORM")]
    #[strum(props(description = "SharePoint volumes use short-form only"))]
    SharepointVolumeLongForm,
    /// SharePoint token path matches expected.
    #[strum(to_string = "SHAREPOINT_TOKEN_PATH_MISMATCH")]
    #[strum(props(description = "SharePoint token path matches expected"))]
    SharepointTokenPathMismatch,
    /// SharePoint workspace path matches expected.
    #[strum(to_string = "SHAREPOINT_WORKSPACE_PATH_MISMATCH")]
    #[strum(props(description = "SharePoint workspace path matches expected"))]
    SharepointWorkspacePathMismatch,
    /// SharePoint workspace mount mode is `:rw`.
    #[strum(to_string = "SHAREPOINT_WORKSPACE_MOUNT_MODE")]
    #[strum(props(description = "SharePoint workspace mount mode is :rw"))]
    SharepointWorkspaceMountMode,
    /// SharePoint has no extra volumes.
    #[strum(to_string = "SHAREPOINT_NO_EXTRA_VOLUMES")]
    #[strum(props(description = "SharePoint has no extra volumes"))]
    SharepointNoExtraVolumes,
    /// SharePoint has a `/tokens` mount.
    #[strum(to_string = "SHAREPOINT_MISSING_TOKENS_MOUNT")]
    #[strum(props(description = "SharePoint has /tokens mount"))]
    SharepointMissingTokensMount,
    /// SharePoint has a `/workspace` mount.
    #[strum(to_string = "SHAREPOINT_MISSING_WORKSPACE_MOUNT")]
    #[strum(props(description = "SharePoint has /workspace mount"))]
    SharepointMissingWorkspaceMount,

    // 31. Host file security
    #[strum(to_string = "FILE_SECURITY_VIOLATION")]
    #[strum(props(description = "Host file permissions and ownership are correct"))]
    /// Host file or directory has wrong permissions or ownership.
    /// Covers both mode bits (e.g. 0o644 instead of 0o600) and UID mismatch.
    /// Unix-only — skipped on Windows.
    FileSecurityViolation,
}

impl SecurityRule {
    /// Returns `true` for SharePoint-specific rules.
    ///
    /// Note: there is no `SharepointTokenMountMode` after ADR-060/PR3.
    /// SharePoint mounts `/tokens:ro` like every other built-in worker; a `:rw`
    /// regression is caught by `PluginTokenMountMode` (re-used for built-ins)
    /// via the shared `validate_service_volume_mounts` machinery.
    pub fn is_sharepoint(self) -> bool {
        matches!(
            self,
            Self::SharepointVolumeLongForm
                | Self::SharepointTokenPathMismatch
                | Self::SharepointWorkspacePathMismatch
                | Self::SharepointWorkspaceMountMode
                | Self::SharepointNoExtraVolumes
                | Self::SharepointMissingTokensMount
                | Self::SharepointMissingWorkspaceMount
        )
    }

    /// Human-readable description for verbose check output.
    pub fn description(self) -> &'static str {
        self.get_str("description")
            .unwrap_or("(missing description — update SecurityRule props)")
    }
}

/// A single security-rule violation found in a rendered compose file.
#[derive(Debug)]
pub struct SecurityViolation {
    /// Container the violation was found in.
    pub container: String,
    /// Rule that was violated.
    pub rule: SecurityRule,
    /// Human-readable description of the violation.
    pub message: String,
    /// Actionable remediation steps.
    pub remediation: &'static str,
}

impl SecurityViolation {
    /// Builds a violation for `container` against `rule`.
    pub fn new(
        container: impl Into<String>,
        rule: SecurityRule,
        message: impl Into<String>,
        remediation: &'static str,
    ) -> Self {
        Self {
            container: container.into(),
            rule,
            message: message.into(),
            remediation,
        }
    }
}

impl std::fmt::Display for SecurityViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "[{}] {} -- {}\n  Fix: {}",
            self.container, self.rule, self.message, self.remediation
        )
    }
}

impl SecurityCheck {
    /// Verifies all security invariants on the generated compose YAML and host filesystem.
    /// Returns Vec of violations — if non-empty, compose_up MUST be blocked.
    ///
    /// `plugin_manifests` provides signed manifest data for cross-referencing
    /// plugin compose services against their declared token mount modes.
    ///
    /// Delegates to `run_with_data_dir()` using `consts::data_dir()` for host filesystem checks.
    pub fn run(
        compose_yml: &str,
        project: &str,
        plugin_manifests: &[PluginManifest],
        expected_paths: &SecurityExpectedPaths,
    ) -> Vec<SecurityViolation> {
        Self::run_with_data_dir(
            compose_yml,
            project,
            plugin_manifests,
            expected_paths,
            crate::consts::data_dir(),
        )
    }

    /// Testable version that accepts an explicit data_dir for host filesystem checks.
    ///
    /// Separated from `run()` so tests can pass a temp directory for
    /// `check_file_security()` without depending on `consts::data_dir()`.
    /// On non-Unix platforms, `check_file_security()` is a no-op.
    pub(crate) fn run_with_data_dir(
        compose_yml: &str,
        project: &str,
        plugin_manifests: &[PluginManifest],
        expected_paths: &SecurityExpectedPaths,
        data_dir: &std::path::Path,
    ) -> Vec<SecurityViolation> {
        let doc: serde_yaml_ng::Value = match serde_yaml_ng::from_str(compose_yml) {
            Ok(v) => v,
            Err(e) => {
                return vec![SecurityViolation {
                    container: "*".into(),
                    rule: SecurityRule::YamlParseError,
                    message: format!("Cannot parse compose YAML: {e}"),
                    remediation: "Run render_compose() again to regenerate the file.",
                }];
            }
        };

        [
            Self::check_cap_drop(&doc),
            Self::check_no_new_privileges(&doc),
            Self::check_read_only(&doc),
            Self::check_tmpfs_noexec(&doc),
            Self::check_no_tokens_in_claude(&doc),
            Self::check_no_tokens_in_hub(&doc),
            // PORTS_LOCALHOST: any exposed port must bind 127.0.0.1 (plugins)
            Self::check_ports_localhost_only(&doc),
            Self::check_claude_no_socket(&doc),
            Self::check_no_external_llm_keys_claude(&doc),
            // NO_PORTS_WORKERS: built-in services must not expose ports at all.
            // May fire alongside PORTS_LOCALHOST — intentional defense-in-depth.
            Self::check_no_ports_on_workers(&doc),
            Self::check_container_user(&doc),
            // Plugin-specific checks
            Self::check_plugin_no_privileged(&doc),
            Self::check_plugin_no_host_network(&doc),
            Self::check_plugin_volumes(&doc, expected_paths, plugin_manifests),
            // Built-in SharePoint context mount validation
            Self::check_builtin_sharepoint_volumes(&doc, expected_paths),
            // Host filesystem checks (I/O — unlike pure YAML checks above)
            Self::check_file_security(data_dir, project),
        ]
        .into_iter()
        .flatten()
        .collect()
    }

    /// All containers must have cap_drop: [ALL]
    fn check_cap_drop(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        for (name, service) in services {
            let has_cap_drop_all = service
                .get("cap_drop")
                .and_then(|v| v.as_sequence())
                .map(|seq| {
                    seq.iter()
                        .any(|item| item.as_str().is_some_and(|s| s.eq_ignore_ascii_case("all")))
                })
                .unwrap_or(false);

            if !has_cap_drop_all {
                violations.push(SecurityViolation {
                    container: name.clone(),
                    rule: SecurityRule::CapDropAll,
                    message: "Missing cap_drop: [ALL]".into(),
                    remediation: "Add 'cap_drop: [ALL]' to the service definition.",
                });
            }
        }
        violations
    }

    /// All containers must have security_opt: [no-new-privileges:true]
    fn check_no_new_privileges(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        for (name, service) in services {
            let has_no_new_privs = service
                .get("security_opt")
                .and_then(|v| v.as_sequence())
                .map(|seq| {
                    seq.iter()
                        .any(|item| item.as_str().is_some_and(|s| s == "no-new-privileges:true"))
                })
                .unwrap_or(false);

            if !has_no_new_privs {
                violations.push(SecurityViolation {
                    container: name.clone(),
                    rule: SecurityRule::NoNewPrivs,
                    message: "Missing security_opt: [no-new-privileges:true]".into(),
                    remediation:
                        "Add 'security_opt: [no-new-privileges:true]' to the service definition.",
                });
            }
        }
        violations
    }

    /// claude and mcp-hub must have read_only: true
    fn check_read_only(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        let read_only_required = ["claude", "mcp-hub"];
        for required in &read_only_required {
            if let Some((name, service)) = services.iter().find(|(n, _)| n == required) {
                let is_read_only = service
                    .get("read_only")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                if !is_read_only {
                    violations.push(SecurityViolation {
                        container: name.clone(),
                        rule: SecurityRule::ReadOnlyFs,
                        message: "Missing read_only: true".into(),
                        remediation: "Add 'read_only: true' to the service definition.",
                    });
                }
            }
        }
        violations
    }

    /// claude and mcp-hub must have /tmp as tmpfs with noexec,nosuid
    fn check_tmpfs_noexec(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        let tmpfs_required = ["claude", "mcp-hub"];
        for required in &tmpfs_required {
            if let Some((name, service)) = services.iter().find(|(n, _)| n == required) {
                let has_tmpfs_noexec = service
                    .get("tmpfs")
                    .and_then(|v| v.as_sequence())
                    .map(|seq| {
                        seq.iter().any(|item| {
                            item.as_str().is_some_and(|s| {
                                s.starts_with("/tmp")
                                    && s.contains("noexec")
                                    && s.contains("nosuid")
                            })
                        })
                    })
                    .unwrap_or(false);

                if !has_tmpfs_noexec {
                    violations.push(SecurityViolation {
                        container: name.clone(),
                        rule: SecurityRule::TmpfsNoexec,
                        message: "Missing tmpfs /tmp with noexec,nosuid".into(),
                        remediation:
                            "Add 'tmpfs: [\"/tmp:noexec,nosuid\"]' to the service definition.",
                    });
                }
            }
        }
        violations
    }

    /// claude container must not have any TOKEN, KEY, or SECRET env vars
    fn check_no_tokens_in_claude(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        if let Some((_name, service)) = services.iter().find(|(n, _)| n == "claude") {
            if let Some(env_seq) = service.get("environment").and_then(|v| v.as_sequence()) {
                let forbidden_patterns = ["TOKEN", "KEY", "SECRET"];
                // Allowed env vars that contain these patterns but are safe
                let allowed = [
                    "ANTHROPIC_AUTH_TOKEN",
                    "ANTHROPIC_API_KEY",
                    "CLAUDE_CODE_OAUTH_TOKEN",
                    "DISABLE_AUTOUPDATER",
                ];

                for item in env_seq {
                    if let Some(env_str) = item.as_str() {
                        let var_name = env_str.split('=').next().unwrap_or("");
                        let upper = var_name.to_uppercase();

                        if forbidden_patterns
                            .iter()
                            .any(|pattern| upper.contains(pattern))
                            && !allowed.iter().any(|a| upper == *a)
                        {
                            violations.push(SecurityViolation {
                                container: "claude".into(),
                                rule: SecurityRule::NoTokensClaude,
                                message: format!(
                                    "env contains forbidden variable: {}",
                                    var_name
                                ),
                                remediation:
                                    "Claude container must have zero service tokens. Remove from compose.",
                            });
                        }
                    }
                }
            }
        }
        violations
    }

    /// mcp-hub must not have TOKEN/KEY/SECRET env vars — auth tokens are
    /// delivered as file mounts (/secrets/*), not environment variables.
    /// Allowed: WORKER_*_URL (service discovery) and PORT.
    pub(crate) fn check_no_tokens_in_hub(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        if let Some((_name, service)) = services.iter().find(|(n, _)| n == "mcp-hub") {
            if let Some(env_seq) = service.get("environment").and_then(|v| v.as_sequence()) {
                let forbidden_patterns = ["TOKEN", "KEY", "SECRET"];
                let allowed_prefixes = ["WORKER_", "PORT"];

                for item in env_seq {
                    if let Some(env_str) = item.as_str() {
                        let var_name = env_str.split('=').next().unwrap_or("");
                        let upper = var_name.to_uppercase();

                        if forbidden_patterns
                            .iter()
                            .any(|pattern| upper.contains(pattern))
                            && !allowed_prefixes
                                .iter()
                                .any(|prefix| upper.starts_with(prefix))
                        {
                            violations.push(SecurityViolation {
                                container: "mcp-hub".into(),
                                rule: SecurityRule::NoTokensHub,
                                message: format!(
                                    "env contains forbidden variable: {}",
                                    var_name
                                ),
                                remediation:
                                    "Hub must have zero tokens in env vars. Use /secrets/ file mounts instead.",
                            });
                        }
                    }
                }
            }
        }
        violations
    }

    /// All ports must bind to 127.0.0.1, not 0.0.0.0
    fn check_ports_localhost_only(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        for (name, service) in services {
            if let Some(ports_seq) = service.get("ports").and_then(|v| v.as_sequence()) {
                for port in ports_seq {
                    if let Some(port_str) = port.as_str() {
                        // Valid format: "127.0.0.1:host:container"
                        // Invalid: "host:container" (binds to 0.0.0.0) or "0.0.0.0:host:container"
                        if !port_str.starts_with("127.0.0.1:") {
                            violations.push(SecurityViolation {
                                container: name.clone(),
                                rule: SecurityRule::PortsLocalhost,
                                message: format!(
                                    "Port bound to non-localhost address: {}",
                                    port_str
                                ),
                                remediation:
                                    "All ports must bind to 127.0.0.1 only. Change to 127.0.0.1:host:container.",
                            });
                        }
                    } else if port.as_mapping().is_some() {
                        // Long-form: {target: 3000, published: 3000, protocol: tcp}
                        // If "published" is present without a host_ip of 127.0.0.1, it binds to 0.0.0.0
                        let host_ip = port.get("host_ip").and_then(|v| v.as_str()).unwrap_or("");
                        if port.get("published").is_some() && host_ip != "127.0.0.1" {
                            violations.push(SecurityViolation {
                                container: name.clone(),
                                rule: SecurityRule::PortsLocalhost,
                                message: "Port mapping missing host_ip: 127.0.0.1 (long-form)".to_string(),
                                remediation:
                                    "All ports must bind to 127.0.0.1 only. Add host_ip: 127.0.0.1 to the port mapping.",
                            });
                        }
                    }
                    // Integer port values (e.g., `- 3000`) expose only the container port
                    // with a random host port on all interfaces. This is not used in our
                    // template — flag it as a violation.
                    else if port.as_i64().is_some() || port.as_f64().is_some() {
                        violations.push(SecurityViolation {
                            container: name.clone(),
                            rule: SecurityRule::PortsLocalhost,
                            message: "Port specified as bare integer (binds to 0.0.0.0)".into(),
                            remediation:
                                "All ports must bind to 127.0.0.1 only. Change to \"127.0.0.1:host:container\".",
                        });
                    }
                }
            }
        }
        violations
    }

    /// claude container must not mount docker.sock or nerdctl.sock
    fn check_claude_no_socket(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        if let Some((_name, service)) = services.iter().find(|(n, _)| n == "claude") {
            if let Some(vols_seq) = service.get("volumes").and_then(|v| v.as_sequence()) {
                let forbidden_sockets = ["docker.sock", "nerdctl.sock", "podman.sock"];
                for vol in vols_seq {
                    if let Some(vol_str) = vol.as_str() {
                        for socket in &forbidden_sockets {
                            if vol_str.contains(socket) {
                                violations.push(SecurityViolation {
                                    container: "claude".into(),
                                    rule: SecurityRule::NoSocketClaude,
                                    message: format!(
                                        "Volume mounts container socket: {}",
                                        vol_str
                                    ),
                                    remediation:
                                        "Claude container must not have access to any container runtime socket.",
                                });
                            }
                        }
                    }
                }
            }
        }
        violations
    }

    /// claude container must not have external LLM API keys
    /// (OPENAI_*, AZURE_OPENAI_*, GEMINI_*, DEEPSEEK_*, OPENROUTER_*, COHERE_*,
    /// MISTRAL_*, TOGETHER_*, GROQ_* — these prefixes are forbidden because external
    /// LLM API keys must never enter the claude container. Only the dummy
    /// ANTHROPIC_AUTH_TOKEN (sk-no-key-required) is permitted for local model providers.)
    fn check_no_external_llm_keys_claude(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        if let Some((_name, service)) = services.iter().find(|(n, _)| n == "claude") {
            if let Some(env_seq) = service.get("environment").and_then(|v| v.as_sequence()) {
                let forbidden_prefixes = [
                    "OPENAI_",
                    "AZURE_OPENAI_",
                    "GEMINI_",
                    "DEEPSEEK_",
                    "OPENROUTER_",
                    "COHERE_",
                    "MISTRAL_",
                    "TOGETHER_",
                    "GROQ_",
                ];

                for item in env_seq {
                    if let Some(env_str) = item.as_str() {
                        let var_name = env_str.split('=').next().unwrap_or("");
                        let upper = var_name.to_uppercase();

                        if forbidden_prefixes
                            .iter()
                            .any(|prefix| upper.starts_with(prefix))
                        {
                            violations.push(SecurityViolation {
                                container: "claude".into(),
                                rule: SecurityRule::NoExternalLlmKeysClaude,
                                message: format!(
                                    "env contains external LLM key: {}",
                                    var_name
                                ),
                                remediation:
                                    "External LLM API keys must not be injected into the claude container. Use a local model provider instead.",
                            });
                        }
                    }
                }
            }
        }
        violations
    }

    /// MCP workers and hub must NOT expose ports to the host.
    /// Only dynamically-injected services (addons) may map ports.
    /// All inter-container communication uses Docker DNS.
    fn check_no_ports_on_workers(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        // Addon services (not listed in consts::BUILT_IN_SERVICES) are allowed to expose ports.
        for (name, service) in services {
            if !consts::BUILT_IN_SERVICES.contains(&name.as_str()) {
                continue;
            }
            if service
                .get("ports")
                .and_then(|v| v.as_sequence())
                .is_some_and(|s| !s.is_empty())
            {
                violations.push(SecurityViolation {
                    container: name.clone(),
                    rule: SecurityRule::NoPortsWorkers,
                    message: format!(
                        "{} must not expose ports to host — use Docker DNS for inter-container communication",
                        name
                    ),
                    remediation:
                        "Remove the 'ports:' section. Hub and workers communicate over the internal Docker network.",
                });
            }
        }
        violations
    }

    /// Plugin services (identified by label) must not have privileged: true
    fn check_plugin_no_privileged(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };
        for (name, service) in services {
            if !is_plugin_service(service) {
                continue;
            }
            if service
                .get("privileged")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                violations.push(SecurityViolation {
                    container: name,
                    rule: SecurityRule::PluginNoPrivileged,
                    message: "Plugin service must not have privileged: true".into(),
                    remediation: "Remove 'privileged: true' from the plugin service.",
                });
            }
        }
        violations
    }

    /// Plugin services must not have network_mode: host
    fn check_plugin_no_host_network(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };
        for (name, service) in services {
            if !is_plugin_service(service) {
                continue;
            }
            if let Some(mode) = service.get("network_mode").and_then(|v| v.as_str()) {
                if mode == "host" {
                    violations.push(SecurityViolation {
                        container: name,
                        rule: SecurityRule::PluginNoHostNetwork,
                        message: "Plugin service must not use network_mode: host".into(),
                        remediation: "Remove 'network_mode: host' from the plugin service.",
                    });
                }
            }
        }
        violations
    }

    /// Validates all volumes for plugin services:
    /// - /tokens mount: correct host path per service_id, mode matches manifest
    /// - /workspace mount: correct host path (project dir), must be :rw
    /// - No other volumes allowed
    /// - Long-form YAML volumes rejected
    /// - Both mounts must be present
    fn check_plugin_volumes(
        doc: &serde_yaml_ng::Value,
        expected_paths: &SecurityExpectedPaths,
        manifests: &[PluginManifest],
    ) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };
        for (name, service) in services {
            if !is_plugin_service(service) {
                continue;
            }
            let sid = name.strip_prefix("mcp-").unwrap_or(&name);
            let manifest = manifests
                .iter()
                .find(|m| m.service_id.as_deref() == Some(sid));
            let manifest = match manifest {
                Some(m) => m,
                None => {
                    violations.push(SecurityViolation {
                        container: name.clone(),
                        rule: SecurityRule::PluginManifestMissing,
                        message: format!(
                            "Plugin service '{}' has no matching manifest — cannot validate mounts",
                            name
                        ),
                        remediation: "Ensure plugin manifests are loaded before security check.",
                    });
                    continue;
                }
            };

            let expected_token_mode = match manifest.token_mount {
                plugin::TokenMount::ReadOnly => "ro",
                plugin::TokenMount::ReadWrite { .. } => "rw",
            };
            let params = VolumeCheckParams {
                container_name: &name,
                expected_tokens_path: format!("{}/{}", expected_paths.tokens_engine_dir(), sid),
                expected_workspace_path: expected_paths.project_engine_path(),
                expected_token_mode,
                // Plugins do not currently use the host-side oauth worker.
                extra_allowed_ro_targets: &[],
                rules: VolumeCheckRules::PLUGIN,
            };
            let (base_violations, _) = validate_service_volume_mounts(service, &params);
            violations.extend(base_violations);
        }
        violations
    }

    /// Validates volumes for built-in mcp-sharepoint service (not a plugin).
    fn check_builtin_sharepoint_volumes(
        doc: &serde_yaml_ng::Value,
        expected_paths: &SecurityExpectedPaths,
    ) -> Vec<SecurityViolation> {
        let services = match get_services(doc) {
            Some(s) => s,
            None => return Vec::new(),
        };

        let (name, service) = match services.iter().find(|(n, _)| n == "mcp-sharepoint") {
            Some(pair) => pair,
            None => return Vec::new(), // SharePoint not in compose (disabled)
        };

        // ADR-060: SharePoint may additionally mount its per-service oauth bearer.
        // After PR3 this list will expand and `expected_token_mode` will drop to "ro".
        let extra_allowed = vec!["/secrets/oauth-auth-token-sharepoint".to_string()];
        let params = VolumeCheckParams {
            container_name: name,
            expected_tokens_path: format!("{}/sharepoint", expected_paths.tokens_engine_dir()),
            expected_workspace_path: expected_paths.project_engine_path(),
            // ADR-060 / PR3: SharePoint is now :ro like every other worker.
            // OAuth token refresh moved to the host-side `oauth` worker.
            expected_token_mode: "ro",
            extra_allowed_ro_targets: &extra_allowed,
            rules: VolumeCheckRules::SHAREPOINT,
        };
        let (violations, _) = validate_service_volume_mounts(service, &params);
        violations
    }

    /// All services must have a valid `user:` field matching the platform-expected value.
    /// This prevents plugins from overriding the container user to gain elevated access.
    fn check_container_user(doc: &serde_yaml_ng::Value) -> Vec<SecurityViolation> {
        let mut violations = Vec::new();
        let services = match get_services(doc) {
            Some(s) => s,
            None => return violations,
        };

        let expected = container_user();
        for (name, service) in services {
            match service.get("user").and_then(|v| v.as_str()) {
                Some(user) if user == expected => {}
                Some(user) => {
                    violations.push(SecurityViolation {
                        container: name.clone(),
                        rule: SecurityRule::ContainerUser,
                        message: format!(
                            "user: \"{}\" does not match expected \"{}\" for this platform",
                            user, expected
                        ),
                        remediation: "Use user: \"${CONTAINER_USER}\" in compose fragments. \
                                      Do not hardcode user values.",
                    });
                }
                None => {
                    violations.push(SecurityViolation {
                        container: name.clone(),
                        rule: SecurityRule::ContainerUser,
                        message: "Missing user: field — container would run as image default user"
                            .into(),
                        remediation: "Add user: \"${CONTAINER_USER}\" to the service definition.",
                    });
                }
            }
        }
        violations
    }

    /// Validates file permissions and ownership on sensitive host paths.
    ///
    /// Unlike other `check_*` methods which validate in-memory compose YAML,
    /// this method performs filesystem I/O — it reads metadata from host paths
    /// under `data_dir`. This is intentional: host file permissions are a
    /// security property that cannot be derived from the compose template.
    ///
    /// Rules:
    /// - Files containing secrets must be 0o600 (owner rw only).
    /// - Directories containing secrets must be 0o700 (owner rwx only).
    /// - All sensitive files/dirs must be owned by the current user (UID match).
    /// - Missing paths are silently skipped — they may not exist yet.
    /// - Symlinks are skipped (not followed) to prevent traversal attacks.
    ///
    /// Known limitations: validates mode bits and UID only, not ACLs or xattrs.
    /// TOCTOU: permissions are checked before container start; a concurrent
    /// change between check and start is theoretically possible but acceptable.
    ///
    /// Performance: scans 1-2 directory levels (not recursive). Bounded by
    /// the number of configured services per project — typically under 10 files.
    /// Negligible compared to compose_up latency.
    #[cfg(unix)]
    pub(crate) fn check_file_security(
        data_dir: &std::path::Path,
        project: &str,
    ) -> Vec<SecurityViolation> {
        use std::os::unix::fs::MetadataExt;
        // Get current user's UID by checking ownership of data_dir itself.
        // This avoids unsafe libc::getuid() while respecting workspace unsafe_code = "deny".
        let expected_uid = match std::fs::metadata(data_dir) {
            Ok(m) => m.uid(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(e) => {
                log::warn!(
                    "check_file_security: cannot read data_dir {}: {e}",
                    data_dir.display()
                );
                return Vec::new();
            }
        };
        Self::check_file_security_with_uid(data_dir, project, expected_uid)
    }

    /// Testable version that accepts an explicit expected UID.
    #[cfg(unix)]
    pub(crate) fn check_file_security_with_uid(
        data_dir: &std::path::Path,
        project: &str,
        expected_uid: u32,
    ) -> Vec<SecurityViolation> {
        let (dirs, files) = crate::fs_security::collect_security_paths(data_dir, project);
        let mut violations = Vec::new();

        for dir in &dirs {
            violations.extend(Self::verify_path(dir, 0o700, true, expected_uid));
        }
        for file in &files {
            violations.extend(Self::verify_path(file, 0o600, false, expected_uid));
        }

        violations
    }

    /// No-op on non-Unix platforms.
    #[cfg(not(unix))]
    pub(crate) fn check_file_security(
        _data_dir: &std::path::Path,
        _project: &str,
    ) -> Vec<SecurityViolation> {
        Vec::new()
    }

    /// Verifies a single path's permissions and ownership.
    /// Returns empty Vec if path is missing or is a symlink.
    #[cfg(unix)]
    fn verify_path(
        path: &std::path::Path,
        expected_mode: u32,
        is_dir: bool,
        expected_uid: u32,
    ) -> Vec<SecurityViolation> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let meta = match std::fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(e) => {
                log::warn!(
                    "verify_path: cannot read metadata for {}: {e}",
                    path.display()
                );
                return Vec::new();
            }
        };
        if meta.file_type().is_symlink() {
            return Vec::new(); // Skip symlinks — prevent traversal attacks
        }

        let mut violations = Vec::new();

        // Ownership check
        if meta.uid() != expected_uid {
            violations.push(SecurityViolation {
                container: "host".into(),
                rule: SecurityRule::FileSecurityViolation,
                message: format!(
                    "{} owned by uid {}, expected uid {}",
                    path.display(),
                    meta.uid(),
                    expected_uid
                ),
                remediation: if is_dir {
                    "Run: chown -R $(id -u) on the directory shown above"
                } else {
                    "Run: chown $(id -u) on the file shown above"
                },
            });
        }

        // Permission check
        let mode = meta.permissions().mode() & 0o777;
        if mode != expected_mode {
            violations.push(SecurityViolation {
                container: "host".into(),
                rule: SecurityRule::FileSecurityViolation,
                message: format!(
                    "{} has mode {:#05o}, expected {:#05o}",
                    path.display(),
                    mode,
                    expected_mode
                ),
                remediation: if is_dir {
                    "Run: chmod 700 on the directory shown above"
                } else {
                    "Run: chmod 600 on the file shown above"
                },
            });
        }

        violations
    }
}

/// Per-rule names and remediation strings for volume validation.
/// Each constant preserves the exact rule names and messages used by plugin
/// and SharePoint security checks so that existing tests and monitoring remain stable.
struct VolumeCheckRules {
    volume_long_form: SecurityRule,
    volume_long_form_msg: &'static str,
    volume_long_form_rem: &'static str,
    token_path_mismatch: SecurityRule,
    token_path_mismatch_rem: &'static str,
    token_mount_mode: SecurityRule,
    token_mount_mode_msg: &'static str,
    token_mount_mode_rem: &'static str,
    workspace_path_mismatch: SecurityRule,
    workspace_mount_mode: SecurityRule,
    workspace_mount_mode_msg: &'static str,
    no_extra_volumes: SecurityRule,
    no_extra_volumes_msg_prefix: &'static str,
    no_extra_volumes_rem: &'static str,
    missing_tokens: SecurityRule,
    missing_tokens_msg: &'static str,
    missing_tokens_rem: &'static str,
    missing_workspace: SecurityRule,
    missing_workspace_msg: &'static str,
    missing_workspace_rem: &'static str,
}

impl VolumeCheckRules {
    const PLUGIN: Self = Self {
        volume_long_form: SecurityRule::PluginVolumeLongForm,
        volume_long_form_msg: "Plugin volume uses long-form YAML mapping \
                               — only short-form strings allowed",
        volume_long_form_rem: "Use short-form volume strings: 'host:container:mode'.",
        token_path_mismatch: SecurityRule::PluginTokenPathMismatch,
        token_path_mismatch_rem: "Token mount must use the project-specific tokens directory.",
        token_mount_mode: SecurityRule::PluginTokenMountMode,
        token_mount_mode_msg: "Token mount mode does not match expected mode",
        token_mount_mode_rem: "Ensure the token volume mount mode matches the expected mode.",
        workspace_path_mismatch: SecurityRule::PluginWorkspacePathMismatch,
        workspace_mount_mode: SecurityRule::PluginWorkspaceMountMode,
        workspace_mount_mode_msg: "Workspace mount must be :rw",
        no_extra_volumes: SecurityRule::PluginNoExtraVolumes,
        no_extra_volumes_msg_prefix: "Plugin service has unauthorized volume mount:",
        no_extra_volumes_rem: "Plugin services may only mount /tokens and /workspace.",
        missing_tokens: SecurityRule::PluginMissingTokensMount,
        missing_tokens_msg: "Plugin service is missing required /tokens mount",
        missing_tokens_rem: "Plugin services must mount /tokens.",
        missing_workspace: SecurityRule::PluginMissingWorkspaceMount,
        missing_workspace_msg: "Plugin service is missing required /workspace mount",
        missing_workspace_rem: "Plugin services must mount /workspace:rw.",
    };

    const SHAREPOINT: Self = Self {
        volume_long_form: SecurityRule::SharepointVolumeLongForm,
        volume_long_form_msg: "SharePoint volume uses long-form YAML mapping",
        volume_long_form_rem: "Use short-form volume strings.",
        token_path_mismatch: SecurityRule::SharepointTokenPathMismatch,
        token_path_mismatch_rem:
            "SharePoint token mount must use the project-specific tokens directory.",
        // ADR-060/PR3: SharePoint is no longer a special case — `/tokens:ro`
        // is the universal rule. The dedicated `SharepointTokenMountMode`
        // variant was removed; we reuse the generic `PluginTokenMountMode`.
        token_mount_mode: SecurityRule::PluginTokenMountMode,
        token_mount_mode_msg: "SharePoint token mount must be :ro (ADR-060)",
        token_mount_mode_rem: "SharePoint refresh moved to the host-side `oauth` worker; \
             /tokens must be :ro like every other worker.",
        workspace_path_mismatch: SecurityRule::SharepointWorkspacePathMismatch,
        workspace_mount_mode: SecurityRule::SharepointWorkspaceMountMode,
        workspace_mount_mode_msg: "SharePoint workspace mount must be :rw",
        no_extra_volumes: SecurityRule::SharepointNoExtraVolumes,
        no_extra_volumes_msg_prefix: "SharePoint service has unauthorized volume mount:",
        no_extra_volumes_rem:
            "SharePoint may mount /tokens, /workspace, and the per-service oauth bearer.",
        missing_tokens: SecurityRule::SharepointMissingTokensMount,
        missing_tokens_msg: "SharePoint service is missing required /tokens mount",
        missing_tokens_rem: "SharePoint must mount /tokens:ro.",
        missing_workspace: SecurityRule::SharepointMissingWorkspaceMount,
        missing_workspace_msg: "SharePoint service is missing required /workspace mount",
        missing_workspace_rem: "SharePoint must mount /workspace:rw.",
    };
}

/// Parameters for shared volume mount validation.
struct VolumeCheckParams<'a> {
    container_name: &'a str,
    expected_tokens_path: String,
    expected_workspace_path: &'a str,
    /// Expected token mount mode: "ro" or "rw"
    expected_token_mode: &'a str,
    /// Additional read-only mount targets that are permitted on this service.
    /// Used by OAuth-consuming workers (ADR-060) to permit their per-service bearer
    /// mount at `/secrets/oauth-auth-token-<service>:ro`. Each entry is matched as
    /// an exact `target` path; the mount must be `:ro` to pass.
    extra_allowed_ro_targets: &'a [String],
    rules: VolumeCheckRules,
}

/// Validates volume mounts on a single service definition.
///
/// Returns the list of violations and, if a /tokens mount was found, its actual
/// mode string (so callers like `check_plugin_volumes` can do additional
/// manifest-specific checks).
fn validate_service_volume_mounts(
    service: &serde_yaml_ng::Value,
    params: &VolumeCheckParams,
) -> (Vec<SecurityViolation>, Option<String>) {
    let mut violations = Vec::new();
    let mut found_tokens = false;
    let mut found_workspace = false;
    let mut token_mode: Option<String> = None;

    if let Some(vols) = service.get("volumes").and_then(|v| v.as_sequence()) {
        for vol in vols {
            let vol_str = match vol.as_str() {
                Some(s) => s,
                None => {
                    violations.push(SecurityViolation {
                        container: params.container_name.to_string(),
                        rule: params.rules.volume_long_form,
                        message: params.rules.volume_long_form_msg.to_string(),
                        remediation: params.rules.volume_long_form_rem,
                    });
                    continue;
                }
            };

            if let Some((host_path, mode)) = extract_volume_for_target(vol_str, "/tokens") {
                found_tokens = true;
                if host_path != params.expected_tokens_path {
                    violations.push(SecurityViolation {
                        container: params.container_name.to_string(),
                        rule: params.rules.token_path_mismatch,
                        message: format!(
                            "Token host path '{}' does not match expected '{}'",
                            host_path, params.expected_tokens_path
                        ),
                        remediation: params.rules.token_path_mismatch_rem,
                    });
                }
                let actual = mode.as_deref().unwrap_or("ro");
                if actual != params.expected_token_mode {
                    violations.push(SecurityViolation {
                        container: params.container_name.to_string(),
                        rule: params.rules.token_mount_mode,
                        message: params.rules.token_mount_mode_msg.to_string(),
                        remediation: params.rules.token_mount_mode_rem,
                    });
                }
                token_mode = Some(actual.to_string());
            } else if let Some((host_path, mode)) = extract_volume_for_target(vol_str, "/workspace")
            {
                found_workspace = true;
                if host_path != params.expected_workspace_path {
                    violations.push(SecurityViolation {
                        container: params.container_name.to_string(),
                        rule: params.rules.workspace_path_mismatch,
                        message: format!(
                            "Workspace host path '{}' does not match expected '{}'",
                            host_path, params.expected_workspace_path
                        ),
                        remediation: "Workspace mount must use the project directory.",
                    });
                }
                if mode.as_deref() != Some("rw") {
                    violations.push(SecurityViolation {
                        container: params.container_name.to_string(),
                        rule: params.rules.workspace_mount_mode,
                        message: params.rules.workspace_mount_mode_msg.to_string(),
                        remediation: "Change the workspace volume mount to :rw.",
                    });
                }
            } else if let Some(extra) = params
                .extra_allowed_ro_targets
                .iter()
                .find_map(|t| extract_volume_for_target(vol_str, t).map(|hp_mode| (t, hp_mode)))
            {
                // Permitted ADR-060 OAuth bearer mount (or future analogous mounts)
                // — must be :ro. host path is opaque (per-project, dynamic).
                let (_target, (_host_path, mode)) = extra;
                let actual = mode.as_deref().unwrap_or("ro");
                if actual != "ro" {
                    violations.push(SecurityViolation {
                        container: params.container_name.to_string(),
                        rule: params.rules.no_extra_volumes,
                        message: format!(
                            "{} {} (must be :ro)",
                            params.rules.no_extra_volumes_msg_prefix, vol_str
                        ),
                        remediation: params.rules.no_extra_volumes_rem,
                    });
                }
            } else {
                violations.push(SecurityViolation {
                    container: params.container_name.to_string(),
                    rule: params.rules.no_extra_volumes,
                    message: format!("{} {}", params.rules.no_extra_volumes_msg_prefix, vol_str),
                    remediation: params.rules.no_extra_volumes_rem,
                });
            }
        }
    }

    if !found_tokens {
        violations.push(SecurityViolation {
            container: params.container_name.to_string(),
            rule: params.rules.missing_tokens,
            message: params.rules.missing_tokens_msg.to_string(),
            remediation: params.rules.missing_tokens_rem,
        });
    }
    if !found_workspace {
        violations.push(SecurityViolation {
            container: params.container_name.to_string(),
            rule: params.rules.missing_workspace,
            message: params.rules.missing_workspace_msg.to_string(),
            remediation: params.rules.missing_workspace_rem,
        });
    }

    (violations, token_mode)
}

/// Checks if a service has the `speedwave.plugin-service: "true"` label.
fn is_plugin_service(service: &serde_yaml_ng::Value) -> bool {
    service
        .get("labels")
        .and_then(|l| l.get("speedwave.plugin-service"))
        .and_then(|v| v.as_str())
        .is_some_and(|s| s == "true")
}

/// Helper: extract services as Vec<(name, &Value)> from a compose YAML doc
pub(crate) fn get_services(
    doc: &serde_yaml_ng::Value,
) -> Option<Vec<(String, &serde_yaml_ng::Value)>> {
    let services = doc.get("services")?.as_mapping()?;
    Some(
        services
            .iter()
            .filter_map(|(key, value)| key.as_str().map(|name| (name.to_string(), value)))
            .collect(),
    )
}
