use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::Manager;

pub(crate) const TRAY_ID: &str = "main-tray";

pub(crate) const TOOLTIP_IDLE: &str = "Speedwave";
const TOOLTIP_RECORDING: &str = "Speedwave (recording)";

#[cfg(target_os = "macos")]
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-icon.png");
#[cfg(target_os = "windows")]
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-icon-white.png");

#[cfg(target_os = "macos")]
const TRAY_ICON_RECORDING_PNG: &[u8] = include_bytes!("../icons/tray-icon-recording.png");
#[cfg(target_os = "windows")]
const TRAY_ICON_RECORDING_PNG: &[u8] = include_bytes!("../icons/tray-icon-white-recording.png");

#[cfg(target_os = "macos")]
const TRAY_ICON_RECORDING_DIM_PNG: &[u8] = include_bytes!("../icons/tray-icon-recording-dim.png");
#[cfg(target_os = "windows")]
const TRAY_ICON_RECORDING_DIM_PNG: &[u8] =
    include_bytes!("../icons/tray-icon-white-recording-dim.png");

const BADGE_PULSES: bool = cfg!(target_os = "macos");

const BADGE_PULSE_HALF_PERIOD: Duration = Duration::from_millis(800);

static BADGE_PULSE_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayIconState {
    Idle,
    Recording,
    RecordingDimBadge,
}

fn tray_icon_png(state: TrayIconState) -> &'static [u8] {
    match state {
        TrayIconState::Idle => TRAY_ICON_PNG,
        TrayIconState::Recording => TRAY_ICON_RECORDING_PNG,
        TrayIconState::RecordingDimBadge => TRAY_ICON_RECORDING_DIM_PNG,
    }
}

fn tooltip_for(recording: bool) -> &'static str {
    if recording {
        TOOLTIP_RECORDING
    } else {
        TOOLTIP_IDLE
    }
}

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
    Image::from_bytes(tray_icon_png(TrayIconState::Idle))
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
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                if let Err(e) = tray.set_menu(Some(menu)) {
                    log::warn!("failed to set tray menu: {e}");
                }
            }
        }
        Err(e) => log::warn!("failed to build tray menu: {e}"),
    }
}

pub(crate) fn refresh_tray_icon(app: &tauri::AppHandle) {
    let handle = app.clone();
    if let Err(e) = app.run_on_main_thread(move || apply_recording_state(&handle)) {
        log::warn!("failed to queue the tray icon repaint: {e}");
    }
}

fn apply_recording_state(app: &tauri::AppHandle) {
    let recording = crate::transcription_cmd::is_recording(
        &app.state::<crate::transcription_cmd::DriversHandle>(),
    );
    let state = if recording {
        TrayIconState::Recording
    } else {
        TrayIconState::Idle
    };
    if !set_tray_icon(app, state) {
        return;
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Err(e) = tray.set_tooltip(Some(tooltip_for(recording))) {
            log::warn!("failed to set the tray tooltip: {e}");
        }
    }

    let generation = BADGE_PULSE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if recording && BADGE_PULSES {
        spawn_badge_pulse(app.clone(), generation);
    }
}

fn set_tray_icon(app: &tauri::AppHandle, state: TrayIconState) -> bool {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return false;
    };
    match Image::from_bytes(tray_icon_png(state)) {
        Ok(icon) => {
            if let Err(e) = tray.set_icon_with_as_template(Some(icon), true) {
                log::warn!("failed to set the tray icon: {e}");
            }
        }
        Err(e) => log::warn!("failed to decode the tray icon: {e}"),
    }
    true
}

fn spawn_badge_pulse(app: tauri::AppHandle, generation: u64) {
    tauri::async_runtime::spawn(async move {
        let mut dim = false;
        loop {
            tokio::time::sleep(BADGE_PULSE_HALF_PERIOD).await;
            if BADGE_PULSE_GENERATION.load(Ordering::SeqCst) != generation
                || !crate::transcription_cmd::is_recording(
                    &app.state::<crate::transcription_cmd::DriversHandle>(),
                )
            {
                return;
            }
            dim = !dim;
            let handle = app.clone();
            if app
                .run_on_main_thread(move || {
                    if BADGE_PULSE_GENERATION.load(Ordering::SeqCst) != generation
                        || !crate::transcription_cmd::is_recording(
                            &handle.state::<crate::transcription_cmd::DriversHandle>(),
                        )
                    {
                        return;
                    }
                    let state = if dim {
                        TrayIconState::RecordingDimBadge
                    } else {
                        TrayIconState::Recording
                    };
                    set_tray_icon(&handle, state);
                })
                .is_err()
            {
                return;
            }
        }
    });
}

#[cfg(test)]
#[expect(clippy::expect_used, reason = "test assertions may expect freely")]
mod tests {
    use super::*;

