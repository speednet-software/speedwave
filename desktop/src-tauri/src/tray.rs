//! System tray icon and context menu. `TrayMenuState` owns the menu's variable
//! bits; callers mutate via its accessors then call `refresh_tray_menu`. ADR-058.

use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::Manager;

#[cfg(target_os = "macos")]
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-icon.png");
#[cfg(target_os = "windows")]
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-icon-white.png");

/// Variable tray-menu inputs (`update_version`, `beta_enabled`) managed via
/// `app.manage`; access through the accessors, which recover from poisoning.
#[derive(Default)]
pub(crate) struct TrayMenuState {
    update_version: Mutex<Option<String>>,
    beta_enabled: Mutex<bool>,
}

impl TrayMenuState {
    pub(crate) fn new(beta_enabled: bool) -> Self {
        Self {
            update_version: Mutex::new(None),
            beta_enabled: Mutex::new(beta_enabled),
        }
    }

    pub(crate) fn update_version(&self) -> Option<String> {
        match self.update_version.lock() {
            Ok(g) => g.clone(),
            Err(p) => p.into_inner().clone(),
        }
    }

    pub(crate) fn set_update_version(&self, version: Option<String>) {
        match self.update_version.lock() {
            Ok(mut g) => *g = version,
            Err(p) => *p.into_inner() = version,
        }
    }

    pub(crate) fn beta_enabled(&self) -> bool {
        match self.beta_enabled.lock() {
            Ok(g) => *g,
            Err(p) => *p.into_inner(),
        }
    }

    pub(crate) fn set_beta_enabled(&self, enabled: bool) {
        match self.beta_enabled.lock() {
            Ok(mut g) => *g = enabled,
            Err(p) => *p.into_inner() = enabled,
        }
    }
}

/// Describes the tray menu shape independently of the Tauri `Menu` builder so
/// menu composition can be unit-tested without an `AppHandle`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TrayItemSpec {
    Open,
    Separator,
    CheckUpdate,
    InstallUpdate(String),
    Beta { enabled: bool },
    Quit,
}

/// Returns the ordered menu items for the given inputs. Beta toggle is hidden
/// before setup completion.
pub(crate) fn tray_menu_spec(
    update_version: Option<&str>,
    beta_enabled: bool,
    setup_complete: bool,
) -> Vec<TrayItemSpec> {
    let mut items = vec![
        TrayItemSpec::Open,
        TrayItemSpec::Separator,
        TrayItemSpec::CheckUpdate,
    ];
    if let Some(v) = update_version {
        items.push(TrayItemSpec::InstallUpdate(v.to_string()));
    }
    if setup_complete {
        items.push(TrayItemSpec::Separator);
        items.push(TrayItemSpec::Beta {
            enabled: beta_enabled,
        });
    }
    items.push(TrayItemSpec::Separator);
    items.push(TrayItemSpec::Quit);
    items
}

/// Loads the platform-appropriate tray icon embedded in the binary.
/// macOS: black glyph (template, system-inverted). Windows: white glyph.
pub(crate) fn load_tray_icon() -> Result<Image<'static>, tauri::Error> {
    Image::from_bytes(TRAY_ICON_PNG)
}

/// Builds the system tray context menu from the current state.
pub(crate) fn build_tray_menu(
    app: &tauri::AppHandle,
    update_version: Option<&str>,
    beta_enabled: bool,
    setup_complete: bool,
) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    let spec = tray_menu_spec(update_version, beta_enabled, setup_complete);
    let mut builder = MenuBuilder::new(app);
    for item in spec {
        match item {
            TrayItemSpec::Open => {
                let it = MenuItemBuilder::with_id("open", "Open Speedwave").build(app)?;
                builder = builder.item(&it);
            }
            TrayItemSpec::Separator => {
                builder = builder.separator();
            }
            TrayItemSpec::CheckUpdate => {
                let it =
                    MenuItemBuilder::with_id("check_update", "Check for Updates").build(app)?;
                builder = builder.item(&it);
            }
            TrayItemSpec::InstallUpdate(version) => {
                let label = format!("Install Update v{version}");
                let it = MenuItemBuilder::with_id("install_update", label).build(app)?;
                builder = builder.item(&it);
            }
            TrayItemSpec::Beta { enabled } => {
                let it = CheckMenuItemBuilder::with_id("toggle_beta", "Beta features")
                    .checked(enabled)
                    .build(app)?;
                builder = builder.item(&it);
            }
            TrayItemSpec::Quit => {
                let it = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
                builder = builder.item(&it);
            }
        }
    }
    builder.build()
}

/// Rebuilds the tray menu from the current `TrayMenuState` and setup-complete
/// status.
pub(crate) fn refresh_tray_menu(app: &tauri::AppHandle) {
    let state = app.state::<TrayMenuState>();
    let update_version = state.update_version();
    let beta_enabled = state.beta_enabled();
    let setup_complete = crate::setup_wizard::is_setup_complete();

    match build_tray_menu(app, update_version.as_deref(), beta_enabled, setup_complete) {
        Ok(menu) => {
            if let Some(tray) = app.tray_by_id("main-tray") {
                if let Err(e) = tray.set_menu(Some(menu)) {
                    log::warn!("failed to set tray menu: {e}");
                }
            }
        }
        Err(e) => log::warn!("failed to build tray menu: {e}"),
    }
}

#[cfg(test)]
#[expect(clippy::expect_used, reason = "test assertions may expect freely")]
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

    #[test]
    fn spec_setup_complete_no_update_shows_unchecked_beta() {
        let spec = tray_menu_spec(None, false, true);
        assert_eq!(
            spec,
            vec![
                TrayItemSpec::Open,
                TrayItemSpec::Separator,
                TrayItemSpec::CheckUpdate,
                TrayItemSpec::Separator,
                TrayItemSpec::Beta { enabled: false },
                TrayItemSpec::Separator,
                TrayItemSpec::Quit,
            ]
        );
    }

    #[test]
    fn spec_setup_complete_with_update_keeps_install_and_beta() {
        // ADR-058 regression: toggling beta must not drop "Install Update".
        let spec = tray_menu_spec(Some("1.2.3"), true, true);
        assert_eq!(
            spec,
            vec![
                TrayItemSpec::Open,
                TrayItemSpec::Separator,
                TrayItemSpec::CheckUpdate,
                TrayItemSpec::InstallUpdate("1.2.3".to_string()),
                TrayItemSpec::Separator,
                TrayItemSpec::Beta { enabled: true },
                TrayItemSpec::Separator,
                TrayItemSpec::Quit,
            ]
        );
    }

    #[test]
    fn spec_setup_incomplete_hides_beta_even_with_update() {
        // ADR-058 regression: beta toggle must not appear before setup.
        let spec = tray_menu_spec(Some("9.9.9"), true, false);
        assert!(
            !spec.iter().any(|i| matches!(i, TrayItemSpec::Beta { .. })),
            "no beta item before setup completion"
        );
        assert!(spec
            .iter()
            .any(|i| matches!(i, TrayItemSpec::InstallUpdate(v) if v == "9.9.9")));
    }

    #[test]
    fn spec_fresh_install_shows_only_open_check_quit() {
        let spec = tray_menu_spec(None, false, false);
        assert_eq!(
            spec,
            vec![
                TrayItemSpec::Open,
                TrayItemSpec::Separator,
                TrayItemSpec::CheckUpdate,
                TrayItemSpec::Separator,
                TrayItemSpec::Quit,
            ]
        );
    }
}
