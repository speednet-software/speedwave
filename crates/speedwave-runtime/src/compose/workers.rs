//! Host-side worker + built-in MCP worker wiring: per-worker Bearer auth
//! tokens, the integrations filter (drop disabled services + their hub env),
//! and the gateway URL a container uses to reach a host-side worker.

use super::{
    add_hub_volume, add_service_env_var, ensure_host_gateway_extra_host, init_secrets_dir_in,
    inject_env_into, inject_worker_env,
};
use crate::config::ResolvedIntegrationsConfig;
use crate::consts;
use crate::engine_path::to_engine_path;
use crate::plugin;

/// Generates per-worker Bearer auth tokens and injects them into the compose YAML.
///
/// For each enabled MCP service:
/// - Reads or generates a UUID v4 token at `~/.speedwave/secrets/<project>/<service>-auth-token`
/// - Injects `MCP_<SERVICE>_AUTH_TOKEN=<token>` env var into the worker container
/// - Mounts the token file as `/secrets/<service>-auth-token:ro` into the hub
///
/// Hub reads tokens from `/secrets/` files (auth-tokens.ts), not env vars.
/// Workers read tokens from env vars. This asymmetry is enforced by `check_no_tokens_in_hub`.
/// Creates the per-project secrets dir under an explicit data dir so render
/// under a tempdir never writes the global `~/.speedwave/secrets`.
/// Injects `SPW_CREDENTIALS_DIGEST` into every enabled MCP worker so a
/// credential rotation changes that worker's config-hash and idempotent
/// `compose up` recreates exactly it (token bytes never enter the YAML).
pub(crate) fn apply_credentials_digests_in(
    data_dir: &std::path::Path,
    yaml: &str,
    project_name: &str,
) -> anyhow::Result<String> {
    let tokens_root = super::resolve_tokens_dir_in(data_dir, project_name);
    apply_credentials_digests(yaml, &tokens_root)
}

/// Testable core of [`apply_credentials_digests_in`] with explicit roots.
fn apply_credentials_digests(yaml: &str, tokens_root: &std::path::Path) -> anyhow::Result<String> {
    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)?;
    let service_names: Vec<String> = doc
        .get("services")
        .and_then(|s| s.as_mapping())
        .map(|m| {
            m.keys()
                .filter_map(|k| k.as_str())
                .filter(|n| n.starts_with("mcp-") && *n != "mcp-hub")
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    for name in service_names {
        // strip_prefix once — trim_start_matches would over-strip a plugin
        // service_id that itself starts with "mcp-" (compose name mcp-mcp-x).
        let key = name.strip_prefix("mcp-").unwrap_or(&name);
        if let Some(digest) = credentials_digest(&tokens_root.join(key))? {
            add_service_env_var(&mut doc, &name, "SPW_CREDENTIALS_DIGEST", &digest)?;
        }
    }
    Ok(serde_yaml_ng::to_string(&doc)?)
}

/// Machine-managed artifacts that change on every routine OAuth refresh —
/// the worker reads them live from its mount, so they must NOT retrigger a
/// recreate (only USER-entered credential rotations should).
const VOLATILE_CREDENTIAL_FILES: &[&str] = &["access_token"];

/// SHA-256 over the worker's user-entered token files (sorted).
/// `Ok(None)` when the worker has no credentials at all — absence vs presence
/// still flips the env var, so the first save also recreates the worker.
/// Transient read errors propagate: a silent flip would churn the worker.
fn credentials_digest(token_dir: &std::path::Path) -> anyhow::Result<Option<String>> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    let mut found = false;
    let entries = match std::fs::read_dir(token_dir) {
        Ok(entries) => Some(entries),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            anyhow::bail!("credentials dir unreadable: {}: {e}", token_dir.display())
        }
    };
    if let Some(entries) = entries {
        let mut files: Vec<std::path::PathBuf> = entries
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(|e| e.path())
            .filter(|p| !p.is_symlink() && p.is_file())
            .filter(|p| {
                p.file_name()
                    .map(|n| {
                        !VOLATILE_CREDENTIAL_FILES
                            .iter()
                            .any(|v| n == std::ffi::OsStr::new(v))
                    })
                    .unwrap_or(false)
            })
            .collect();
        files.sort();
        for f in files {
            let bytes = std::fs::read(&f)?;
            if let Some(name) = f.file_name() {
                hasher.update(name.to_string_lossy().as_bytes());
                hasher.update([0u8]);
                hasher.update(&bytes);
                found = true;
            }
        }
    }
    if !found {
        return Ok(None);
    }
    let mut hex = crate::bundle::bytes_to_hex(&hasher.finalize());
    hex.truncate(16);
    Ok(Some(hex))
}

