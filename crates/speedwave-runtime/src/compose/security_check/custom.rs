//! Custom MCP rules of the start gate: every service known, consent from the current config,
//! pinned images, exact mounts and networks per role, no escape hatches, bounded resources.

use super::super::custom_host;
use super::super::custom_mcp::{self as shape, Role};
use super::super::networks;
use super::{
    get_services, is_plugin_service, service_network_refs, SecurityExpectedPaths, SecurityRule,
    SecurityViolation,
};
use crate::consts;
use crate::custom_mcp::expect::ExpectedCustomServer;
use crate::custom_mcp::model::{self, WorkspaceMode};
use crate::custom_mcp::paths::{self, ServerSubdir};
use crate::custom_mcp::policy::GuardMode;
use crate::engine_path::to_engine_path;
use serde_yaml_ng::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

const ALLOWED_KEYS: &[&str] = &[
    "image",
    "pull_policy",
    "container_name",
    "read_only",
    "user",
    "cap_drop",
    "security_opt",
    "tmpfs",
    "labels",
    "deploy",
    "volumes",
    "environment",
    "networks",
];

const LABEL_KEYS: &[&str] = &[shape::ROLE_LABEL, shape::ID_LABEL, shape::CONSENT_LABEL];

/// The top-level service keys a Custom MCP container of `role` may carry: the hardened block,
/// plus `entrypoint` on the egress and `extra_hosts` on a host guard.
fn allowed_keys(role: Role, mode: GuardMode) -> Vec<&'static str> {
    let mut keys = ALLOWED_KEYS.to_vec();
    match (role, mode) {
        (Role::Egress, _) => keys.push("entrypoint"),
        (Role::Guard, GuardMode::Host) => keys.push("extra_hosts"),
        _ => {}
    }
    keys
}

/// `true` for a service carrying the Custom MCP role label, valid or not.
pub(super) fn has_custom_label(service: &Value) -> bool {
    service
        .get("labels")
        .and_then(|l| l.get(shape::ROLE_LABEL))
        .is_some()
}

struct CustomService<'a> {
    name: &'a str,
    role: Role,
    id: String,
    service: &'a Value,
}

fn violation(
    container: &str,
    rule: SecurityRule,
    message: String,
    remediation: &'static str,
) -> SecurityViolation {
    SecurityViolation::new(container, rule, message, remediation)
}

const RERENDER: &str =
    "Run render_compose() again; Custom MCP services come only from the renderer.";

fn env_entries(service: &Value) -> Option<Vec<(String, String)>> {
    match service.get("environment") {
        None => Some(Vec::new()),
        Some(Value::Sequence(seq)) => seq
            .iter()
            .map(|item| {
                let entry = item.as_str()?;
                let (k, v) = entry.split_once('=')?;
                Some((k.to_string(), v.to_string()))
            })
            .collect(),
        Some(_) => None,
    }
}

fn env_value(service: &Value, key: &str) -> Option<String> {
    env_entries(service)?
        .into_iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v)
}

/// The guard mode a guard runs in: the approved one, else what its env says.
fn guard_mode(cs: &CustomService<'_>, expected: Option<&ExpectedCustomServer>) -> GuardMode {
    match expected {
        Some(e) => e.mode,
        None if env_value(cs.service, "SPW_CUSTOM_MODE").as_deref() == Some("host") => {
            GuardMode::Host
        }
        None => GuardMode::Npm,
    }
}

fn classify<'a>(
    services: &'a [(String, &'a Value)],
) -> (Vec<CustomService<'a>>, Vec<SecurityViolation>) {
    let mut customs = Vec::new();
    let mut violations = Vec::new();
    for (name, service) in services {
        if has_custom_label(service) {
            if is_plugin_service(service) {
                violations.push(violation(
                    name,
                    SecurityRule::UnknownService,
                    "service carries both the plugin and the Custom MCP label".into(),
                    RERENDER,
                ));
                continue;
            }
            match shape::role_of(service) {
                Some((role, id))
                    if model::validate_server_name(&id).is_ok()
                        && role.service_name(&id) == *name =>
                {
                    customs.push(CustomService {
                        name: name.as_str(),
                        role,
                        id,
                        service,
                    });
                }
                _ => violations.push(violation(
                    name,
                    SecurityRule::UnknownService,
                    format!(
                        "Custom MCP labels on '{name}' do not name a valid server and a role \
                         matching the service name"
                    ),
                    RERENDER,
                )),
            }
        } else if !consts::BUILT_IN_SERVICES.contains(&name.as_str()) && !is_plugin_service(service)
        {
            violations.push(violation(
                name,
                SecurityRule::UnknownService,
                format!("'{name}' is neither a built-in service, a plugin nor a Custom MCP server"),
                "Remove the service: only the renderer may add services to the compose file.",
            ));
        }
    }
    (customs, violations)
}

