//! Host-mode Custom MCP servers: only a guard, on the compose-managed `_custom_host` bridge, which
//! reaches the Desktop relay through `host.docker.internal` with the bearer in `/secrets/relay`.

use super::custom_mcp::{subdir_engine_path, CustomMcpCtx, Images, Role};
use super::{ensure_host_gateway_extra_host, networks};
use crate::consts;
use crate::custom_mcp::effective::EffectiveCustomMcp;
use crate::custom_mcp::paths::ServerSubdir;
use crate::engine_path::to_engine_path;
use serde_yaml_ng::Value;

/// Mount point of the server's relay directory in a host-mode guard.
pub(crate) const RELAY_MOUNT: &str = "/secrets/relay";

/// Path flavour of a raw project directory, as the guard's `SPW_HOST_PATH_STYLE` names it.
pub(crate) fn path_style_of(dir: &str) -> &'static str {
    let bytes = dir.as_bytes();
    if dir.starts_with("\\\\") {
        "unc"
    } else if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
    {
        "windows"
    } else {
        "posix"
    }
}

fn escape_interpolation(value: &str) -> String {
    value.replace('$', "$$")
}

/// Adds the guard of host-mode `server` to `doc`.
pub(crate) fn add_host_server(
    doc: &mut Value,
    ctx: &CustomMcpCtx<'_>,
    server: &EffectiveCustomMcp,
    images: &Images,
) -> anyhow::Result<()> {
    let name = server.name.as_str();
    let guard = Role::Guard.service_name(name);
    let relay =
        crate::custom_mcp::paths::ensure_relay_dir_in(ctx.data_dir, ctx.project_name, name)?;
    let service = super::custom_mcp::service_value(
        super::custom_mcp::hardened_service(ctx, server, Role::Guard, &images.guard),
        vec![
            format!(
                "{}:/policy:ro",
                subdir_engine_path(ctx.data_dir, ctx.project_name, name, ServerSubdir::Guard)?
            ),
            format!("{}:{RELAY_MOUNT}:ro", to_engine_path(&relay)?),
        ],
        vec![
            format!("PORT={}", consts::PORT_WORKER),
            format!("SPW_CUSTOM_SERVER={name}"),
            "SPW_CUSTOM_MODE=host".to_string(),
            format!(
                "POLICY_FILE=/policy/{}",
                consts::CUSTOM_MCP_GUARD_POLICY_FILE
            ),
            format!("SPW_RELAY_DIR={RELAY_MOUNT}"),
            format!(
                "SPW_HOST_PROJECT_DIR={}",
                escape_interpolation(ctx.project_dir)
            ),
            format!("SPW_HOST_PATH_STYLE={}", path_style_of(ctx.project_dir)),
        ],
        vec![networks::custom_host_network_name(ctx.network_name)],
    );
    super::custom_mcp::insert_service(doc, guard.clone(), service)?;
    ensure_host_gateway_extra_host(doc, &guard)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::super::custom_mcp::tests::{host_entry, integrations, render, Fixture};
    use super::*;

    #[test]
    fn path_style_follows_the_host_dir_shape() {
        assert_eq!(path_style_of("/Users/a/proj"), "posix");
        assert_eq!(path_style_of("C:\\Users\\a\\proj"), "windows");
        assert_eq!(path_style_of("d:/work/proj"), "windows");
        assert_eq!(
            path_style_of("\\\\wsl.localhost\\Ubuntu\\home\\a\\proj"),
            "unc"
        );
        assert_eq!(path_style_of("\\\\wsl$\\Ubuntu\\home\\a"), "unc");
        assert_eq!(path_style_of("C:"), "posix");
        assert_eq!(path_style_of(""), "posix");
        assert_eq!(path_style_of("relative/dir"), "posix");
    }

    #[test]
    fn interpolation_is_escaped_and_nothing_else_changes() {
        assert_eq!(escape_interpolation("/home/a/$proj"), "/home/a/$$proj");
        let unc = "\\\\wsl.localhost\\Ubuntu\\home\\a\\proj";
        assert_eq!(escape_interpolation(unc), unc);
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn host_guard_gets_the_raw_project_dir_and_no_internal_network() {
        let fx = Fixture::new();
        let yaml = render(&fx, &integrations(vec![("desk", host_entry())], true, None));
        let d: Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let env = d["services"]["mcp-custom-desk"]["environment"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .find_map(|e| e.strip_prefix("SPW_HOST_PROJECT_DIR="))
            .unwrap()
            .to_string();
        assert_eq!(env, fx.project_dir());
        assert!(d["services"]["mcp-hub"]["networks"]
            .as_sequence()
            .unwrap()
            .iter()
            .all(|n| !n.as_str().unwrap_or_default().ends_with("_custom")));
    }
}