pub(crate) fn apply_worker_auth_tokens_in(
    data_dir: &std::path::Path,
    yaml: &str,
    project_name: &str,
    integrations: &ResolvedIntegrationsConfig,
) -> anyhow::Result<String> {
    let secrets_dir = init_secrets_dir_in(data_dir, project_name)?;
    let plugins = plugin::list_installed_plugins().unwrap_or_default();
    apply_worker_auth_tokens_with_dir(yaml, &secrets_dir, integrations, &plugins)
}

/// Testable version: accepts explicit secrets directory and plugin list.
/// Reads or generates a Bearer auth token, writes it atomically with 0o600
/// permissions, injects the env var into the worker container, and mounts
/// the token file into the hub.
fn ensure_worker_auth_token(
    doc: &mut serde_yaml_ng::Value,
    secrets_dir: &std::path::Path,
    token_key: &str,
    compose_name: &str,
    env_key: &str,
) -> anyhow::Result<()> {
    let token_file_name = format!("{token_key}-auth-token");
    let token_path = secrets_dir.join(&token_file_name);

    // Reject symlinks before is_file() — is_file() follows symlinks and would
    // return true for a symlink pointing at a regular file, letting an
    // attacker with write access to the secrets dir substitute the auth
    // token. Falls through to the cleanup branch which logs and removes the
    // planted symlink.
    let token = if !token_path.is_symlink() && token_path.is_file() {
        let content = std::fs::read_to_string(&token_path)?.trim().to_string();
        if content.is_empty() {
            log::warn!(
                "Token file at {} is empty — generating new auth token; MCP workers will require restart",
                token_path.display()
            );
            uuid::Uuid::new_v4().to_string()
        } else {
            content
        }
    } else {
        if token_path.is_symlink() {
            log::warn!(
                "Stale symlink at token location, removing: {}",
                token_path.display()
            );
            std::fs::remove_file(&token_path)?;
        } else if token_path.exists() {
            log::warn!(
                "Unexpected directory at token location {}, removing recursively",
                token_path.display()
            );
            std::fs::remove_dir_all(&token_path)?;
        }
        uuid::Uuid::new_v4().to_string()
    };

    // Atomic write with 0o600 permissions (pattern from update.rs).
    // Use a unique suffix to avoid collisions when multiple callers write
    // the same token file concurrently (e.g., parallel tests or processes).
    let tmp_name = format!("{}.{}.tmp", token_file_name, uuid::Uuid::new_v4());
    let tmp_path = secrets_dir.join(&tmp_name);
    std::fs::write(&tmp_path, &token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp_path, &token_path)?;

    // Inject env var into worker container (fail-loud)
    add_service_env_var(doc, compose_name, env_key, &token)?;

    // Mount token file into hub as /secrets/<service>-auth-token:ro
    add_hub_volume(
        doc,
        &format!(
            "{}:/secrets/{}:ro",
            to_engine_path(&token_path)?,
            token_file_name
        ),
    );

    Ok(())
}

