// System tray menu construction and refresh.

use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};

#[cfg(target_os = "macos")]
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-icon.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-icon-white.png");

/// Loads the platform-appropriate tray icon embedded in the binary.
///
/// macOS uses a black glyph paired with `icon_as_template(true)` so the system
/// inverts it for the active appearance. Windows and Linux use a white glyph
/// because their notification areas commonly render on a dark background and
/// have no template mode.
pub(crate) fn load_tray_icon() -> Result<Image<'static>, tauri::Error> {
    Image::from_bytes(TRAY_ICON_PNG)
}

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
        #[cfg(target_os = "linux")]
        let update_label = format!("Download Update v{version}");

        #[cfg(not(target_os = "linux"))]
        let update_label = format!("Install Update v{version}");

        let install_update = MenuItemBuilder::with_id("install_update", update_label).build(app)?;
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn tray_icon_asset_is_nonempty_png() {
        assert!(
            !TRAY_ICON_PNG.is_empty(),
            "tray icon asset must not be empty"
        );
        assert_eq!(
            &TRAY_ICON_PNG[..8],
            b"\x89PNG\r\n\x1a\n",
            "tray icon asset must be a valid PNG"
        );
    }

    #[test]
    fn load_tray_icon_returns_decodable_image() {
        let icon = load_tray_icon().expect("tray icon must decode");
        assert!(icon.width() > 0 && icon.height() > 0);
        assert_eq!(
            icon.width(),
            icon.height(),
            "tray icon must be square for consistent rendering at all scales"
        );
    }
}
