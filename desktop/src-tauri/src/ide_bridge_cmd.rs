// IDE-bridge Tauri commands for IDE lock detection, connection, and config persistence.

use crate::health;
use crate::reconcile::SharedIdeBridge;
use speedwave_runtime::config;

#[tauri::command]
pub(crate) fn list_available_ides() -> Result<Vec<health::DetectedIde>, String> {
    Ok(health::list_available_ides())
}

#[tauri::command]
pub(crate) fn select_ide(
    ide_name: String,
    port: u16,
    state: tauri::State<SharedIdeBridge>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Validate against the raw live-port list (pre-dedupe).
    if !health::is_ide_port_alive(port) {
        log::warn!(
            target: "ide_bridge",
            "select_ide: port {port} is not a live IDE lock"
        );
        return Err(format!(
            "IDE on port {} is not in the detected IDEs list",
            port
        ));
    }
    log::info!(target: "ide_bridge", "select_ide: connecting to {ide_name} on port {port}");

    // Persist the selection to config.json
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        user_config.selected_ide = Some(speedwave_runtime::config::SelectedIde {
            ide_name: ide_name.clone(),
            port,
        });
        config::save_user_config(&user_config)
    })
    .map_err(|e| e.to_string())?;

    // Start IDE Bridge on-demand if it wasn't started at startup.
    crate::ensure_ide_bridge_running(&state, &app);

    // Update the live Bridge so new connections are proxied immediately
    let guard = state
        .lock()
        .map_err(|e| format!("Bridge mutex poisoned: {e}"))?;
    if let Some(bridge) = guard.as_ref() {
        bridge
            .set_upstream(ide_name, port)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn get_selected_ide() -> Result<Option<speedwave_runtime::config::SelectedIde>, String> {
    let user_config = config::load_user_config().map_err(|e| e.to_string())?;
    Ok(user_config.selected_ide)
}

/// User-initiated disconnect from the upstream IDE. Clears both the live
/// bridge proxy and the persisted `selected_ide` so a restart will not auto-reconnect.
#[tauri::command]
pub(crate) fn disconnect_ide(state: tauri::State<SharedIdeBridge>) -> Result<(), String> {
    log::info!(target: "ide_bridge", "disconnect_ide: clearing upstream");
    config::with_config_lock(|| {
        let mut user_config = config::load_user_config()?;
        user_config.selected_ide = None;
        config::save_user_config(&user_config)
    })
    .map_err(|e| e.to_string())?;
    let guard = state
        .lock()
        .map_err(|e| format!("Bridge mutex poisoned: {e}"))?;
    if let Some(bridge) = guard.as_ref() {
        bridge.clear_upstream();
    }
    Ok(())
}