    #[test]
    fn tray_icon_asset_is_nonempty_png() {
        for state in [
            TrayIconState::Idle,
            TrayIconState::Recording,
            TrayIconState::RecordingDimBadge,
        ] {
            let png = tray_icon_png(state);
            assert!(!png.is_empty(), "tray icon asset must not be empty");
            assert_eq!(
                &png[..8],
                b"\x89PNG\r\n\x1a\n",
                "tray icon asset must be a valid PNG"
            );
        }
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
    fn recording_icon_is_a_decodable_square_matching_the_idle_icon() {
        let idle = load_tray_icon().expect("idle tray icon must decode");
        let recording = Image::from_bytes(tray_icon_png(TrayIconState::Recording))
            .expect("recording tray icon must decode");
        assert!(recording.width() > 0 && recording.height() > 0);
        assert_eq!(
            recording.width(),
            recording.height(),
            "recording icon must be square for consistent rendering at all scales"
        );
        assert_eq!(recording.width(), idle.width());
        assert_eq!(recording.height(), idle.height());
    }

    #[test]
    fn recording_state_selects_its_own_glyph_and_tooltip() {
        assert_ne!(
            tray_icon_png(TrayIconState::Recording),
            tray_icon_png(TrayIconState::Idle),
            "the recording state needs a glyph of its own"
        );
        assert_eq!(tooltip_for(false), TOOLTIP_IDLE);
        assert_eq!(tooltip_for(true), TOOLTIP_RECORDING);
        assert!(
            tooltip_for(true).contains("recording"),
            "the tooltip is the only text surface naming the state"
        );
    }

    #[test]
    fn the_dim_badge_shares_the_glyph_and_only_fades_the_dot() {
        let full = Image::from_bytes(tray_icon_png(TrayIconState::Recording))
            .expect("recording icon must decode");
        let dim = Image::from_bytes(tray_icon_png(TrayIconState::RecordingDimBadge))
            .expect("dimmed recording icon must decode");
        assert_eq!(dim.width(), full.width());
        assert_eq!(dim.height(), full.height());
        assert_ne!(
            tray_icon_png(TrayIconState::RecordingDimBadge),
            tray_icon_png(TrayIconState::Recording),
            "the pulse needs two distinct frames"
        );
        let alpha_sum = |img: &Image<'_>| -> u64 {
            img.rgba()
                .iter()
                .skip(3)
                .step_by(4)
                .copied()
                .map(u64::from)
                .sum()
        };
        let (full_alpha, dim_alpha) = (alpha_sum(&full), alpha_sum(&dim));
        assert!(
            dim_alpha < full_alpha,
            "the dimmed frame must be more transparent overall ({dim_alpha} vs {full_alpha})"
        );
        let faded = (full_alpha - dim_alpha) as f64 / full_alpha as f64;
        assert!(
            faded > 0.02 && faded < 0.20,
            "only the badge may fade, not the glyph (faded {:.1}% of the total alpha)",
            faded * 100.0
        );
    }

    #[test]
    fn the_pulse_runs_only_where_the_badge_cannot_be_coloured() {
        assert_eq!(BADGE_PULSES, cfg!(target_os = "macos"));
        assert!(
            BADGE_PULSE_HALF_PERIOD.as_millis() >= 500,
            "a faster toggle reads as a fault"
        );
    }

    #[test]
    fn the_pulse_loop_exits_on_a_stale_generation_and_a_stopped_recording() {
        let source = include_str!("tray.rs");
        let body = &source[source
            .find("fn spawn_badge_pulse(")
            .expect("spawn_badge_pulse must exist")..];
        let body = &body[..body.find("\n}\n").unwrap_or(body.len())];
        assert_eq!(
            body.matches("BADGE_PULSE_GENERATION.load(Ordering::SeqCst) != generation")
                .count(),
            2,
            "the loop must check its generation before the tick and again beside the paint"
        );
        let paint = &body[body
            .find("run_on_main_thread")
            .expect("the paint must be dispatched to the main thread")..];
        assert!(
            paint.contains("is_recording("),
            "the registry must be re-sampled beside the paint, not off-thread"
        );
        assert!(
            body[..body.find("run_on_main_thread").unwrap_or(body.len())].contains("is_recording("),
            "an emptied registry must end the loop even if the generation was missed"
        );
    }

    #[test]
    fn every_repaint_retires_the_previous_pulse_loop() {
        let source = include_str!("tray.rs");
        let body = &source[source
            .find("fn apply_recording_state(")
            .expect("apply_recording_state must exist")..];
        let body = &body[..body.find("\n}\n").unwrap_or(body.len())];
        assert!(
            body.contains("BADGE_PULSE_GENERATION.fetch_add(1, Ordering::SeqCst)"),
            "a repaint must bump the generation so no earlier loop can keep painting"
        );
    }

    #[test]
    fn the_repaint_reasserts_the_macos_template_flag() {
        let source = include_str!("tray.rs");
        let body = &source[source
            .find("fn set_tray_icon(")
            .expect("set_tray_icon must exist")..];
        let body = &body[..body.find("\n}\n").unwrap_or(body.len())];
        assert!(
            body.contains("set_icon_with_as_template(Some(icon), true)"),
            "the repaint must re-assert the template flag, not call set_icon"
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