/// Testable version: accepts explicit secrets directory and plugin list.
pub(crate) fn apply_worker_auth_tokens_with_dir(
    yaml: &str,
    secrets_dir: &std::path::Path,
    integrations: &ResolvedIntegrationsConfig,
    installed_plugins: &[plugin::PluginManifest],
) -> anyhow::Result<String> {
    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)?;

    for svc in consts::TOGGLEABLE_MCP_SERVICES {
        if !integrations
            .is_service_enabled(svc.config_key)
            .unwrap_or(false)
        {
            continue;
        }
        let env_key = format!("MCP_{}_AUTH_TOKEN", svc.config_key.to_uppercase());
        ensure_worker_auth_token(
            &mut doc,
            secrets_dir,
            svc.config_key,
            svc.compose_name,
            &env_key,
        )?;
    }

    // Generate auth tokens for enabled plugin MCP workers (same pattern as built-in)
    for manifest in installed_plugins {
        let sid = match manifest.service_id.as_deref() {
            Some(s) => s,
            None => continue,
        };
        if !integrations.is_plugin_enabled(sid) {
            continue;
        }
        let compose_name = plugin::derive_compose_name(sid);
        let env_key = format!("MCP_{}_AUTH_TOKEN", sid.to_uppercase().replace('-', "_"));
        ensure_worker_auth_token(&mut doc, secrets_dir, sid, &compose_name, &env_key)?;
    }

    Ok(serde_yaml_ng::to_string(&doc)?)
}

/// Service IDs enabled by `integrations`, as the hub's `ENABLED_SERVICES` expects:
/// built-in MCP config keys (`slack`, ...), `os` when any OS sub-integration is on,
/// `host_exec` when enabled (host-side, no image — ADR-054), and enabled plugin
/// service IDs. Excludes the always-on `claude` / `mcp-hub`.
/// SSOT for `apply_integrations_filter`'s `ENABLED_SERVICES`; `build::enabled_images`
/// uses the same per-service predicate (`is_service_enabled`) on the `IMAGES` list.
pub fn enabled_hub_service_ids(integrations: &ResolvedIntegrationsConfig) -> Vec<String> {
    let mut ids: Vec<String> = consts::TOGGLEABLE_MCP_SERVICES
        .iter()
        .filter(|svc| integrations.is_service_enabled(svc.config_key) == Some(true))
        .map(|svc| svc.config_key.to_string())
        .collect();
    if integrations.any_os_enabled() {
        ids.push("os".to_string());
    }
    if integrations.host_exec {
        ids.push("host_exec".to_string());
    }
    ids.extend(
        integrations
            .enabled_plugin_service_ids()
            .into_iter()
            .map(String::from),
    );
    ids
}

