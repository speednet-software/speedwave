use crate::bridges::custom_host_relay::{CustomHostRelay, RelayRoute};
use crate::reconcile::SharedCustomHostRelays;
use speedwave_runtime::custom_mcp::effective::EffectiveCustomMcp;
use speedwave_runtime::custom_mcp::model::CustomMcpSource;

static GLOBAL_CUSTOM_HOST_RELAYS: std::sync::OnceLock<SharedCustomHostRelays> =
    std::sync::OnceLock::new();

pub(crate) fn set_global_custom_host_relays(handle: SharedCustomHostRelays) {
    let _ = GLOBAL_CUSTOM_HOST_RELAYS.set(handle);
}

/// The routes the relay of a project serves: one per effective host server.
pub(crate) fn host_routes(servers: &[EffectiveCustomMcp]) -> Vec<RelayRoute> {
    servers
        .iter()
        .filter_map(|s| match &s.source {
            CustomMcpSource::Host { port, path } => Some(RelayRoute {
                name: s.name.clone(),
                port: *port,
                path: path.clone(),
            }),
            CustomMcpSource::Npm { .. } => None,
        })
        .collect()
}

/// Makes the relay of `project` serve exactly `routes`: started on first need, routes replaced,
/// stopped with its `relay-*` dirs removed when no host server is left.
pub(crate) fn sync_project_relay(
    relays: &SharedCustomHostRelays,
    project: &str,
    routes: &[RelayRoute],
    start: impl FnOnce() -> anyhow::Result<CustomHostRelay>,
) -> anyhow::Result<()> {
    let mut map = relays
        .lock()
        .map_err(|e| anyhow::anyhow!("custom MCP relay map poisoned: {e}"))?;
    if routes.is_empty() {
        if let Some(mut relay) = map.remove(project) {
            let cleared = relay.set_routes(&[]);
            let stopped = relay.stop();
            log::info!("custom MCP relay of '{project}' stopped: no host server is left");
            cleared?;
            stopped?;
        }
        return Ok(());
    }
    let relay = match map.entry(project.to_string()) {
        std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
        std::collections::hash_map::Entry::Vacant(e) => e.insert(start()?),
    };
    relay.set_routes(routes)?;
    log::info!(
        "custom MCP relay of '{project}' on port {} serves {} host server(s)",
        relay.port(),
        routes.len()
    );
    Ok(())
}

/// Stops the relays of the projects `retire` selects: endpoints marked unavailable first, then
/// the listener. Their `relay-<name>/` tokens stay, so a later start reuses them.
pub(crate) fn stop_relays_where(relays: &SharedCustomHostRelays, retire: impl Fn(&str) -> bool) {
    let drained: Vec<(String, CustomHostRelay)> = match relays.lock() {
        Ok(mut map) => {
            let projects: Vec<String> = map.keys().filter(|p| retire(p)).cloned().collect();
            projects
                .iter()
                .filter_map(|p| map.remove_entry(p))
                .collect()
        }
        Err(e) => {
            log::warn!("custom MCP relays cleanup skipped, mutex poisoned: {e}");
            return;
        }
    };
    for (project, mut relay) in drained {
        if let Err(e) = relay.mark_unavailable() {
            log::warn!(
                "custom MCP relay of '{project}' could not mark its endpoints unavailable: {e:#}"
            );
        }
        match relay.stop() {
            Ok(()) => log::info!("custom MCP relay of '{project}' stopped"),
            Err(e) => log::warn!("custom MCP relay of '{project}' stop error: {e:#}"),
        }
    }
}

/// Project switch: stops the relay of every project other than `active`, which keeps its own.
pub(crate) fn stop_relays_except(active: &str) {
    if let Some(relays) = GLOBAL_CUSTOM_HOST_RELAYS.get() {
        stop_relays_where(relays, |p| p != active);
    }
}

/// Project removal: stops the relay of `project` before its state dir is deleted.
pub(crate) fn stop_relay_of(project: &str) {
    if let Some(relays) = GLOBAL_CUSTOM_HOST_RELAYS.get() {
        stop_relays_where(relays, |p| p == project);
    }
}

