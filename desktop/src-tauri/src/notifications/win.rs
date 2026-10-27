#![expect(
    unsafe_code,
    reason = "Shell FFI boundary; every block has a SAFETY comment"
)]

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use windows::core::HSTRING;
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
use windows_sys::Win32::Foundation::S_OK;
use windows_sys::Win32::UI::Shell::SHQueryUserNotificationState;

use super::{
    classify_toast_setting, classify_toast_setting_error, on_activated, push_bounded, toast_xml,
    NotificationPermission,
};

const NOTIFICATIONS_SETTINGS_URI: &str = "ms-settings:notifications";

pub(super) fn permission(app_id: &str) -> NotificationPermission {
    if tauri::is_dev() {
        return NotificationPermission::Unavailable;
    }
    let setting = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
        .and_then(|notifier| notifier.Setting());
    match setting {
        Ok(setting) => classify_toast_setting(setting.0, user_notification_state()),
        Err(e) => {
            let permission = classify_toast_setting_error(e.code().0, user_notification_state());
            if permission == NotificationPermission::Unavailable {
                log::warn!("toast notification setting unreadable: {e}");
            } else {
                log::info!(
                    "toast notification setting not registered yet; the first toast registers it"
                );
            }
            permission
        }
    }
}

pub(super) fn resolve_permission(app_id: &str) -> NotificationPermission {
    permission(app_id)
}

pub(super) fn show(app_id: &str, id: &str, title: &str, body: &str) -> Result<(), String> {
    let doc = XmlDocument::new().map_err(|e| e.to_string())?;
    doc.LoadXml(&HSTRING::from(toast_xml(title, body)))
        .map_err(|e| e.to_string())?;
    let toast = ToastNotification::CreateToastNotification(&doc).map_err(|e| e.to_string())?;
    let id = id.to_string();
    toast
        .Activated(&TypedEventHandler::new(move |_, _| {
            on_activated(&id);
            Ok(())
        }))
        .map_err(|e| e.to_string())?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
        .and_then(|notifier| notifier.Show(&toast))
        .map_err(|e| e.to_string())?;
    push_bounded(
        &mut live_toasts().lock().unwrap_or_else(|e| e.into_inner()),
        toast,
    );
    Ok(())
}

pub(super) fn open_system_settings(_app_id: &str) -> Result<(), String> {
    speedwave_runtime::binary::system_command("explorer.exe")
        .arg(NOTIFICATIONS_SETTINGS_URI)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open Windows Settings: {e}"))
}

fn user_notification_state() -> Option<i32> {
    let mut state = 0;
    // SAFETY: `state` is a valid out-pointer for the duration of the call.
    let hr = unsafe { SHQueryUserNotificationState(&mut state) };
    (hr == S_OK).then_some(state)
}

fn live_toasts() -> &'static Mutex<VecDeque<ToastNotification>> {
    static LIVE: OnceLock<Mutex<VecDeque<ToastNotification>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(VecDeque::new()))
}
