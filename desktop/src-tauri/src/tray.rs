// System tray menu construction and refresh.

use tauri::menu::{MenuBuilder, MenuItemBuilder};

/// Builds the system tray context menu. If an update is available, includes
/// an "Install Update" item.
pub(crate) fn build_tray_menu(
    app: &tauri::AppHandle,
    update_version: &Option<String>,
) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    let open = MenuItemBuilder::with_id("open", "Open Speedwave").build(app)?;
    let check_update = MenuItemBuilder::with_id("check_update", "Check for Updates").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let mut builder = MenuBuilder::new(app)
        .item(&open)
        .separator()
        .item(&check_update);

    if let Some(version) = update_version {
        let install_update =
            MenuItemBuilder::with_id("install_update", format!("Install Update v{version}"))
                .build(app)?;
        builder = builder.item(&install_update);
    }

    builder.separator().item(&quit).build()
}

/// Rebuilds the tray menu to reflect a newly discovered update version.
pub(crate) fn refresh_tray_menu(app: &tauri::AppHandle, update_version: &Option<String>) {
    match build_tray_menu(app, update_version) {
        Ok(menu) => {
            if let Some(tray) = app.tray_by_id("main-tray") {
                if let Err(e) = tray.set_menu(Some(menu)) {
                    log::warn!("tray: failed to set menu: {e}");
                }
            }
        }
        Err(e) => log::warn!("tray: failed to build menu: {e}"),
    }
}
