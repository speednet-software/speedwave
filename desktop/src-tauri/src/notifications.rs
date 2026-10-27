//! Native OS notifications for chat-session events (SPEED-522, ADR-100).

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use speedwave_runtime::config::{self, NotificationPrefs};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
mod win;
#[cfg(windows)]
use win as platform;

/// Event the frontend receives when the user clicks a notification.
pub(crate) const ACTIVATED_EVENT: &str = "notification_activated";

const MAX_TRACKED_NOTIFICATIONS: usize = 64;

#[cfg(any(windows, test))]
const TOAST_SETTING_ENABLED: i32 = 0;

#[cfg(any(windows, test))]
const HRESULT_ERROR_NOT_FOUND: i32 = 0x8007_0490_u32.cast_signed();

static ACTIVATION_APP: OnceLock<AppHandle> = OnceLock::new();

/// A chat-session event that can raise a notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionEvent {
    /// The session finished its turn and nothing queued follows it.
    TurnFinished,
    /// The session asks the user a question (`AskUserQuestion`).
    AwaitingInput,
    /// The turn or the session ended with an error.
    SessionError,
}

/// Whether this app may show notifications; mirrored by `models/notifications.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationPermission {
    /// Notifications are allowed.
    Granted,
    /// Never asked; the first notification shows the system prompt (macOS).
    #[cfg(any(target_os = "macos", test))]
    Undetermined,
    /// The user or a policy turned notifications off for this app.
    Denied,
    /// Allowed, but Windows holds notifications back (full screen, presentation, first hour after sign-in).
    #[cfg(any(windows, test))]
    Suppressed,
    /// Not available in this build (a development binary outside an installed app).
    Unavailable,
}

/// Switches and permission state shown in Settings; mirrored by `models/notifications.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct NotificationSettings {
    /// Resolved switches from the user config.
    pub prefs: NotificationPrefs,
    /// What the OS currently allows.
    pub permission: NotificationPermission,
}

/// The tab a notification belongs to; payload of [`ACTIVATED_EVENT`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct NotificationTarget {
    pub(crate) project: String,
    pub(crate) tab_id: String,
}

#[derive(Debug, PartialEq, Eq)]
enum Withheld {
    Off,
    InFront,
    Permission(NotificationPermission),
}

#[derive(Default)]
struct TrackedNotifications(VecDeque<(String, NotificationTarget)>);

impl TrackedNotifications {
    fn track(&mut self, target: NotificationTarget) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        push_bounded(&mut self.0, (id.clone(), target));
        id
    }

    fn take(&mut self, id: &str) -> Option<NotificationTarget> {
        let pos = self.0.iter().position(|(tracked, _)| tracked == id)?;
        self.0.remove(pos).map(|(_, target)| target)
    }
}

/// Registers the click handler; call once from the app's `setup`.
pub(crate) fn install(app: &AppHandle) {
    if ACTIVATION_APP.set(app.clone()).is_ok() {
        #[cfg(target_os = "macos")]
        platform::install_click_delegate();
    } else {
        log::warn!("notification click handler already installed");
    }
}

/// Shows a notification for `event` when beta, its switch and the background window allow it.
pub(crate) fn notify_session_event(
    app: &AppHandle,
    project: &str,
    tab_id: &str,
    event: SessionEvent,
) {
    let app = app.clone();
    let target = NotificationTarget {
        project: project.to_string(),
        tab_id: tab_id.to_string(),
    };
    tauri::async_runtime::spawn_blocking(move || deliver(&app, target, event));
}

