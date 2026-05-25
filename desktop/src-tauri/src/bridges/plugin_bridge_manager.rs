//! Plugin host-bridge lifecycle: spawn at startup for each verified plugin
//! whose manifest declares a `host_bridge` block, and replace/stop on install
//! and remove. Bridges live for the Desktop process lifetime; per-pair status
//! is published on the `plugin_bridge_event` Tauri event.

use std::sync::Arc;

use speedwave_runtime::plugin::HostBridgeManifest;
use tauri::{AppHandle, Emitter};

use crate::bridges::plugin_host_bridge::{PluginBridgeEvent, PluginHostBridge};
use crate::reconcile::{global_plugin_bridges, SharedPluginBridges};

pub fn init_and_start(plugin_bridges: &SharedPluginBridges, app_handle: &AppHandle) {
    let plugins = match speedwave_runtime::plugin::list_verified_plugins() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("plugin bridges init: list_verified_plugins failed: {e}");
            return;
        }
    };
    for vp in plugins {
        let Some(manifest) = vp.manifest.host_bridge.clone() else {
            continue;
        };
        spawn_one(&vp.manifest.slug, manifest, plugin_bridges, app_handle);
    }
}

pub fn stop_for(slug: &str) {
    let Some(map) = global_plugin_bridges() else {
        log::warn!("plugin bridge[{slug}] stop: global registry not initialized");
        return;
    };
    if let Ok(mut guard) = map.lock() {
        if let Some(mut bridge) = guard.remove(slug) {
            if let Err(e) = bridge.stop() {
                log::warn!("plugin bridge[{slug}] stop error: {e}");
            }
        }
    }
}

pub fn respawn_for(slug: &str, app_handle: &AppHandle) {
    stop_for(slug);
    let manifest = match speedwave_runtime::plugin::list_verified_plugins() {
        Ok(plugins) => plugins
            .into_iter()
            .find(|vp| vp.manifest.slug == slug)
            .and_then(|vp| vp.manifest.host_bridge.clone()),
        Err(e) => {
            log::warn!("plugin bridge[{slug}] respawn: list_verified_plugins failed: {e}");
            return;
        }
    };
    let Some(manifest) = manifest else {
        return;
    };
    let Some(map) = global_plugin_bridges() else {
        log::warn!("plugin bridge[{slug}] respawn: global registry not initialized");
        return;
    };
    spawn_one(slug, manifest, map, app_handle);
}

fn spawn_one(
    slug: &str,
    manifest: HostBridgeManifest,
    plugin_bridges: &SharedPluginBridges,
    app_handle: &AppHandle,
) {
    let mut bridge = match PluginHostBridge::new(slug, manifest) {
        Ok(b) => b,
        Err(e) => {
            log::error!("plugin bridge[{slug}] init error: {e}");
            return;
        }
    };
    let handle = app_handle.clone();
    let event_slug = slug.to_string();
    bridge.set_event_callback(Arc::new(move |evt| {
        log_and_emit_event(&handle, &event_slug, evt)
    }));
    if let Err(e) = bridge.start() {
        log::error!("plugin bridge[{slug}] start error: {e}");
        return;
    }
    log::info!("plugin bridge[{slug}] started on port {}", bridge.port());
    match plugin_bridges.lock() {
        Ok(mut map) => {
            map.insert(slug.to_string(), bridge);
        }
        Err(e) => {
            log::error!(
                "plugin bridge[{slug}] failed to register (mutex poisoned): {e}; dropping bridge"
            );
        }
    }
}

fn log_and_emit_event(handle: &AppHandle, slug: &str, evt: PluginBridgeEvent) {
    match &evt {
        PluginBridgeEvent::SlotOccupied { role } => {
            log::info!("plugin bridge[{slug}] slot occupied by role '{role}'")
        }
        PluginBridgeEvent::Paired { roles } => log::info!(
            "plugin bridge[{slug}] paired: {} role(s) connected ({roles:?})",
            roles.len()
        ),
        PluginBridgeEvent::Disconnected { reason } => {
            log::warn!("plugin bridge[{slug}] disconnected: {reason}")
        }
        PluginBridgeEvent::PairBusy => log::warn!(
            "plugin bridge[{slug}] pair busy: new connection rejected (existing pair active)"
        ),
        PluginBridgeEvent::EvictedOlder { role } => {
            log::warn!("plugin bridge[{slug}] evicted older connection for role '{role}'")
        }
        PluginBridgeEvent::PendingTimeout { role } => {
            log::warn!("plugin bridge[{slug}] pending slot timeout for role '{role}'")
        }
    }
    let mut payload = match serde_json::to_value(&evt) {
        Ok(v) => v,
        Err(e) => {
            log::error!("plugin bridge[{slug}] serialize event: {e}");
            return;
        }
    };
    if let serde_json::Value::Object(map) = &mut payload {
        map.insert("slug".into(), serde_json::Value::String(slug.to_string()));
    }
    let _ = handle.emit("plugin_bridge_event", payload);
}