fn check_consent(
    customs: &[CustomService<'_>],
    expected: &SecurityExpectedPaths,
) -> Vec<SecurityViolation> {
    const FIX: &str = "Approve the server again in Speedwave Desktop, or restart the project so \
                       the compose is rendered from the current configuration.";
    let mut out = Vec::new();
    for cs in customs {
        let Some(e) = expected.custom_mcp().server(&cs.id) else {
            out.push(violation(
                cs.name,
                SecurityRule::CustomMcpConsent,
                format!(
                    "Custom MCP server '{}' is not approved and enabled in the current \
                     configuration",
                    cs.id
                ),
                FIX,
            ));
            continue;
        };
        let label = cs
            .service
            .get("labels")
            .and_then(|l| l.get(shape::CONSENT_LABEL))
            .and_then(Value::as_str);
        let want: String = e
            .consent_digest
            .chars()
            .take(shape::CONSENT_LABEL_CHARS)
            .collect();
        if label != Some(want.as_str()) {
            out.push(violation(
                cs.name,
                SecurityRule::CustomMcpConsent,
                format!(
                    "consent label {label:?} of '{}' does not match the approved consent {want}",
                    cs.id
                ),
                FIX,
            ));
        }
        if e.mode == GuardMode::Host && cs.role != Role::Guard {
            out.push(violation(
                cs.name,
                SecurityRule::CustomMcpConsent,
                format!(
                    "'{}' is approved as a host server, which runs no {} container",
                    cs.id,
                    cs.role.label()
                ),
                FIX,
            ));
        }
    }
    out
}

fn sequence_of_strings(value: Option<&Value>) -> Option<Vec<String>> {
    value?
        .as_sequence()?
        .iter()
        .map(|v| v.as_str().map(str::to_string))
        .collect()
}

fn check_images(
    customs: &[CustomService<'_>],
    expected: &SecurityExpectedPaths,
) -> Vec<SecurityViolation> {
    const FIX: &str = "Run render_compose() again: Custom MCP images are pinned by the renderer.";
    let mut out = Vec::new();
    for cs in customs {
        let mut fail = |msg: String| {
            out.push(violation(cs.name, SecurityRule::CustomMcpImage, msg, FIX));
        };
        let image = cs
            .service
            .get("image")
            .and_then(Value::as_str)
            .unwrap_or("");
        if cs.service.get("pull_policy").and_then(Value::as_str) != Some("never") {
            fail("pull_policy must be never".into());
        }
        if cs.service.get("command").is_some() {
            fail("a command override is not allowed".into());
        }
        let entrypoint = cs.service.get("entrypoint");
        match cs.role {
            Role::Guard => {
                if !image.starts_with(&format!("{}:", crate::build::IMAGE_MCP_CUSTOM_GUARD)) {
                    fail(format!(
                        "guard image {image:?} is not the Custom MCP guard image"
                    ));
                }
                if entrypoint.is_some() {
                    fail("an entrypoint override is not allowed on the guard".into());
                }
            }
            Role::Server => {
                let approved = expected
                    .custom_mcp()
                    .server(&cs.id)
                    .and_then(|e| e.image_tag.clone());
                if !crate::custom_mcp::build::is_server_image_tag(&cs.id, image)
                    || approved.as_deref().is_some_and(|tag| tag != image)
                {
                    fail(format!(
                        "server image {image:?} is not the approved image {approved:?}"
                    ));
                }
                if entrypoint.is_some() {
                    fail("an entrypoint override is not allowed on the server".into());
                }
            }
            Role::Egress => {
                if !image.starts_with(&format!("{}:", crate::build::IMAGE_PROXY)) {
                    fail(format!("egress image {image:?} is not the proxy image"));
                }
                if sequence_of_strings(entrypoint)
                    != Some(vec![shape::EGRESS_ENTRYPOINT.to_string()])
                {
                    fail(format!(
                        "egress entrypoint must be exactly [\"{}\"]",
                        shape::EGRESS_ENTRYPOINT
                    ));
                }
            }
        }
    }
    out
}

fn engine_subdir(data_dir: &Path, project: &str, id: &str, sub: ServerSubdir) -> Option<String> {
    to_engine_path(&paths::subdir_in(data_dir, project, id, sub).ok()?).ok()
}

fn expected_volumes(
    cs: &CustomService<'_>,
    exp: Option<&ExpectedCustomServer>,
    expected: &SecurityExpectedPaths,
    data_dir: &Path,
    project: &str,
) -> Option<BTreeSet<String>> {
    let mut out = BTreeSet::new();
    match cs.role {
        Role::Guard => {
            out.insert(format!(
                "{}:/policy:ro",
                engine_subdir(data_dir, project, &cs.id, ServerSubdir::Guard)?
            ));
            if guard_mode(cs, exp) == GuardMode::Host {
                let relay =
                    crate::custom_mcp::paths::relay_dir_in(data_dir, project, &cs.id).ok()?;
                out.insert(format!(
                    "{}:{}:ro",
                    to_engine_path(&relay).ok()?,
                    custom_host::RELAY_MOUNT
                ));
            }
        }
        Role::Server => {
            out.insert(format!(
                "{}:/tokens:ro",
                crate::engine_path::vm_path_join(
                    expected.tokens_engine_dir(),
                    &model::service_id(&cs.id)
                )
            ));
            let mode = match exp.map(|e| e.workspace_mode) {
                Some(WorkspaceMode::ReadOnly) => Some("ro"),
                Some(WorkspaceMode::ReadWrite) => Some("rw"),
                Some(WorkspaceMode::None) | None => None,
            };
            if let Some(mode) = mode {
                out.insert(format!(
                    "{}:/workspace:{mode}",
                    expected.project_engine_path()
                ));
            }
        }
        Role::Egress => {
            out.insert(format!(
                "{}:/config:ro",
                engine_subdir(data_dir, project, &cs.id, ServerSubdir::Egress)?
            ));
        }
    }
    Some(out)
}

fn check_volumes(
    doc: &Value,
    customs: &[CustomService<'_>],
    expected: &SecurityExpectedPaths,
    data_dir: &Path,
    project: &str,
) -> Vec<SecurityViolation> {
    const FIX: &str = "Run render_compose() again: Custom MCP mounts are fixed per role.";
    let mut out = Vec::new();
    for cs in customs {
        let exp = expected.custom_mcp().server(&cs.id);
        let Some(volumes) = (match cs.service.get("volumes") {
            None => Some(Vec::new()),
            v => sequence_of_strings(v),
        }) else {
            out.push(violation(
                cs.name,
                SecurityRule::CustomMcpVolumes,
                "volumes must be short-form strings".into(),
                FIX,
            ));
            continue;
        };
        let Some(want) = expected_volumes(cs, exp, expected, data_dir, project) else {
            out.push(violation(
                cs.name,
                SecurityRule::CustomMcpVolumes,
                "cannot compute the expected Custom MCP mount sources".into(),
                FIX,
            ));
            continue;
        };
        let got: BTreeSet<String> = volumes.iter().cloned().collect();
        if got != want || got.len() != volumes.len() {
            out.push(violation(
                cs.name,
                SecurityRule::CustomMcpVolumes,
                format!("volumes {volumes:?} differ from the expected {want:?}"),
                FIX,
            ));
        }
    }
    let hub_mounts_launcher = doc
        .get("services")
        .and_then(|s| s.get("mcp-hub"))
        .and_then(|h| h.get("volumes"))
        .and_then(Value::as_sequence)
        .is_some_and(|vols| {
            vols.iter().any(|v| {
                let text = v
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| serde_yaml_ng::to_string(v).unwrap_or_default());
                text.contains("-launcher-token")
            })
        });
    if hub_mounts_launcher {
        out.push(violation(
            "mcp-hub",
            SecurityRule::CustomMcpVolumes,
            "the hub mounts a Custom MCP launcher bearer".into(),
            FIX,
        ));
    }
    out.extend(check_hub_secrets_mounts(doc, data_dir, project));
    out
}

/// `true` when the normalized paths `a` and `b` are equal or one lies under the other,
/// ignoring ASCII case (the host file systems behind the engine paths may fold it).
fn paths_overlap(a: &str, b: &str) -> bool {
    let a = super::normalize_mount_target(a).to_ascii_lowercase();
    let b = super::normalize_mount_target(b).to_ascii_lowercase();
    let under = |inner: &str, outer: &str| {
        inner == outer || outer == "/" || inner.starts_with(&format!("{outer}/"))
    };
    under(&a, &b) || under(&b, &a)
}

/// `true` for exactly `<secrets>/<sid>-auth-token:/secrets/<sid>-auth-token:ro`.
fn is_hub_bearer_mount(entry: &str, secrets: &str) -> bool {
    let Some((source, target, Some("ro"))) = super::parse_short_form_volume(entry) else {
        return false;
    };
    let Some(file) = source
        .strip_prefix(secrets)
        .and_then(|rest| rest.strip_prefix('/'))
    else {
        return false;
    };
    file.strip_suffix("-auth-token").is_some_and(|sid| {
        !sid.is_empty()
            && sid
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_'))
    }) && target == format!("/secrets/{file}")
}

/// The hub may mount nothing of the project's secrets dir (the launcher bearers live there)
/// but the worker bearer files, each as exactly `<secrets>/<sid>-auth-token:/secrets/…:ro`.
fn check_hub_secrets_mounts(doc: &Value, data_dir: &Path, project: &str) -> Vec<SecurityViolation> {
    const FIX: &str = "Run render_compose() again: the hub mounts only the worker bearer files of \
                       the secrets dir, one file each, read-only.";
    let Some(volumes) = doc
        .get("services")
        .and_then(|s| s.get("mcp-hub"))
        .and_then(|h| h.get("volumes"))
        .and_then(Value::as_sequence)
    else {
        return Vec::new();
    };
    let Ok(secrets) = to_engine_path(&super::super::secrets_dir_in(data_dir, project)) else {
        return vec![violation(
            "mcp-hub",
            SecurityRule::CustomMcpVolumes,
            "cannot compute the project's secrets dir".into(),
            FIX,
        )];
    };
    let mut out = Vec::new();
    for vol in volumes {
        let source = match vol.as_str() {
            Some(entry) => super::parse_short_form_volume(entry).map(|(s, _, _)| s.to_string()),
            None => super::mount_source(vol),
        };
        let Some(source) = source.filter(|s| paths_overlap(s, &secrets)) else {
            continue;
        };
        if vol
            .as_str()
            .is_some_and(|entry| is_hub_bearer_mount(entry, &secrets))
        {
            continue;
        }
        out.push(violation(
            "mcp-hub",
            SecurityRule::CustomMcpVolumes,
            format!("the hub mounts '{source}', which overlaps the secrets dir '{secrets}'"),
            FIX,
        ));
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CustomNet {
    Hub,
    HubHost,
    Server(String),
    Egress(String),
}

fn custom_net_of(network: &str) -> Option<CustomNet> {
    if let Some(id) = networks::custom_server_of_network(network) {
        return Some(CustomNet::Server(id.to_string()));
    }
    if network.ends_with("_network_custom_host") {
        return Some(CustomNet::HubHost);
    }
    if network.ends_with("_network_custom") {
        return Some(CustomNet::Hub);
    }
    let (_, id) = network.rsplit_once("_network_eg_")?;
    Some(CustomNet::Egress(id.to_string()))
}

fn check_networks(
    doc: &Value,
    services: &[(String, &Value)],
    customs: &[CustomService<'_>],
    expected: &SecurityExpectedPaths,
    project: &str,
) -> Vec<SecurityViolation> {
    const FIX: &str =
        "Run render_compose() again: Custom MCP network membership is fixed per role.";
    let mut out = Vec::new();
    let main = networks::project_network_name(project);
    let custom = networks::custom_network_name(&main);
    let custom_host = networks::custom_host_network_name(&main);

    let declared = doc.get("networks").and_then(Value::as_mapping);
    let mut effective_of: BTreeMap<String, String> = BTreeMap::new();
    for (key, decl) in declared.into_iter().flatten() {
        let Some(key) = key.as_str() else { continue };
        let effective = networks::effective_network_name(project, key, decl);
        if let Some(effective) = &effective {
            effective_of.insert(key.to_string(), effective.clone());
        }
        let Some(kind) = custom_net_of(key) else {
            if let Some(alias) = effective.filter(|e| custom_net_of(e).is_some()) {
                out.push(violation(
                    key,
                    SecurityRule::CustomMcpNetworks,
                    format!("network '{key}' is another name for the Custom MCP network '{alias}'"),
                    FIX,
                ));
            }
            continue;
        };
        let own = match &kind {
            CustomNet::Hub => key == custom,
            CustomNet::HubHost => key == custom_host,
            CustomNet::Server(id) => key == networks::custom_server_network_name(&main, id),
            CustomNet::Egress(id) => key == networks::custom_egress_network_name(&main, id),
        };
        if !own {
            out.push(violation(
                key,
                SecurityRule::CustomMcpNetworks,
                format!("network '{key}' is not a Custom MCP network of project '{project}'"),
                FIX,
            ));
            continue;
        }
        let egress_less = matches!(kind, CustomNet::Hub | CustomNet::Server(_));
        if egress_less
            && (!networks::declares_external(decl)
                || decl.get("name").and_then(Value::as_str) != Some(key))
        {
            out.push(violation(
                key,
                SecurityRule::CustomMcpNetworks,
                format!(
                    "'{key}' must be declared `external: true` with name '{key}' (it is \
                     pre-created with --internal)"
                ),
                FIX,
            ));
        }
        if !egress_less && (decl.get("external").is_some() || decl.get("name").is_some()) {
            out.push(violation(
                key,
                SecurityRule::CustomMcpNetworks,
                format!(
                    "'{key}' is a compose-managed bridge and must be declared without `name` or \
                     `external`"
                ),
                FIX,
            ));
        }
    }

    for cs in customs {
        if cs.service.get("network_mode").is_some() {
            out.push(violation(
                cs.name,
                SecurityRule::CustomMcpNetworks,
                "network_mode is not allowed".into(),
                FIX,
            ));
        }
        let Some(nets) = sequence_of_strings(cs.service.get("networks")) else {
            out.push(violation(
                cs.name,
                SecurityRule::CustomMcpNetworks,
                "networks must be a plain list (no aliases, no fixed addresses)".into(),
                FIX,
            ));
            continue;
        };
        let cx = networks::custom_server_network_name(&main, &cs.id);
        let want: BTreeSet<String> = match cs.role {
            Role::Guard => match guard_mode(cs, expected.custom_mcp().server(&cs.id)) {
                GuardMode::Npm => [custom.clone(), cx].into(),
                GuardMode::Host => [custom_host.clone()].into(),
            },
            Role::Server => [cx].into(),
            Role::Egress => [cx, networks::custom_egress_network_name(&main, &cs.id)].into(),
        };
        let got: BTreeSet<String> = nets.iter().cloned().collect();
        if got != want || got.len() != nets.len() {
            out.push(violation(
                cs.name,
                SecurityRule::CustomMcpNetworks,
                format!("networks {nets:?} differ from the expected {want:?}"),
                FIX,
            ));
        }
    }

    let custom_names: BTreeSet<&str> = customs.iter().map(|c| c.name).collect();
    for (name, service) in services {
        if custom_names.contains(name.as_str()) {
            continue;
        }
        let is_hub = name == "mcp-hub";
        let mapping_form = matches!(service.get("networks"), Some(Value::Mapping(_)));
        for net in service_network_refs(service) {
            let Some(kind) = custom_net_of(&net).or_else(|| {
                effective_of
                    .get(&net)
                    .and_then(|effective| custom_net_of(effective))
            }) else {
                continue;
            };
            let allowed = is_hub && matches!(kind, CustomNet::Hub | CustomNet::HubHost);
            if !allowed {
                out.push(violation(
                    name,
                    SecurityRule::CustomMcpNetworks,
                    format!("'{name}' must not join the Custom MCP network '{net}'"),
                    FIX,
                ));
            } else if mapping_form {
                out.push(violation(
                    name,
                    SecurityRule::CustomMcpNetworks,
                    format!("'{name}' joins '{net}' with options (aliases, fixed addresses)"),
                    FIX,
                ));
            }
        }
    }
    out
}

fn allowed_env(cs: &CustomService<'_>, mode: GuardMode) -> Vec<String> {
    let mut keys: Vec<String> = match cs.role {
        Role::Guard => {
            let mut k = vec![
                "PORT",
                "SPW_CUSTOM_SERVER",
                "SPW_CUSTOM_MODE",
                "POLICY_FILE",
            ];
            match mode {
                GuardMode::Npm => k.extend(["SPW_UPSTREAM_URL", "SPW_UPSTREAM_AUTH_TOKEN"]),
                GuardMode::Host => k.extend([
                    "SPW_RELAY_DIR",
                    "SPW_HOST_PROJECT_DIR",
                    "SPW_HOST_PATH_STYLE",
                ]),
            }
            k.into_iter().map(str::to_string).collect()
        }
        Role::Server => [
            "PORT",
            "SPW_LAUNCHER_AUTH_TOKEN",
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "NO_PROXY",
            "NODE_USE_ENV_PROXY",
            "SPW_CREDENTIALS_DIGEST",
        ]
        .into_iter()
        .map(str::to_string)
        .collect(),
        Role::Egress => ["SPW_EGRESS_CONFIG", "SPW_EGRESS_LISTEN"]
            .into_iter()
            .map(str::to_string)
            .collect(),
    };
    if cs.role == Role::Guard {
        keys.push(shape::guard_auth_token_env(&cs.id));
    }
    keys.push("TZ".to_string());
    keys
}

fn pinned_env(cs: &CustomService<'_>, mode: GuardMode) -> Vec<(&'static str, String)> {
    match cs.role {
        Role::Guard => {
            let mut pins = vec![
                ("SPW_CUSTOM_SERVER", cs.id.clone()),
                (
                    "SPW_CUSTOM_MODE",
                    match mode {
                        GuardMode::Npm => "npm",
                        GuardMode::Host => "host",
                    }
                    .to_string(),
                ),
                (
                    "POLICY_FILE",
                    format!("/policy/{}", consts::CUSTOM_MCP_GUARD_POLICY_FILE),
                ),
            ];
            match mode {
                GuardMode::Npm => pins.push(("SPW_UPSTREAM_URL", shape::upstream_url(&cs.id))),
                GuardMode::Host => {
                    pins.push(("SPW_RELAY_DIR", custom_host::RELAY_MOUNT.to_string()))
                }
            }
            pins
        }
        Role::Server => vec![
            ("HTTPS_PROXY", shape::egress_proxy_url(&cs.id)),
            ("HTTP_PROXY", shape::egress_proxy_url(&cs.id)),
            ("NO_PROXY", String::new()),
            ("NODE_USE_ENV_PROXY", "1".to_string()),
        ],
        Role::Egress => vec![
            (
                "SPW_EGRESS_CONFIG",
                format!("/config/{}", consts::CUSTOM_MCP_EGRESS_CONFIG_FILE),
            ),
            (
                "SPW_EGRESS_LISTEN",
                format!("0.0.0.0:{}", shape::EGRESS_PORT),
            ),
        ],
    }
}

/// `true` when `value` is a mapping whose keys are all strings in `allowed`.
fn mapping_keys_within(value: Option<&Value>, allowed: &[&str]) -> bool {
    value.and_then(Value::as_mapping).is_some_and(|map| {
        map.keys()
            .all(|k| k.as_str().is_some_and(|k| allowed.contains(&k)))
    })
}

/// `true` when `deploy` sets nothing but `resources.limits.{cpus,memory}`.
fn deploy_is_limits_only(deploy: Option<&Value>) -> bool {
    let resources = deploy.and_then(|d| d.get("resources"));
    let limits = resources.and_then(|r| r.get("limits"));
    mapping_keys_within(deploy, &["resources"])
        && mapping_keys_within(resources, &["limits"])
        && mapping_keys_within(limits, &["cpus", "memory"])
}

/// The size of the single `/tmp:noexec,nosuid,size=<n>` tmpfs, in MiB; `None` for any other
/// tmpfs list.
fn tmpfs_mib(service: &Value) -> Option<f64> {
    match sequence_of_strings(service.get("tmpfs"))?.as_slice() {
        [only] => parse_mib(only.strip_prefix(shape::TMPFS_PREFIX)?),
        _ => None,
    }
}

fn check_forbidden_keys(
    doc: &Value,
    services: &[(String, &Value)],
    customs: &[CustomService<'_>],
    expected: &SecurityExpectedPaths,
    project: &str,
) -> Vec<SecurityViolation> {
    const FIX: &str = "Run render_compose() again: Speedwave sets every key of a Custom MCP \
                       container itself, from a fixed allowlist per role.";
    let mut out = Vec::new();
    if services.iter().any(|(_, s)| has_custom_label(s)) {
        for section in ["secrets", "configs"] {
            if doc.get(section).is_some() {
                out.push(violation(
                    "*",
                    SecurityRule::CustomMcpForbiddenKeys,
                    format!(
                        "a top-level `{section}` section is not allowed next to Custom MCP \
                         containers"
                    ),
                    FIX,
                ));
            }
        }
    }
    for cs in customs {
        let mut fail = |msg: String| {
            out.push(violation(
                cs.name,
                SecurityRule::CustomMcpForbiddenKeys,
                msg,
                FIX,
            ));
        };
        let mode = guard_mode(cs, expected.custom_mcp().server(&cs.id));
        let allowed = allowed_keys(cs.role, mode);
        match cs.service.as_mapping() {
            Some(map) => {
                for key in map.keys() {
                    match key.as_str() {
                        Some(k) if allowed.contains(&k) => {}
                        Some(k) => fail(format!("'{k}' is not allowed on a Custom MCP container")),
                        None => fail(format!("the key {key:?} is not allowed")),
                    }
                }
            }
            None => fail("the service is not a mapping".into()),
        }
        if sequence_of_strings(cs.service.get("security_opt"))
            != Some(vec![shape::NO_NEW_PRIVILEGES.to_string()])
        {
            fail(format!(
                "security_opt must be exactly [\"{}\"]",
                shape::NO_NEW_PRIVILEGES
            ));
        }
        if sequence_of_strings(cs.service.get("cap_drop")) != Some(vec!["ALL".to_string()]) {
            fail("cap_drop must be exactly [\"ALL\"]".into());
        }
        if tmpfs_mib(cs.service).is_none() {
            fail(format!(
                "tmpfs must be exactly one \"{}<size>\" entry",
                shape::TMPFS_PREFIX
            ));
        }
        if !deploy_is_limits_only(cs.service.get("deploy")) {
            fail("deploy may set only resources.limits.cpus and resources.limits.memory".into());
        }
        if !mapping_keys_within(cs.service.get("labels"), LABEL_KEYS) {
            fail(format!("labels must be only {LABEL_KEYS:?}"));
        }
        let want_name = shape::container_name(project, cs.name);
        if cs.service.get("container_name").and_then(Value::as_str) != Some(want_name.as_str()) {
            fail(format!("container_name must be {want_name:?}"));
        }
        if let Some(hosts) = cs.service.get("extra_hosts") {
            let gateway_only = cs.role == Role::Guard
                && mode == GuardMode::Host
                && sequence_of_strings(Some(hosts)).is_some_and(|h| {
                    h.len() == 1 && h[0].starts_with(&format!("{}:", consts::HOST_GATEWAY_ALIAS))
                });
            if !gateway_only {
                fail(
                    "extra_hosts is allowed only as the host gateway alias of a host guard".into(),
                );
            }
        }
        let Some(env) = env_entries(cs.service) else {
            fail("environment must be a list of KEY=VALUE strings".into());
            continue;
        };
        let allowed = allowed_env(cs, mode);
        let mut seen = BTreeSet::new();
        for (key, _) in &env {
            if !allowed.contains(key) {
                fail(format!("environment key '{key}' is not allowed"));
            }
            if !seen.insert(key.clone()) {
                fail(format!("environment key '{key}' is set twice"));
            }
        }
        for (key, want) in pinned_env(cs, mode) {
            let got = env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
            if got != Some(want.as_str()) {
                fail(format!("{key} must be {want:?}, found {got:?}"));
            }
        }
    }
    out
}

fn parse_cpus(value: &Value) -> Option<f64> {
    match value {
        Value::String(s) => s.trim().parse().ok(),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

fn parse_mib(value: &str) -> Option<f64> {
    let value = value.trim().to_ascii_lowercase();
    let digits_end = value.find(|c: char| !c.is_ascii_digit() && c != '.')?;
    let (number, unit) = value.split_at(digits_end);
    let number: f64 = number.parse().ok()?;
    let factor = match unit.trim_end_matches('b') {
        "" => 1.0 / (1024.0 * 1024.0),
        "k" => 1.0 / 1024.0,
        "m" => 1.0,
        "g" => 1024.0,
        _ => return None,
    };
    Some(number * factor)
}

fn parse_memory(value: &Value) -> Option<f64> {
    match value {
        Value::String(s) if s.chars().all(|c| c.is_ascii_digit()) => parse_mib(&format!("{s}b")),
        Value::String(s) => parse_mib(s),
        Value::Number(n) => n.as_f64().map(|b| b / (1024.0 * 1024.0)),
        _ => None,
    }
}

fn check_resources(customs: &[CustomService<'_>]) -> Vec<SecurityViolation> {
    const FIX: &str = "Run render_compose() again: Custom MCP limits come from resources.rs.";
    let mut out = Vec::new();
    for cs in customs {
        let envelope = cs.role.resources();
        let limits = cs
            .service
            .get("deploy")
            .and_then(|d| d.get("resources"))
            .and_then(|r| r.get("limits"));
        let cpus = limits.and_then(|l| l.get("cpus")).and_then(parse_cpus);
        let memory = limits.and_then(|l| l.get("memory")).and_then(parse_memory);
        let tmpfs = tmpfs_mib(cs.service);
        let within = |got: Option<f64>, max: f64| got.is_some_and(|g| g > 0.0 && g <= max + 1e-9);
        if !within(cpus, f64::from(envelope.cpus)) {
            out.push(violation(
                cs.name,
                SecurityRule::CustomMcpResources,
                format!("cpus limit {cpus:?} is missing or above {}", envelope.cpus),
                FIX,
            ));
        }
        if !within(memory, f64::from(envelope.mem_mib)) {
            out.push(violation(
                cs.name,
                SecurityRule::CustomMcpResources,
                format!(
                    "memory limit {memory:?} MiB is missing or above {} MiB",
                    envelope.mem_mib
                ),
                FIX,
            ));
        }
        if !within(tmpfs, f64::from(envelope.tmpfs_mib)) {
            out.push(violation(
                cs.name,
                SecurityRule::CustomMcpResources,
                format!(
                    "/tmp tmpfs size {tmpfs:?} MiB is missing or above {} MiB",
                    envelope.tmpfs_mib
                ),
                FIX,
            ));
        }
    }
    let ids: BTreeSet<&str> = customs.iter().map(|c| c.id.as_str()).collect();
    if ids.len() > consts::CUSTOM_MCP_MAX_PER_PROJECT {
        out.push(violation(
            "*",
            SecurityRule::CustomMcpResources,
            format!(
                "{} Custom MCP servers exceed the limit of {}",
                ids.len(),
                consts::CUSTOM_MCP_MAX_PER_PROJECT
            ),
            FIX,
        ));
    }
    out
}

/// Every Custom MCP violation of `doc`: unknown services, consent, images, volumes, networks,
/// forbidden keys and resources.
pub(super) fn check(
    doc: &Value,
    project: &str,
    expected: &SecurityExpectedPaths,
    data_dir: &Path,
) -> Vec<SecurityViolation> {
    let services = get_services(doc).unwrap_or_default();
    let (customs, mut out) = classify(&services);
    out.extend(check_consent(&customs, expected));
    out.extend(check_images(&customs, expected));
    out.extend(check_volumes(doc, &customs, expected, data_dir, project));
    out.extend(check_networks(doc, &services, &customs, expected, project));
    out.extend(check_forbidden_keys(
        doc, &services, &customs, expected, project,
    ));
    out.extend(check_resources(&customs));
    out
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::super::super::custom_mcp::tests::{
        host_entry, integrations, npm_and_host, render, Fixture, PROJECT,
    };
    use super::super::SecurityCheck;
    use super::*;
    use crate::config::ResolvedIntegrationsConfig;
    use crate::custom_mcp::CustomMcpExpectations;

    struct Rendered {
        fx: Fixture,
        yaml: String,
        integrations: ResolvedIntegrationsConfig,
    }

    fn rendered() -> Rendered {
        let fx = Fixture::new();
        let integrations = npm_and_host(&fx);
        let yaml = render(&fx, &integrations);
        Rendered {
            fx,
            yaml,
            integrations,
        }
    }

    impl Rendered {
        fn expected(&self, expectations: CustomMcpExpectations) -> SecurityExpectedPaths {
            SecurityExpectedPaths::from_raw(
                &to_engine_path(self.fx.project.path()).unwrap(),
                &to_engine_path(&self.fx.data.path().join("tokens").join(PROJECT)).unwrap(),
            )
            .with_custom_mcp(expectations)
        }

        fn approved(&self) -> CustomMcpExpectations {
            CustomMcpExpectations::from_effective(self.integrations.effective_custom_mcp())
        }

        fn check_yaml(&self, yaml: &str) -> Vec<SecurityViolation> {
            self.check_with(yaml, self.approved())
        }

        fn check_with(
            &self,
            yaml: &str,
            expectations: CustomMcpExpectations,
        ) -> Vec<SecurityViolation> {
            SecurityCheck::run_with_data_dir(
                yaml,
                PROJECT,
                &[],
                &self.expected(expectations),
                self.fx.data.path(),
            )
        }

        fn mutated(&self, edit: impl FnOnce(&mut Value)) -> Vec<SecurityViolation> {
            let mut doc: Value = serde_yaml_ng::from_str(&self.yaml).unwrap();
            edit(&mut doc);
            self.check_yaml(&serde_yaml_ng::to_string(&doc).unwrap())
        }
    }

    fn has(violations: &[SecurityViolation], rule: SecurityRule, container: &str) -> bool {
        violations
            .iter()
            .any(|v| v.rule == rule && v.container == container)
    }

    fn svc<'a>(doc: &'a mut Value, name: &str) -> &'a mut Value {
        doc.get_mut("services").unwrap().get_mut(name).unwrap()
    }

    fn net(name: &str) -> String {
        format!("{}_{name}", networks::project_network_name(PROJECT))
    }

    fn push(doc: &mut Value, service: &str, key: &str, item: &str) {
        svc(doc, service)
            .get_mut(key)
            .unwrap()
            .as_sequence_mut()
            .unwrap()
            .push(Value::String(item.to_string()));
    }

    fn set_env(doc: &mut Value, service: &str, key: &str, value: &str) {
        let env = svc(doc, service)
            .get_mut("environment")
            .unwrap()
            .as_sequence_mut()
            .unwrap();
        env.retain(|e| {
            !e.as_str()
                .unwrap_or_default()
                .starts_with(&format!("{key}="))
        });
        env.push(Value::String(format!("{key}={value}")));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn the_rendered_compose_passes_every_rule() {
        let r = rendered();
        let violations = r.check_yaml(&r.yaml);
        assert!(violations.is_empty(), "{violations:#?}");
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn a_compose_without_custom_servers_passes_without_expectations() {
        let fx = Fixture::new();
        let yaml = render(&fx, &integrations(vec![], true, None));
        let r = Rendered {
            fx,
            yaml: yaml.clone(),
            integrations: integrations(vec![], true, None),
        };
        assert!(r
            .check_with(&yaml, CustomMcpExpectations::default())
            .is_empty());
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn unknown_or_mislabelled_services_fail() {
        let r = rendered();
        let v = r.mutated(|d| {
            let rogue = svc(d, "mcp-custom-figma-egress").clone();
            let mut rogue = rogue;
            rogue.as_mapping_mut().unwrap().remove("labels");
            d["services"]
                .as_mapping_mut()
                .unwrap()
                .insert(Value::String("mcp-rogue".into()), rogue);
        });
        assert!(has(&v, SecurityRule::UnknownService, "mcp-rogue"), "{v:#?}");
        let v = r.mutated(|d| {
            let renamed = svc(d, "mcp-custom-figma-up").clone();
            d["services"]
                .as_mapping_mut()
                .unwrap()
                .insert(Value::String("mcp-custom-figma-side".into()), renamed);
        });
        assert!(
            has(&v, SecurityRule::UnknownService, "mcp-custom-figma-side"),
            "{v:#?}"
        );
        let v = r.mutated(|d| {
            svc(d, "mcp-custom-desk")["labels"]["speedwave.plugin-service"] =
                Value::String("true".into());
        });
        assert!(has(&v, SecurityRule::UnknownService, "mcp-custom-desk"));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn revoked_or_changed_consent_fails() {
        let r = rendered();
        let v = r.check_with(&r.yaml, CustomMcpExpectations::default());
        for name in [
            "mcp-custom-figma",
            "mcp-custom-figma-up",
            "mcp-custom-figma-egress",
            "mcp-custom-desk",
        ] {
            assert!(has(&v, SecurityRule::CustomMcpConsent, name), "{name}");
        }
        let v = r.mutated(|d| {
            svc(d, "mcp-custom-figma-up")["labels"][shape::CONSENT_LABEL] =
                Value::String("0000000000000000".into());
        });
        assert!(has(
            &v,
            SecurityRule::CustomMcpConsent,
            "mcp-custom-figma-up"
        ));
        let v = r.mutated(|d| {
            let mut extra = svc(d, "mcp-custom-figma-up").clone();
            extra["labels"][shape::ID_LABEL] = Value::String("desk".into());
            d["services"]
                .as_mapping_mut()
                .unwrap()
                .insert(Value::String("mcp-custom-desk-up".into()), extra);
        });
        assert!(has(
            &v,
            SecurityRule::CustomMcpConsent,
            "mcp-custom-desk-up"
        ));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn wrong_images_and_entrypoints_fail() {
        let r = rendered();
        let v = r.mutated(|d| {
            svc(d, "mcp-custom-figma-up")["image"] =
                Value::String("speedwave-mcp-custom-figma:9.9.9-0000000000000000".into());
        });
        assert!(has(&v, SecurityRule::CustomMcpImage, "mcp-custom-figma-up"));
        let v = r.mutated(|d| {
            svc(d, "mcp-custom-figma")["image"] = Value::String("speedwave-claude:x".into());
        });
        assert!(has(&v, SecurityRule::CustomMcpImage, "mcp-custom-figma"));
        let v = r.mutated(|d| {
            svc(d, "mcp-custom-figma-egress")
                .as_mapping_mut()
                .unwrap()
                .remove("entrypoint");
        });
        assert!(has(
            &v,
            SecurityRule::CustomMcpImage,
            "mcp-custom-figma-egress"
        ));
        let v = r.mutated(|d| {
            svc(d, "mcp-custom-desk")["pull_policy"] = Value::String("always".into());
            svc(d, "mcp-custom-figma-up")["command"] = Value::String("sh".into());
        });
        assert!(has(&v, SecurityRule::CustomMcpImage, "mcp-custom-desk"));
        assert!(has(&v, SecurityRule::CustomMcpImage, "mcp-custom-figma-up"));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn mounts_outside_the_role_profile_fail() {
        let r = rendered();
        let v = r.mutated(|d| {
            let long: Value = serde_yaml_ng::from_str(
                "{type: bind, source: /etc, target: /policy, read_only: true}",
            )
            .unwrap();
            svc(d, "mcp-custom-figma")["volumes"] = Value::Sequence(vec![long]);
        });
        assert!(has(&v, SecurityRule::CustomMcpVolumes, "mcp-custom-figma"));
        let v = r.mutated(|d| {
            push(
                d,
                "mcp-custom-figma-up",
                "volumes",
                "/var/run/docker.sock:/var/run/docker.sock",
            );
        });
        assert!(has(
            &v,
            SecurityRule::CustomMcpVolumes,
            "mcp-custom-figma-up"
        ));
        let project = to_engine_path(r.fx.project.path()).unwrap();
        let v = r.mutated(|d| {
            push(
                d,
                "mcp-custom-figma-up",
                "volumes",
                &format!("{project}:/workspace:rw"),
            );
        });
        assert!(
            has(&v, SecurityRule::CustomMcpVolumes, "mcp-custom-figma-up"),
            "an unapproved workspace mount must fail"
        );
        let v = r.mutated(|d| {
            push(
                d,
                "mcp-hub",
                "volumes",
                "/data/secrets/acme/custom-figma-launcher-token:/secrets/x:ro",
            );
        });
        assert!(has(&v, SecurityRule::CustomMcpVolumes, "mcp-hub"));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn network_escapes_fail() {
        let r = rendered();
        let v = r.mutated(|d| push(d, "mcp-hub", "networks", &net("cx_figma")));
        assert!(has(&v, SecurityRule::CustomMcpNetworks, "mcp-hub"));
        let v = r.mutated(|d| push(d, "claude", "networks", &net("custom")));
        assert!(has(&v, SecurityRule::CustomMcpNetworks, "claude"));
        let v = r.mutated(|d| push(d, "proxy", "networks", &net("eg_figma")));
        assert!(has(&v, SecurityRule::CustomMcpNetworks, "proxy"));
        let v = r.mutated(|d| {
            d["networks"][net("cx_figma").as_str()] =
                serde_yaml_ng::from_str("{driver: bridge}").unwrap();
        });
        assert!(has(&v, SecurityRule::CustomMcpNetworks, &net("cx_figma")));
        let v = r.mutated(|d| push(d, "mcp-custom-figma-up", "networks", &net("custom")));
        assert!(has(
            &v,
            SecurityRule::CustomMcpNetworks,
            "mcp-custom-figma-up"
        ));
        let v = r.mutated(|d| {
            svc(d, "mcp-custom-figma")["networks"] = serde_yaml_ng::from_str(&format!(
                "{{{}: {{aliases: [mcp-hub]}}, {}: {{}}}}",
                net("custom"),
                net("cx_figma")
            ))
            .unwrap();
        });
        assert!(has(&v, SecurityRule::CustomMcpNetworks, "mcp-custom-figma"));
        let v = r.mutated(|d| {
            svc(d, "mcp-custom-figma-egress")["network_mode"] = Value::String("host".into());
        });
        assert!(has(
            &v,
            SecurityRule::CustomMcpNetworks,
            "mcp-custom-figma-egress"
        ));
        let v = r.mutated(|d| {
            let foreign = "speedwave_other_network_cx_figma";
            d["networks"][foreign] =
                serde_yaml_ng::from_str(&format!("{{name: {foreign}, external: true}}")).unwrap();
        });
        assert!(has(
            &v,
            SecurityRule::CustomMcpNetworks,
            "speedwave_other_network_cx_figma"
        ));
    }

    fn declare(doc: &mut Value, key: &str, decl: &str) {
        doc["networks"][key] = serde_yaml_ng::from_str(decl).unwrap();
    }

    fn main_net() -> String {
        networks::project_network_name(PROJECT)
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn networks_named_after_a_custom_network_under_another_key_fail() {
        let r = rendered();
        for (target, svc) in [
            (net("cx_figma"), "proxy"),
            (net("cx_figma"), "claude"),
            (net("custom"), "claude"),
            (net("eg_figma"), "proxy"),
        ] {
            let v = r.mutated(|d| {
                declare(
                    d,
                    "innocent",
                    &format!("{{name: {target}, external: true}}"),
                );
                push(d, svc, "networks", "innocent");
            });
            assert!(
                has(&v, SecurityRule::CustomMcpNetworks, "innocent"),
                "{target}: {v:#?}"
            );
            assert!(
                has(&v, SecurityRule::CustomMcpNetworks, svc),
                "{target} on {svc}: {v:#?}"
            );
        }
        let v = r.mutated(|d| {
            declare(d, "innocent", &format!("{{name: {}}}", net("custom")));
        });
        assert!(
            has(&v, SecurityRule::CustomMcpNetworks, "innocent"),
            "{v:#?}"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn the_main_network_renamed_to_a_custom_network_fails() {
        let r = rendered();
        let main = main_net();
        for target in [net("custom"), net("cx_figma"), net("custom_host")] {
            let v = r.mutated(|d| {
                d["networks"][main.as_str()]["name"] = Value::String(target.clone());
            });
            assert!(
                has(&v, SecurityRule::CustomMcpNetworks, &main),
                "{target}: {v:#?}"
            );
            for svc in ["claude", "proxy"] {
                assert!(
                    has(&v, SecurityRule::CustomMcpNetworks, svc),
                    "{target} on {svc}: {v:#?}"
                );
            }
        }
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn custom_network_keys_pointing_at_another_network_fail() {
        let r = rendered();
        let main = main_net();
        let v = r.mutated(|d| {
            declare(
                d,
                &net("eg_figma"),
                &format!("{{external: true, name: {main}}}"),
            );
        });
        assert!(
            has(&v, SecurityRule::CustomMcpNetworks, &net("eg_figma")),
            "{v:#?}"
        );
        let v = r.mutated(|d| {
            declare(
                d,
                &net("eg_figma"),
                &format!("{{driver: bridge, name: {main}}}"),
            );
        });
        assert!(has(&v, SecurityRule::CustomMcpNetworks, &net("eg_figma")));
        let v = r.mutated(|d| {
            declare(d, &net("custom_host"), "{external: true}");
        });
        assert!(has(
            &v,
            SecurityRule::CustomMcpNetworks,
            &net("custom_host")
        ));
        let v = r.mutated(|d| {
            declare(
                d,
                &net("cx_figma"),
                &format!("{{external: true, name: {main}}}"),
            );
        });
        assert!(has(&v, SecurityRule::CustomMcpNetworks, &net("cx_figma")));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn a_network_named_after_the_office_network_fails() {
        let r = rendered();
        let office = format!("{}_office", main_net());
        let v = r.mutated(|d| {
            declare(
                d,
                "innocent",
                &format!("{{name: {office}, external: true}}"),
            );
            push(d, "claude", "networks", "innocent");
        });
        assert!(
            has(&v, SecurityRule::EgressLessNetworkExternal, "innocent"),
            "{v:#?}"
        );
        let v = r.mutated(|d| {
            declare(d, "innocent", "{external: {name: x}}");
        });
        assert!(
            has(&v, SecurityRule::EgressLessNetworkExternal, "innocent"),
            "{v:#?}"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn the_office_network_rule_leaves_custom_networks_to_the_custom_rule() {
        let r = rendered();
        assert!(!r
            .check_yaml(&r.yaml)
            .iter()
            .any(|v| v.rule == SecurityRule::EgressLessNetworkExternal));

        let office = format!("{}_office", main_net());
        let v = r.mutated(|d| push(d, "mcp-custom-figma-up", "networks", &office));
        assert!(
            has(
                &v,
                SecurityRule::EgressLessNetworkExternal,
                "mcp-custom-figma-up"
            ),
            "{v:#?}"
        );
        assert!(
            has(&v, SecurityRule::CustomMcpNetworks, "mcp-custom-figma-up"),
            "{v:#?}"
        );

        let v = r.mutated(|d| {
            d["networks"][net("custom").as_str()]["name"] = Value::String(office.clone());
        });
        assert!(
            has(&v, SecurityRule::EgressLessNetworkExternal, &net("custom")),
            "{v:#?}"
        );

        let foreign = "speedwave_other_network_custom";
        let v = r.mutated(|d| {
            declare(d, foreign, &format!("{{name: {foreign}, external: true}}"));
            push(d, "mcp-hub", "networks", foreign);
        });
        assert!(has(&v, SecurityRule::CustomMcpNetworks, foreign), "{v:#?}");
        assert!(
            !v.iter()
                .any(|v| v.rule == SecurityRule::EgressLessNetworkExternal),
            "{v:#?}"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn forbidden_keys_and_env_fail() {
        let r = rendered();
        let v = r.mutated(|d| {
            svc(d, "mcp-custom-figma-up")["ports"] =
                serde_yaml_ng::from_str("['127.0.0.1:3000:3000']").unwrap();
        });
        assert!(has(
            &v,
            SecurityRule::CustomMcpForbiddenKeys,
            "mcp-custom-figma-up"
        ));
        let v = r.mutated(|d| set_env(d, "mcp-custom-figma-up", "NODE_OPTIONS", "--inspect"));
        assert!(has(
            &v,
            SecurityRule::CustomMcpForbiddenKeys,
            "mcp-custom-figma-up"
        ));
        let v = r.mutated(|d| {
            set_env(
                d,
                "mcp-custom-figma-up",
                "HTTPS_PROXY",
                "http://attacker.example:3128",
            )
        });
        assert!(has(
            &v,
            SecurityRule::CustomMcpForbiddenKeys,
            "mcp-custom-figma-up"
        ));
        let v = r.mutated(|d| {
            svc(d, "mcp-custom-figma-egress")["privileged"] = Value::Bool(true);
            svc(d, "mcp-custom-figma")["extra_hosts"] =
                serde_yaml_ng::from_str("['host.docker.internal:192.168.5.2']").unwrap();
        });
        assert!(has(
            &v,
            SecurityRule::CustomMcpForbiddenKeys,
            "mcp-custom-figma-egress"
        ));
        assert!(has(
            &v,
            SecurityRule::CustomMcpForbiddenKeys,
            "mcp-custom-figma"
        ));
        let v = r.mutated(|d| set_env(d, "mcp-custom-desk", "SPW_RELAY_DIR", "/tmp"));
        assert!(has(
            &v,
            SecurityRule::CustomMcpForbiddenKeys,
            "mcp-custom-desk"
        ));
    }

    fn set(doc: &mut Value, service: &str, key: &str, yaml: &str) {
        svc(doc, service)[key] = serde_yaml_ng::from_str(yaml).unwrap();
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn the_rendered_keys_are_exactly_the_role_allowlists() {
        let r = rendered();
        let doc: Value = serde_yaml_ng::from_str(&r.yaml).unwrap();
        let approved = r.approved();
        let mut used = BTreeSet::new();
        let mut allowed_anywhere = BTreeSet::new();
        let mut roles = BTreeSet::new();
        for (name, service) in get_services(&doc).unwrap() {
            let Some((role, id)) = shape::role_of(service) else {
                continue;
            };
            let mode = approved.server(&id).unwrap().mode;
            roles.insert((role.label(), mode == GuardMode::Host));
            let allowed = allowed_keys(role, mode);
            allowed_anywhere.extend(allowed.iter().map(|k| k.to_string()));
            for key in service.as_mapping().unwrap().keys() {
                let key = key.as_str().unwrap();
                assert!(allowed.contains(&key), "{name} renders '{key}'");
                used.insert(key.to_string());
            }
        }
        assert_eq!(roles.len(), 4, "{roles:?}");
        assert_eq!(used, allowed_anywhere);
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn keys_outside_the_role_allowlist_fail() {
        let r = rendered();
        for (service, key, value) in [
            ("mcp-custom-figma-up", "secrets", "[x]"),
            ("mcp-custom-figma-up", "configs", "[x]"),
            ("mcp-custom-figma-egress", "dns", "['1.1.1.1']"),
            ("mcp-custom-figma-up", "extends", "{service: claude}"),
            ("mcp-custom-figma-up", "ulimits", "{nofile: 1048576}"),
            ("mcp-custom-figma-up", "cgroup", "host"),
            ("mcp-custom-figma-up", "mem_limit", "8g"),
            ("mcp-custom-figma-up", "cpus", "4"),
            ("mcp-custom-figma-up", "pids_limit", "-1"),
            ("mcp-custom-figma-up", "restart", "always"),
            ("mcp-custom-figma-up", "entrypoint", "['/bin/sh']"),
            ("mcp-custom-figma", "<<", "{privileged: true}"),
            ("mcp-custom-figma", "hostname", "mcp-hub"),
            ("mcp-custom-figma-egress", "extra_hosts", "['x:1.2.3.4']"),
        ] {
            let v = r.mutated(|d| set(d, service, key, value));
            assert!(
                has(&v, SecurityRule::CustomMcpForbiddenKeys, service),
                "{service}.{key}: {v:#?}"
            );
        }
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn top_level_secrets_and_configs_fail_next_to_custom_containers() {
        let r = rendered();
        for section in ["secrets", "configs"] {
            let v = r.mutated(|d| {
                set(d, "mcp-custom-figma-up", section, "[x]");
                d[section] = serde_yaml_ng::from_str("{x: {file: /Users/me/.ssh/id_rsa}}").unwrap();
            });
            assert!(has(&v, SecurityRule::CustomMcpForbiddenKeys, "*"), "{v:#?}");
            assert!(has(
                &v,
                SecurityRule::CustomMcpForbiddenKeys,
                "mcp-custom-figma-up"
            ));
        }
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn a_loosened_security_profile_fails() {
        let r = rendered();
        for (service, opt) in [
            ("mcp-custom-figma-up", "seccomp=unconfined"),
            ("mcp-custom-figma", "apparmor=unconfined"),
            ("mcp-custom-figma-egress", "label=disable"),
        ] {
            let v = r.mutated(|d| push(d, service, "security_opt", opt));
            assert!(
                has(&v, SecurityRule::CustomMcpForbiddenKeys, service),
                "{opt}"
            );
            assert!(has(&v, SecurityRule::NoNewPrivs, service), "{opt}");
        }
        let v = r.mutated(|d| push(d, "claude", "security_opt", "seccomp=unconfined"));
        assert!(has(&v, SecurityRule::NoNewPrivs, "claude"), "{v:#?}");
        let v = r.mutated(|d| push(d, "mcp-custom-figma", "cap_drop", "NET_RAW"));
        assert!(has(
            &v,
            SecurityRule::CustomMcpForbiddenKeys,
            "mcp-custom-figma"
        ));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn a_second_or_reshaped_tmpfs_fails() {
        let r = rendered();
        let v = r.mutated(|d| push(d, "mcp-custom-figma-up", "tmpfs", "/x:exec"));
        assert!(has(
            &v,
            SecurityRule::CustomMcpForbiddenKeys,
            "mcp-custom-figma-up"
        ));
        assert!(has(
            &v,
            SecurityRule::CustomMcpResources,
            "mcp-custom-figma-up"
        ));
        for entry in [
            "/tmp:exec,nosuid,size=64m",
            "/tmp:noexec,nosuid,size=64m,mode=1777",
            "/tmp:noexec,nosuid",
            "/tmpx:noexec,nosuid,size=64m",
        ] {
            let v = r.mutated(|d| set(d, "mcp-custom-figma", "tmpfs", &format!("['{entry}']")));
            assert!(
                has(&v, SecurityRule::CustomMcpForbiddenKeys, "mcp-custom-figma"),
                "{entry}: {v:#?}"
            );
        }
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn deploy_labels_and_container_name_beyond_the_rendered_shape_fail() {
        let r = rendered();
        let edits: [(&[&str], &str); 5] = [
            (
                &["deploy", "resources", "reservations"],
                "{devices: [{capabilities: [gpu]}]}",
            ),
            (&["deploy", "restart_policy"], "{condition: any}"),
            (&["deploy", "resources", "limits", "pids"], "0"),
            (&["labels", "nerdctl/extra"], "x"),
            (&["container_name"], "speedwave_acme_mcp_hub"),
        ];
        for (path, value) in edits {
            let v = r.mutated(|d| {
                let target = path
                    .iter()
                    .fold(svc(d, "mcp-custom-figma-up"), |node, key| &mut node[*key]);
                *target = serde_yaml_ng::from_str(value).unwrap();
            });
            assert!(
                has(
                    &v,
                    SecurityRule::CustomMcpForbiddenKeys,
                    "mcp-custom-figma-up"
                ),
                "{path:?}: {v:#?}"
            );
        }
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn the_hub_mounts_nothing_of_the_secrets_dir_but_bearer_files() {
        let r = rendered();
        let data = to_engine_path(r.fx.data.path()).unwrap();
        let secrets = to_engine_path(&r.fx.data.path().join("secrets").join(PROJECT)).unwrap();
        for mount in [
            format!("{secrets}:/secrets:ro"),
            format!("{secrets}/:/x:ro"),
            format!("{data}/secrets:/s:ro"),
            format!("{data}:/d:ro"),
            "/:/host:ro".to_string(),
            format!("{}:/s:ro", secrets.to_uppercase()),
            format!("{secrets}/custom-figma-launcher-token:/secrets/custom-figma-auth-token:ro"),
            format!("{secrets}/custom-figma-auth-token:/secrets/other-auth-token:ro"),
            format!("{secrets}/custom-figma-auth-token:/secrets/custom-figma-auth-token:rw"),
            format!("{secrets}/custom-figma-auth-token:/secrets/custom-figma-auth-token"),
            format!("{secrets}/../{PROJECT}/x:/x:ro"),
            format!("{secrets}/sub/a-auth-token:/secrets/sub/a-auth-token:ro"),
        ] {
            let v = r.mutated(|d| push(d, "mcp-hub", "volumes", &mount));
            assert!(
                has(&v, SecurityRule::CustomMcpVolumes, "mcp-hub"),
                "{mount}: {v:#?}"
            );
        }
        let v = r.mutated(|d| {
            let long: Value = serde_yaml_ng::from_str(&format!(
                "{{type: bind, source: '{secrets}', target: /s, read_only: true}}"
            ))
            .unwrap();
            svc(d, "mcp-hub")["volumes"]
                .as_sequence_mut()
                .unwrap()
                .push(long);
        });
        assert!(has(&v, SecurityRule::CustomMcpVolumes, "mcp-hub"), "{v:#?}");
        let v = r.mutated(|d| {
            push(
                d,
                "mcp-hub",
                "volumes",
                &format!("{secrets}/slack-auth-token:/secrets/slack-auth-token:ro"),
            );
        });
        assert!(
            !has(&v, SecurityRule::CustomMcpVolumes, "mcp-hub"),
            "{v:#?}"
        );
    }

    #[test]
    fn overlapping_paths_are_compared_normalized_and_without_case() {
        assert!(paths_overlap("/a/secrets/p", "/a/secrets/p"));
        assert!(paths_overlap("/a/secrets", "/a/secrets/p"));
        assert!(paths_overlap("/a/secrets/p/x", "/a/secrets/p"));
        assert!(paths_overlap("/", "/a/secrets/p"));
        assert!(paths_overlap("/A/Secrets/P/", "/a/secrets/p"));
        assert!(paths_overlap("/a/b/../secrets/./p", "/a/secrets/p"));
        assert!(!paths_overlap("/a/secrets/px", "/a/secrets/p"));
        assert!(!paths_overlap("/a/oauth/p", "/a/secrets/p"));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn limits_out_of_budget_or_missing_fail() {
        let r = rendered();
        let v = r.mutated(|d| {
            svc(d, "mcp-custom-figma-up")["deploy"]["resources"]["limits"]["memory"] =
                Value::String("512m".into());
        });
        assert!(has(
            &v,
            SecurityRule::CustomMcpResources,
            "mcp-custom-figma-up"
        ));
        let v = r.mutated(|d| {
            svc(d, "mcp-custom-figma-egress")
                .as_mapping_mut()
                .unwrap()
                .remove("deploy");
        });
        assert!(has(
            &v,
            SecurityRule::CustomMcpResources,
            "mcp-custom-figma-egress"
        ));
        let v = r.mutated(|d| {
            for i in 0..consts::CUSTOM_MCP_MAX_PER_PROJECT {
                let id = format!("extra{i}");
                let mut guard = svc(d, "mcp-custom-desk").clone();
                guard["labels"][shape::ID_LABEL] = Value::String(id.clone());
                d["services"]
                    .as_mapping_mut()
                    .unwrap()
                    .insert(Value::String(Role::Guard.service_name(&id)), guard);
            }
        });
        assert!(has(&v, SecurityRule::CustomMcpResources, "*"), "{v:#?}");
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn custom_containers_must_be_read_only_with_a_noexec_tmp() {
        let r = rendered();
        let v = r.mutated(|d| {
            svc(d, "mcp-custom-figma-up")["read_only"] = Value::Bool(false);
            svc(d, "mcp-custom-figma-egress")
                .as_mapping_mut()
                .unwrap()
                .remove("tmpfs");
        });
        assert!(has(&v, SecurityRule::ReadOnlyFs, "mcp-custom-figma-up"));
        assert!(has(
            &v,
            SecurityRule::TmpfsNoexec,
            "mcp-custom-figma-egress"
        ));
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn a_snapshot_with_a_revoked_server_gives_way_to_the_fresh_render() {
        let r = rendered();
        let fresh = render(
            &r.fx,
            &integrations(vec![("desk", host_entry())], true, None),
        );
        let revoked = CustomMcpExpectations::from_effective(
            integrations(vec![("desk", host_entry())], true, None).effective_custom_mcp(),
        );
        let snapshot_violations = r.check_with(&r.yaml, revoked.clone());
        assert!(snapshot_violations
            .iter()
            .any(|v| v.rule == SecurityRule::CustomMcpConsent
                && v.container.starts_with("mcp-custom-figma")));
        let fresh_violations = r.check_with(&fresh, revoked);
        assert!(fresh_violations.is_empty(), "{fresh_violations:#?}");
        assert_eq!(
            crate::update::choose_rollback_compose(
                &snapshot_violations,
                Some((fresh.as_str(), fresh_violations.as_slice()))
            ),
            crate::update::RollbackComposeChoice::UseFreshRender
        );
    }

    #[test]
    fn memory_and_tmpfs_sizes_parse_in_mebibytes() {
        assert_eq!(parse_mib("256m"), Some(256.0));
        assert_eq!(parse_mib("1g"), Some(1024.0));
        assert_eq!(parse_mib("512k"), Some(0.5));
        assert_eq!(parse_mib("128MB"), Some(128.0));
        assert_eq!(parse_mib("lots"), None);
        assert_eq!(parse_mib("12x"), None);
        assert_eq!(parse_memory(&Value::String("1048576".into())), Some(1.0));
        assert_eq!(parse_cpus(&Value::String("0.25".into())), Some(0.25));
        assert_eq!(parse_cpus(&Value::Bool(true)), None);
    }

    #[test]
    fn custom_networks_are_classified_by_suffix() {
        assert_eq!(custom_net_of("a_b_network_custom"), Some(CustomNet::Hub));
        assert_eq!(
            custom_net_of("a_b_network_custom_host"),
            Some(CustomNet::HubHost)
        );
        assert_eq!(
            custom_net_of("a_b_network_cx_figma"),
            Some(CustomNet::Server("figma".into()))
        );
        assert_eq!(
            custom_net_of("a_b_network_eg_figma"),
            Some(CustomNet::Egress("figma".into()))
        );
        assert_eq!(custom_net_of("a_b_network"), None);
        assert_eq!(custom_net_of("a_b_network_office"), None);
    }
}