/// Filters compose services based on integrations config.
/// - Removes disabled MCP service containers from the `services` map
/// - Removes corresponding WORKER_*_URL from hub environment
/// - Injects ENABLED_SERVICES (comma-separated, see [`enabled_hub_service_ids`])
///   into both the `mcp-hub` (for tool routing) and the `claude` container
///   (so `entrypoint.sh` can gate per-integration claude-resources)
/// - Injects DISABLED_OS_SERVICES into both `mcp-hub` (for sub-tool routing) and
///   `claude` (so `entrypoint.sh` can gate per-OS-sub-service claude-resources)
///   when any OS sub-integrations are disabled
pub(crate) fn apply_integrations_filter(
    yaml: &str,
    integrations: &ResolvedIntegrationsConfig,
    network_name: &str,
) -> anyhow::Result<String> {
    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)?;

    let service_enabled = |key: &str| -> bool {
        integrations.is_service_enabled(key).unwrap_or_else(|| {
            log::warn!(
                "apply_integrations_filter: unknown service key '{}', treating as disabled",
                key
            );
            false
        })
    };

    // Drop disabled MCP worker containers + their hub env vars.
    for svc in consts::TOGGLEABLE_MCP_SERVICES {
        if service_enabled(svc.config_key) {
            continue;
        }
        if let Some(services) = doc.get_mut("services") {
            if let Some(services_map) = services.as_mapping_mut() {
                services_map.remove(serde_yaml_ng::Value::String(svc.compose_name.to_string()));
            }
        }
        remove_env_from(&mut doc, "mcp-hub", svc.worker_env);
        // An egress-less worker (e.g. office, ADR-055) has its own internal network
        // `{NETWORK_NAME}_{config_key}`; when it is disabled, drop that network and the
        // hub's attachment to it so the rendered compose has no dangling internal network.
        if svc.egress_less {
            let net = format!("{network_name}_{}", svc.config_key);
            if let Some(map) = doc.get_mut("networks").and_then(|n| n.as_mapping_mut()) {
                map.remove(serde_yaml_ng::Value::String(net.clone()));
            }
            if let Some(nets) = doc
                .get_mut("services")
                .and_then(|s| s.get_mut("mcp-hub"))
                .and_then(|h| h.get_mut("networks"))
                .and_then(|n| n.as_sequence_mut())
            {
                nets.retain(|n| n.as_str() != Some(net.as_str()));
            }
        }
    }

    // Hub uses ENABLED_SERVICES for tool routing; claude entrypoint uses it to gate claude-resources.
    let enabled_csv = enabled_hub_service_ids(integrations).join(",");
    log::debug!("integrations filter: enabled_services={}", enabled_csv);
    inject_env_into(&mut doc, "mcp-hub", "ENABLED_SERVICES", &enabled_csv);
    inject_env_into(&mut doc, "claude", "ENABLED_SERVICES", &enabled_csv);

    // Hub uses DISABLED_OS_SERVICES for sub-tool routing; claude entrypoint uses it to gate OS sub-service skills.
    let disabled_os: Vec<&str> = consts::TOGGLEABLE_OS_SERVICES
        .iter()
        .filter(|svc| {
            !integrations
                .is_os_service_enabled(svc.config_key)
                .unwrap_or(false)
        })
        .map(|svc| svc.config_key)
        .collect();
    if !disabled_os.is_empty() {
        let disabled_csv = disabled_os.join(",");
        log::debug!("integrations filter: disabled_os={}", disabled_csv);
        inject_env_into(&mut doc, "mcp-hub", "DISABLED_OS_SERVICES", &disabled_csv);
        inject_env_into(&mut doc, "claude", "DISABLED_OS_SERVICES", &disabled_csv);
    }

    // OS_AVAILABLE_SUBS lets entrypoint.sh iterate sub-services without hardcoding the list.
    let os_available_csv = consts::TOGGLEABLE_OS_SERVICES
        .iter()
        .map(|svc| svc.config_key)
        .collect::<Vec<_>>()
        .join(",");
    inject_env_into(&mut doc, "claude", "OS_AVAILABLE_SUBS", &os_available_csv);

    Ok(serde_yaml_ng::to_string(&doc)?)
}

/// Removes an environment variable from an arbitrary service's `environment`
/// sequence. No-op if the service or its `environment` sequence is absent —
/// same posture as [`inject_env_into`].
pub(crate) fn remove_env_from(doc: &mut serde_yaml_ng::Value, service: &str, env_name: &str) {
    let Some(services) = doc.get_mut("services") else {
        return;
    };
    let Some(svc) = services.get_mut(service) else {
        return;
    };
    let Some(environment) = svc.get_mut("environment") else {
        return;
    };
    let Some(env_seq) = environment.as_sequence_mut() else {
        return;
    };
    env_seq.retain(|item| {
        item.as_str()
            .map(|s| s.split('=').next() != Some(env_name))
            .unwrap_or(true)
    });
}