/// Called by every Desktop compose render before it renders, so the `relay-<name>/` files exist;
/// a relay failure is logged (the host guards answer unavailable) and never blocks the start.
pub(crate) fn sync_before_render(project: &str, servers: &[EffectiveCustomMcp]) {
    let Some(relays) = GLOBAL_CUSTOM_HOST_RELAYS.get() else {
        return;
    };
    let data_dir = speedwave_runtime::consts::data_dir();
    if let Err(e) = sync_project_relay(relays, project, &host_routes(servers), || {
        CustomHostRelay::start(data_dir, project)
    }) {
        log::error!("custom MCP relay of '{project}' could not be updated: {e:#}");
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions use unwrap")]
mod tests {
    use super::*;
    use speedwave_runtime::custom_mcp::effective::resolve_effective;
    use speedwave_runtime::custom_mcp::model::CustomMcpEntry;
    use speedwave_runtime::custom_mcp::paths;
    use std::collections::{BTreeMap, HashMap};
    use std::sync::{Arc, Mutex};

    const PROJECT: &str = "acme";

    fn host(port: u16) -> CustomMcpEntry {
        let mut entry: CustomMcpEntry = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "source": {"kind": "host", "port": port, "path": "/mcp"},
        }))
        .unwrap();
        entry.consent_digest =
            Some(speedwave_runtime::custom_mcp::policy::consent_digest(&entry).unwrap());
        entry
    }

    fn endpoint(data: &std::path::Path, name: &str) -> serde_json::Value {
        let path = paths::relay_dir_in(data, PROJECT, name)
            .unwrap()
            .join(speedwave_runtime::consts::CUSTOM_RELAY_ENDPOINT_FILE);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn host_routes_take_only_effective_host_servers() {
        let mut entries = BTreeMap::new();
        entries.insert("desk".to_string(), host(3845));
        let mut off = host(4000);
        off.enabled = false;
        entries.insert("off".to_string(), off);
        let resolution = resolve_effective(&entries, true, None);
        assert_eq!(
            host_routes(&resolution.effective),
            vec![RelayRoute {
                name: "desk".into(),
                port: 3845,
                path: "/mcp".into()
            }]
        );
        assert!(host_routes(&[]).is_empty());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn host_servers_start_the_relay_and_none_stops_it() {
        let data = tempfile::tempdir().unwrap();
        let relays: SharedCustomHostRelays = Arc::new(Mutex::new(HashMap::new()));
        let starts = std::cell::Cell::new(0);
        let start = || {
            starts.set(starts.get() + 1);
            CustomHostRelay::start(data.path(), PROJECT)
        };
        let desk = RelayRoute {
            name: "desk".into(),
            port: 3845,
            path: "/mcp".into(),
        };
        sync_project_relay(&relays, PROJECT, std::slice::from_ref(&desk), start).unwrap();
        assert_eq!(starts.get(), 1);
        assert!(relays.lock().unwrap().contains_key(PROJECT));
        assert_eq!(endpoint(data.path(), "desk")["available"], true);

        let pen = RelayRoute {
            name: "pen".into(),
            port: 3846,
            path: "/mcp".into(),
        };
        sync_project_relay(&relays, PROJECT, &[desk, pen], || {
            panic!("a running relay is reused, never started twice")
        })
        .unwrap();
        assert_eq!(endpoint(data.path(), "pen")["available"], true);

        sync_project_relay(&relays, PROJECT, &[], || panic!("nothing to start")).unwrap();
        assert!(relays.lock().unwrap().is_empty());
        assert!(!paths::relay_dir_in(data.path(), PROJECT, "desk")
            .unwrap()
            .exists());
        assert!(!paths::relay_dir_in(data.path(), PROJECT, "pen")
            .unwrap()
            .exists());
    }

    fn endpoint_of(data: &std::path::Path, project: &str, name: &str) -> serde_json::Value {
        let path = paths::relay_dir_in(data, project, name)
            .unwrap()
            .join(speedwave_runtime::consts::CUSTOM_RELAY_ENDPOINT_FILE);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn running_relays(data: &std::path::Path, projects: &[&str]) -> SharedCustomHostRelays {
        let relays: SharedCustomHostRelays = Arc::new(Mutex::new(HashMap::new()));
        let desk = RelayRoute {
            name: "desk".into(),
            port: 3845,
            path: "/mcp".into(),
        };
        for project in projects {
            sync_project_relay(&relays, project, std::slice::from_ref(&desk), || {
                CustomHostRelay::start(data, project)
            })
            .unwrap();
            assert_eq!(endpoint_of(data, project, "desk")["available"], true);
        }
        relays
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn stopping_selected_relays_marks_them_unavailable_and_keeps_the_rest() {
        let data = tempfile::tempdir().unwrap();
        let relays = running_relays(data.path(), &[PROJECT, "beta"]);

        stop_relays_where(&relays, |p| p != PROJECT);

        let map = relays.lock().unwrap();
        assert_eq!(map.keys().collect::<Vec<_>>(), vec![PROJECT]);
        drop(map);
        assert_eq!(endpoint_of(data.path(), "beta", "desk")["available"], false);
        assert!(paths::relay_dir_in(data.path(), "beta", "desk")
            .unwrap()
            .join(speedwave_runtime::consts::CUSTOM_RELAY_TOKEN_FILE)
            .is_file());
        assert!(!speedwave_runtime::custom_mcp::relay::is_running_in(
            data.path(),
            "beta"
        ));
        assert_eq!(endpoint_of(data.path(), PROJECT, "desk")["available"], true);
        assert!(speedwave_runtime::custom_mcp::relay::is_running_in(
            data.path(),
            PROJECT
        ));

        stop_relays_where(&relays, |_| true);
        assert!(relays.lock().unwrap().is_empty());
        assert!(!speedwave_runtime::custom_mcp::relay::is_running_in(
            data.path(),
            PROJECT
        ));
    }

    #[test]
    fn stopping_without_relays_is_a_no_op() {
        let relays: SharedCustomHostRelays = Arc::new(Mutex::new(HashMap::new()));
        stop_relays_where(&relays, |_| true);
        assert!(relays.lock().unwrap().is_empty());
    }

    #[test]
    fn a_landed_switch_keeps_only_the_new_projects_relay() {
        for (file, src, signature) in [
            (
                "project_cmd.rs",
                include_str!("../project_cmd.rs"),
                "pub(crate) async fn switch_project(",
            ),
            (
                "containers_cmd.rs",
                include_str!("../containers_cmd.rs"),
                "pub async fn add_project(",
            ),
        ] {
            let body = &src[src.find(signature).unwrap()..];
            let body = &body[..body.find("\n}\n").unwrap()];
            let stop = body
                .rfind("custom_mcp_cmd::relays::stop_relays_except(&name)")
                .unwrap_or_else(|| panic!("{file}: a landed switch must stop the other relays"));
            let cleared = body
                .find("clear_chat_sessions(")
                .unwrap_or_else(|| panic!("{file}: chat sessions cleared"));
            let succeeded = body
                .find("\"project_switch_succeeded\"")
                .unwrap_or_else(|| panic!("{file}: success event"));
            assert!(
                cleared < stop && stop < succeeded,
                "{file}: the relays stop once the switch landed, before it is reported"
            );
        }
    }

    #[test]
    fn project_removal_stops_the_relay_before_the_state_dir_is_deleted() {
        let src = include_str!("../containers_cmd.rs");
        let body = &src[src.find("pub async fn remove_project(").unwrap()..];
        let stop = body
            .find("custom_mcp_cmd::relays::stop_relay_of(n)")
            .unwrap_or_else(|| panic!("removal must stop the project's relay"));
        let remove = body
            .find("speedwave_runtime::project::remove_project(n)")
            .unwrap_or_else(|| panic!("removal must delete the project"));
        assert!(
            stop < remove,
            "the relay must stop before its dir is deleted"
        );
    }

    #[test]
    fn no_host_server_and_no_relay_starts_nothing() {
        let relays: SharedCustomHostRelays = Arc::new(Mutex::new(HashMap::new()));
        sync_project_relay(&relays, PROJECT, &[], || panic!("nothing to start")).unwrap();
        assert!(relays.lock().unwrap().is_empty());
    }

    #[test]
    fn a_failed_start_is_reported_and_nothing_is_kept() {
        let relays: SharedCustomHostRelays = Arc::new(Mutex::new(HashMap::new()));
        let route = RelayRoute {
            name: "desk".into(),
            port: 3845,
            path: "/mcp".into(),
        };
        let err = sync_project_relay(&relays, PROJECT, &[route], || anyhow::bail!("bind refused"))
            .unwrap_err();
        assert!(err.to_string().contains("bind refused"));
        assert!(relays.lock().unwrap().is_empty());
    }

    #[test]
    fn both_desktop_renderers_sync_the_relay_before_rendering() {
        for (file, src, render) in [
            (
                "containers_cmd.rs",
                include_str!("../containers_cmd.rs"),
                "fn render_and_save_compose(",
            ),
            (
                "setup_wizard.rs",
                include_str!("../setup_wizard.rs"),
                "pub fn start_containers(",
            ),
        ] {
            let body = &src[src
                .find(render)
                .unwrap_or_else(|| panic!("{file}: {render}"))..];
            let sync = body
                .find("custom_mcp_cmd::relays::sync_before_render(")
                .unwrap_or_else(|| panic!("{file} must sync the custom MCP relay"));
            let rendered = body
                .find("render_compose(")
                .unwrap_or_else(|| panic!("{file} must render"));
            assert!(
                sync < rendered,
                "{file}: the relay sync must precede the render"
            );
        }
    }
}