/// Reads the switches and the permission state for Settings; never prompts.
#[tauri::command]
pub async fn get_notification_settings(app: AppHandle) -> Result<NotificationSettings, String> {
    let app_id = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let prefs = config::load_user_config()
            .map_err(|e| e.to_string())?
            .notification_prefs();
        Ok(NotificationSettings {
            prefs,
            permission: platform::permission(&app_id),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stores every notification switch.
#[tauri::command]
pub async fn set_notification_prefs(prefs: NotificationPrefs) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        config::with_config_lock(|| {
            let mut cfg = config::load_user_config()?;
            cfg.set_notification_prefs(prefs);
            config::save_user_config(&cfg)
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Shows the system prompt when the permission is undetermined, then reports the state.
#[tauri::command]
pub async fn request_notification_permission(
    app: AppHandle,
) -> Result<NotificationPermission, String> {
    let app_id = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || platform::resolve_permission(&app_id))
        .await
        .map_err(|e| e.to_string())
}

/// Opens the system pane where the user can allow Speedwave's notifications.
#[tauri::command]
pub fn open_notification_settings(app: AppHandle) -> Result<(), String> {
    platform::open_system_settings(&app.config().identifier)
}

fn on_activated(id: &str) {
    if let Some(app) = ACTIVATION_APP.get() {
        activate(app, id);
    }
}

fn activate(app: &AppHandle, id: &str) {
    let target = tracked().lock().unwrap_or_else(|e| e.into_inner()).take(id);
    crate::window::show_main_window(app);
    if let Some(window) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) {
        if let Err(e) = window.unminimize() {
            log::warn!("failed to unminimize the window: {e}");
        }
    }
    let Some(target) = target else {
        log::info!("clicked notification {id} is no longer tracked; window raised only");
        return;
    };
    if let Err(e) = app.emit(ACTIVATED_EVENT, target) {
        log::warn!("failed to emit {ACTIVATED_EVENT}: {e}");
    }
}

fn deliver(app: &AppHandle, target: NotificationTarget, event: SessionEvent) {
    let cfg = match config::load_user_config() {
        Ok(cfg) => cfg,
        Err(e) => {
            log::warn!("notification for {event:?} skipped: user config unreadable: {e:#}");
            return;
        }
    };
    let app_id = app.config().identifier.clone();
    match decide(
        cfg.beta_enabled(),
        &cfg.notification_prefs(),
        event,
        main_window_in_background(app),
        || platform::resolve_permission(&app_id),
    ) {
        Ok(()) => {}
        Err(Withheld::Permission(permission)) => {
            log::info!("notification for {event:?} not shown: permission {permission:?}");
            return;
        }
        Err(Withheld::Off | Withheld::InFront) => return,
    }
    let (title, body) = content(event, &target.project);
    let id = tracked()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .track(target);
    if let Err(e) = platform::show(&app_id, &id, &title, &body) {
        log::warn!("failed to show a notification for {event:?}: {e}");
    }
}

fn decide(
    beta_enabled: bool,
    prefs: &NotificationPrefs,
    event: SessionEvent,
    in_background: bool,
    resolve_permission: impl FnOnce() -> NotificationPermission,
) -> Result<(), Withheld> {
    if !beta_enabled || !should_notify(prefs, event) {
        return Err(Withheld::Off);
    }
    if !in_background {
        return Err(Withheld::InFront);
    }
    let permission = resolve_permission();
    if may_show(permission) {
        Ok(())
    } else {
        Err(Withheld::Permission(permission))
    }
}

fn should_notify(prefs: &NotificationPrefs, event: SessionEvent) -> bool {
    let kind_on = match event {
        SessionEvent::TurnFinished => prefs.turn_finished,
        SessionEvent::AwaitingInput => prefs.awaiting_input,
        SessionEvent::SessionError => prefs.session_error,
    };
    prefs.enabled && kind_on
}

fn main_window_in_background(app: &AppHandle) -> bool {
    let Some(window) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) else {
        return true;
    };
    is_background(
        window.is_visible().unwrap_or(false),
        window.is_minimized().unwrap_or(false),
        window.is_focused().unwrap_or(false),
    )
}

fn is_background(visible: bool, minimized: bool, focused: bool) -> bool {
    !visible || minimized || !focused
}

fn may_show(permission: NotificationPermission) -> bool {
    match permission {
        NotificationPermission::Granted => true,
        #[cfg(any(windows, test))]
        NotificationPermission::Suppressed => true,
        _ => false,
    }
}

fn content(event: SessionEvent, project: &str) -> (String, String) {
    let body = match event {
        SessionEvent::TurnFinished => "Claude finished and is ready for your next message.",
        SessionEvent::AwaitingInput => "Claude is waiting for your answer.",
        SessionEvent::SessionError => "The session stopped with an error.",
    };
    (project.to_string(), body.to_string())
}

fn tracked() -> &'static Mutex<TrackedNotifications> {
    static TRACKED: OnceLock<Mutex<TrackedNotifications>> = OnceLock::new();
    TRACKED.get_or_init(|| Mutex::new(TrackedNotifications::default()))
}

fn push_bounded<T>(queue: &mut VecDeque<T>, item: T) {
    while queue.len() >= MAX_TRACKED_NOTIFICATIONS {
        queue.pop_front();
    }
    queue.push_back(item);
}

#[cfg(any(target_os = "macos", test))]
fn classify_authorization_status(raw: isize) -> NotificationPermission {
    match raw {
        0 => NotificationPermission::Undetermined,
        2..=4 => NotificationPermission::Granted,
        _ => NotificationPermission::Denied,
    }
}

#[cfg(any(windows, test))]
fn classify_toast_setting(setting: i32, user_state: Option<i32>) -> NotificationPermission {
    const QUNS_BUSY: i32 = 2;
    const QUNS_RUNNING_D3D_FULL_SCREEN: i32 = 3;
    const QUNS_PRESENTATION_MODE: i32 = 4;
    const QUNS_QUIET_TIME: i32 = 6;
    if setting != TOAST_SETTING_ENABLED {
        return NotificationPermission::Denied;
    }
    match user_state {
        Some(
            QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE | QUNS_QUIET_TIME,
        ) => NotificationPermission::Suppressed,
        _ => NotificationPermission::Granted,
    }
}

#[cfg(any(windows, test))]
fn classify_toast_setting_error(hresult: i32, user_state: Option<i32>) -> NotificationPermission {
    if hresult == HRESULT_ERROR_NOT_FOUND {
        classify_toast_setting(TOAST_SETTING_ENABLED, user_state)
    } else {
        NotificationPermission::Unavailable
    }
}

#[cfg(any(windows, test))]
fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(any(windows, test))]
fn toast_xml(title: &str, body: &str) -> String {
    format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        xml_escape(title),
        xml_escape(body)
    )
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;

    fn prefs(enabled: bool, turn: bool, input: bool, error: bool) -> NotificationPrefs {
        NotificationPrefs {
            enabled,
            turn_finished: turn,
            awaiting_input: input,
            session_error: error,
        }
    }

    const EVENTS: [SessionEvent; 3] = [
        SessionEvent::TurnFinished,
        SessionEvent::AwaitingInput,
        SessionEvent::SessionError,
    ];

    fn decide_with(
        beta: bool,
        p: NotificationPrefs,
        event: SessionEvent,
        in_background: bool,
        permission: NotificationPermission,
    ) -> (Result<(), Withheld>, u32) {
        let mut asked = 0;
        let result = decide(beta, &p, event, in_background, || {
            asked += 1;
            permission
        });
        (result, asked)
    }

    #[test]
    fn every_event_notifies_in_the_background_with_beta_and_all_switches_on() {
        for event in EVENTS {
            assert_eq!(
                decide_with(
                    true,
                    prefs(true, true, true, true),
                    event,
                    true,
                    NotificationPermission::Granted
                ),
                (Ok(()), 1)
            );
        }
    }

    #[test]
    fn nothing_notifies_or_prompts_while_the_window_is_in_front() {
        for event in EVENTS {
            assert_eq!(
                decide_with(
                    true,
                    prefs(true, true, true, true),
                    event,
                    false,
                    NotificationPermission::Granted
                ),
                (Err(Withheld::InFront), 0)
            );
        }
    }

    #[test]
    fn nothing_notifies_or_prompts_without_beta() {
        for event in EVENTS {
            assert_eq!(
                decide_with(
                    false,
                    prefs(true, true, true, true),
                    event,
                    true,
                    NotificationPermission::Granted
                ),
                (Err(Withheld::Off), 0)
            );
        }
    }

    #[test]
    fn a_switched_off_event_never_asks_for_permission() {
        assert_eq!(
            decide_with(
                true,
                prefs(false, true, true, true),
                SessionEvent::TurnFinished,
                true,
                NotificationPermission::Undetermined
            ),
            (Err(Withheld::Off), 0)
        );
        assert_eq!(
            decide_with(
                true,
                prefs(true, true, false, true),
                SessionEvent::AwaitingInput,
                true,
                NotificationPermission::Undetermined
            ),
            (Err(Withheld::Off), 0)
        );
    }

    #[test]
    fn a_denied_or_unanswered_permission_withholds_the_notification() {
        for permission in [
            NotificationPermission::Denied,
            NotificationPermission::Undetermined,
            NotificationPermission::Unavailable,
        ] {
            assert_eq!(
                decide_with(
                    true,
                    prefs(true, true, true, true),
                    SessionEvent::SessionError,
                    true,
                    permission
                ),
                (Err(Withheld::Permission(permission)), 1)
            );
        }
    }

    #[test]
    fn a_suppressed_permission_still_hands_the_notification_to_windows() {
        assert_eq!(
            decide_with(
                true,
                prefs(true, true, true, true),
                SessionEvent::AwaitingInput,
                true,
                NotificationPermission::Suppressed
            ),
            (Ok(()), 1)
        );
    }

    #[test]
    fn the_master_switch_silences_every_event() {
        for event in EVENTS {
            assert!(!should_notify(&prefs(false, true, true, true), event));
        }
    }

    #[test]
    fn each_switch_silences_only_its_own_event() {
        let cases = [
            (prefs(true, false, true, true), SessionEvent::TurnFinished),
            (prefs(true, true, false, true), SessionEvent::AwaitingInput),
            (prefs(true, true, true, false), SessionEvent::SessionError),
        ];
        for (p, off) in cases {
            for event in EVENTS {
                assert_eq!(should_notify(&p, event), event != off, "{event:?}");
            }
        }
    }

    #[test]
    fn the_window_counts_as_background_unless_visible_unminimized_and_focused() {
        assert!(!is_background(true, false, true));
        assert!(is_background(false, false, true));
        assert!(is_background(true, true, true));
        assert!(is_background(true, false, false));
        assert!(is_background(false, true, false));
    }

    #[test]
    fn only_granted_or_suppressed_permission_shows_a_notification() {
        assert!(may_show(NotificationPermission::Granted));
        assert!(may_show(NotificationPermission::Suppressed));
        assert!(!may_show(NotificationPermission::Denied));
        assert!(!may_show(NotificationPermission::Undetermined));
        assert!(!may_show(NotificationPermission::Unavailable));
    }

    #[test]
    fn content_names_the_project_and_carries_no_session_text() {
        let bodies: Vec<String> = EVENTS
            .iter()
            .map(|e| {
                let (title, body) = content(*e, "żółw & co");
                assert_eq!(title, "żółw & co");
                body
            })
            .collect();
        assert_eq!(
            bodies,
            [
                "Claude finished and is ready for your next message.",
                "Claude is waiting for your answer.",
                "The session stopped with an error.",
            ]
        );
    }

    #[test]
    fn a_clicked_notification_resolves_its_tab_once() {
        let mut tracked = TrackedNotifications::default();
        let target = NotificationTarget {
            project: "p".into(),
            tab_id: "t1".into(),
        };
        let id = tracked.track(target.clone());
        assert_eq!(tracked.take(&id), Some(target));
        assert_eq!(tracked.take(&id), None);
        assert_eq!(tracked.take("unknown"), None);
    }

    #[test]
    fn tracking_drops_the_oldest_notification_beyond_the_cap() {
        let mut tracked = TrackedNotifications::default();
        let ids: Vec<String> = (0..=MAX_TRACKED_NOTIFICATIONS)
            .map(|i| {
                tracked.track(NotificationTarget {
                    project: "p".into(),
                    tab_id: format!("t{i}"),
                })
            })
            .collect();
        assert_eq!(tracked.0.len(), MAX_TRACKED_NOTIFICATIONS);
        assert_eq!(tracked.take(&ids[0]), None);
        assert_eq!(
            tracked.take(ids.last().unwrap()).map(|t| t.tab_id),
            Some(format!("t{MAX_TRACKED_NOTIFICATIONS}"))
        );
    }

    #[test]
    fn a_bounded_queue_keeps_the_newest_entries_up_to_the_cap() {
        let mut queue = VecDeque::new();
        for i in 0..MAX_TRACKED_NOTIFICATIONS + 3 {
            push_bounded(&mut queue, i);
        }
        assert_eq!(queue.len(), MAX_TRACKED_NOTIFICATIONS);
        assert_eq!(queue.front(), Some(&3));
        assert_eq!(queue.back(), Some(&(MAX_TRACKED_NOTIFICATIONS + 2)));

        let mut empty: VecDeque<u8> = VecDeque::new();
        push_bounded(&mut empty, 1);
        assert_eq!(empty, VecDeque::from([1]));
    }

    #[test]
    fn authorization_status_maps_every_known_value_and_fails_closed() {
        assert_eq!(
            classify_authorization_status(0),
            NotificationPermission::Undetermined
        );
        assert_eq!(
            classify_authorization_status(1),
            NotificationPermission::Denied
        );
        for granted in 2..=4 {
            assert_eq!(
                classify_authorization_status(granted),
                NotificationPermission::Granted
            );
        }
        assert_eq!(
            classify_authorization_status(5),
            NotificationPermission::Denied
        );
        assert_eq!(
            classify_authorization_status(-1),
            NotificationPermission::Denied
        );
    }

    #[test]
    fn toast_setting_other_than_enabled_is_denied() {
        for setting in 1..=4 {
            assert_eq!(
                classify_toast_setting(setting, Some(5)),
                NotificationPermission::Denied
            );
        }
        assert_eq!(
            classify_toast_setting(99, None),
            NotificationPermission::Denied
        );
    }

    #[test]
    fn enabled_toasts_report_quiet_states_as_suppressed() {
        for quiet in [2, 3, 4, 6] {
            assert_eq!(
                classify_toast_setting(0, Some(quiet)),
                NotificationPermission::Suppressed
            );
        }
        for open in [Some(1), Some(5), Some(7), None] {
            assert_eq!(
                classify_toast_setting(0, open),
                NotificationPermission::Granted
            );
        }
    }

    #[test]
    fn an_app_windows_has_no_toast_setting_for_yet_is_treated_as_enabled() {
        assert_eq!(
            classify_toast_setting_error(HRESULT_ERROR_NOT_FOUND, None),
            NotificationPermission::Granted
        );
        for quiet in [2, 3, 4, 6] {
            assert_eq!(
                classify_toast_setting_error(HRESULT_ERROR_NOT_FOUND, Some(quiet)),
                NotificationPermission::Suppressed
            );
        }
    }

    #[test]
    fn the_first_toast_of_a_fresh_install_is_not_withheld() {
        for event in EVENTS {
            assert_eq!(
                decide_with(
                    true,
                    prefs(true, true, true, true),
                    event,
                    true,
                    classify_toast_setting_error(HRESULT_ERROR_NOT_FOUND, None)
                ),
                (Ok(()), 1)
            );
        }
    }

    #[test]
    fn any_other_toast_setting_error_is_unavailable() {
        for hresult in [
            0,
            0x8000_4005_u32.cast_signed(),
            0x8007_0005_u32.cast_signed(),
            0x8007_0491_u32.cast_signed(),
            0x0000_0490,
            i32::MIN,
            i32::MAX,
        ] {
            assert_eq!(
                classify_toast_setting_error(hresult, None),
                NotificationPermission::Unavailable,
                "hresult {hresult:#x}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn error_not_found_hresult_matches_the_windows_sdk() {
        assert_eq!(
            HRESULT_ERROR_NOT_FOUND,
            windows::core::HRESULT::from_win32(windows_sys::Win32::Foundation::ERROR_NOT_FOUND).0
        );
    }

    #[test]
    fn toast_xml_escapes_markup_in_the_title_and_body() {
        let xml = toast_xml("a<b>&\"c'", "ok");
        assert!(xml.contains("<text>a&lt;b&gt;&amp;&quot;c&apos;</text><text>ok</text>"));
        assert_eq!(xml_escape(""), "");
        assert_eq!(xml_escape("zażółć"), "zażółć");
    }

    #[test]
    fn notification_permission_matches_ts_union() {
        let all = [
            NotificationPermission::Granted,
            NotificationPermission::Undetermined,
            NotificationPermission::Denied,
            NotificationPermission::Suppressed,
            NotificationPermission::Unavailable,
        ];
        for p in all {
            match p {
                NotificationPermission::Granted
                | NotificationPermission::Undetermined
                | NotificationPermission::Denied
                | NotificationPermission::Suppressed
                | NotificationPermission::Unavailable => {}
            }
        }
        let mut rust: Vec<String> = all
            .iter()
            .map(|p| {
                serde_json::to_value(p)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        rust.sort();

        let src = include_str!("../../src/src/app/models/notifications.ts");
        let marker = "export type NotificationPermission =";
        let idx = src
            .find(marker)
            .expect("notifications.ts must declare `export type NotificationPermission`");
        let union = src[idx + marker.len()..].split(';').next().unwrap_or("");
        let mut ts: Vec<String> = union
            .split('|')
            .map(|s| s.trim().trim_matches('\'').to_string())
            .filter(|s| !s.is_empty())
            .collect();
        ts.sort();
        assert_eq!(rust, ts);
    }

    #[test]
    fn notification_settings_and_prefs_match_their_ts_interfaces() {
        let src = include_str!("../../src/src/app/models/notifications.ts");
        let settings = NotificationSettings {
            prefs: prefs(true, true, true, true),
            permission: NotificationPermission::Granted,
        };
        assert_eq!(
            crate::ts_mirror::rust_fields(&settings),
            crate::ts_mirror::ts_interface_fields(src, "NotificationSettings")
        );
        assert_eq!(
            crate::ts_mirror::rust_fields(&settings.prefs),
            crate::ts_mirror::ts_interface_fields(src, "NotificationPrefs")
        );
        assert_eq!(
            crate::ts_mirror::rust_fields(&NotificationTarget {
                project: "p".into(),
                tab_id: "t".into(),
            }),
            crate::ts_mirror::ts_interface_fields(src, "NotificationTarget")
        );
        assert!(
            src.contains(&format!("'{ACTIVATED_EVENT}'")),
            "notifications.ts must name the {ACTIVATED_EVENT} event"
        );
    }
}