/// Inject `<env_var>=<gateway-url>` + mount `<token_mount_path>:/secrets/<secret_name>:ro`
/// into the hub iff `lock.json` is readable and the mount-token file exists.
/// No-op (returns unchanged YAML) when files absent — any read failure is
/// treated as not running (avoids TOCTOU vs runtime respawn).
pub(crate) fn apply_worker_config(
    yaml: &str,
    label: &str,
    token_mount_path: &std::path::Path,
    lock_path: &std::path::Path,
    service: crate::host_mcp_process::lock::LockService,
    env_var: &str,
    secret_name: &str,
) -> anyhow::Result<String> {
    // PID-liveness gate (symmetric to apply_oauth_config_with_paths): a stale
    // lock.json after a Desktop hard-kill would inject a dead WORKER_*_URL.
    let port = match crate::host_mcp_process::lock::read(lock_path, service) {
        Some(l) if crate::host_mcp_process::probe::is_pid_alive(l.pid) => l.port,
        _ => return Ok(yaml.to_string()),
    };
    let token = match std::fs::read_to_string(token_mount_path) {
        Ok(s) => s.trim().to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(yaml.to_string()),
        Err(e) => {
            log::debug!("{label} token mount read failed ({e}); treating as not running");
            return Ok(yaml.to_string());
        }
    };
    if token.is_empty() {
        return Ok(yaml.to_string());
    }
    let url = worker_gateway_url(port);

    let mut doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml)?;
    ensure_host_gateway_extra_host(&mut doc, "mcp-hub")?;
    inject_worker_env(&mut doc, env_var, &url);
    add_hub_volume(
        &mut doc,
        &format!(
            "{}:/secrets/{secret_name}:ro",
            to_engine_path(token_mount_path)?
        ),
    );
    Ok(serde_yaml_ng::to_string(&doc)?)
}

/// Read a worker's port from its `lock.json`. Test-only since the production
/// paths now read the full lock to also gate on PID liveness.
#[cfg(test)]
pub(crate) fn read_lock_port(
    lock_path: &std::path::Path,
    service: crate::host_mcp_process::lock::LockService,
) -> Option<u16> {
    crate::host_mcp_process::lock::read(lock_path, service).map(|lock| lock.port)
}

/// Read a worker's `port` file. `None` when missing or unparseable; warns on invalid content.
#[cfg(test)]
pub(crate) fn read_worker_port_file(port_path: &std::path::Path, label: &str) -> Option<u16> {
    let content = std::fs::read_to_string(port_path).ok()?;
    match content.trim().parse::<u16>() {
        Ok(p) => Some(p),
        Err(e) => {
            log::warn!(
                "invalid {label} port file content '{}': {e}",
                content.trim()
            );
            None
        }
    }
}

/// Test-only alias — implementation is `read_worker_port_file`.
#[cfg(test)]
pub(crate) fn read_host_exec_port(port_path: &std::path::Path) -> Option<u16> {
    read_worker_port_file(port_path, "host_exec")
}

/// URL where a host-side worker listens, as seen from inside a container.
pub(crate) fn worker_gateway_url(port: u16) -> String {
    format!("http://{}:{port}", consts::HOST_GATEWAY_ALIAS)
}

/// Test-only alias — implementation is `worker_gateway_url`.
#[cfg(test)]
pub(crate) fn mcp_os_gateway_url(port: u16) -> String {
    worker_gateway_url(port)
}

/// Test-only alias — implementation is `worker_gateway_url`.
#[cfg(test)]
pub(crate) fn host_exec_gateway_url(port: u16) -> String {
    worker_gateway_url(port)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod credentials_digest_tests {
    use super::*;

    const YAML: &str = "services:\n  mcp-hub:\n    image: hub\n  mcp-slack:\n    image: slack\n  mcp-github:\n    image: gh\n";
    const YAML2: &str = "services:\n  mcp-hub:\n    image: hub\n  mcp-sharepoint:\n    image: sp\n";

    fn env_of<'a>(yaml: &'a str, svc: &str) -> Option<String> {
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml).unwrap();
        let env = doc["services"][svc].get("environment")?;
        env.as_sequence()?
            .iter()
            .filter_map(|v| v.as_str())
            .find(|s| s.starts_with("SPW_CREDENTIALS_DIGEST="))
            .map(str::to_string)
    }

    #[test]
    fn injects_digest_only_into_workers_with_credentials() {
        let tmp = tempfile::tempdir().unwrap();
        let tokens = tmp.path().join("tokens");
        std::fs::create_dir_all(tokens.join("slack")).unwrap();
        std::fs::write(tokens.join("slack").join("bot_token"), "xoxb-1").unwrap();
        let out = apply_credentials_digests(YAML, &tokens).unwrap();
        assert!(env_of(&out, "mcp-slack").is_some(), "slack has credentials");
        assert!(env_of(&out, "mcp-github").is_none(), "github has none");
        assert!(env_of(&out, "mcp-hub").is_none(), "hub must never get one");
    }

    #[test]
    fn rotation_changes_digest_for_that_worker_only() {
        let tmp = tempfile::tempdir().unwrap();
        let tokens = tmp.path().join("tokens");
        for svc in ["slack", "github"] {
            std::fs::create_dir_all(tokens.join(svc)).unwrap();
            std::fs::write(tokens.join(svc).join("token"), "old").unwrap();
        }
        let oauth = tmp.path().join("oauth");
        let before = apply_credentials_digests(YAML, &tokens).unwrap();
        std::fs::write(tokens.join("slack").join("token"), "rotated").unwrap();
        let after = apply_credentials_digests(YAML, &tokens).unwrap();
        assert_ne!(
            env_of(&before, "mcp-slack"),
            env_of(&after, "mcp-slack"),
            "rotated token must change the digest (config-hash recreate)"
        );
        assert_eq!(
            env_of(&before, "mcp-github"),
            env_of(&after, "mcp-github"),
            "untouched worker keeps its digest"
        );
    }

    #[test]
    fn volatile_oauth_artifacts_do_not_change_digest() {
        let tmp = tempfile::tempdir().unwrap();
        let tokens = tmp.path().join("tokens");
        std::fs::create_dir_all(tokens.join("sharepoint")).unwrap();
        std::fs::write(tokens.join("sharepoint").join("client_secret"), "s3cret").unwrap();
        std::fs::write(tokens.join("sharepoint").join("access_token"), "tok-A").unwrap();
        let before = apply_credentials_digests(YAML2, &tokens).unwrap();
        // Routine refresh rewrites access_token — must NOT recreate the worker.
        std::fs::write(tokens.join("sharepoint").join("access_token"), "tok-B").unwrap();
        let after = apply_credentials_digests(YAML2, &tokens).unwrap();
        assert_eq!(
            env_of(&before, "mcp-sharepoint"),
            env_of(&after, "mcp-sharepoint"),
            "machine-managed access_token churn must not change the digest"
        );
        // But rotating the USER-entered secret must.
        std::fs::write(tokens.join("sharepoint").join("client_secret"), "rotated").unwrap();
        let rotated = apply_credentials_digests(YAML2, &tokens).unwrap();
        assert_ne!(
            env_of(&after, "mcp-sharepoint"),
            env_of(&rotated, "mcp-sharepoint")
        );
    }

    #[test]
    #[cfg(unix)]
    fn transient_unreadable_dir_is_an_error_not_a_silent_flip() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let tokens = tmp.path().join("tokens");
        let dir = tokens.join("slack");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("token"), "t").unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        let result = apply_credentials_digests(YAML, &tokens);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            result.is_err(),
            "unreadable creds must fail the render, not silently drop the env var"
        );
    }

    #[test]
    fn no_credentials_anywhere_yields_unchanged_services() {
        let tmp = tempfile::tempdir().unwrap();
        let out = apply_credentials_digests(YAML, &tmp.path().join("tokens")).unwrap();
        for svc in ["mcp-slack", "mcp-github", "mcp-hub"] {
            assert!(env_of(&out, svc).is_none());
        }
    }

    #[test]
    fn symlinked_token_file_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let tokens = tmp.path().join("tokens");
        std::fs::create_dir_all(tokens.join("slack")).unwrap();
        let outside = tmp.path().join("outside");
        std::fs::write(&outside, "evil").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, tokens.join("slack").join("token")).unwrap();
        let out = apply_credentials_digests(YAML, &tokens).unwrap();
        // Error path: symlinks never feed the digest (mirrors signing policy).
        assert!(env_of(&out, "mcp-slack").is_none());
    }
}
