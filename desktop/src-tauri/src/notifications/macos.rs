#![expect(
    unsafe_code,
    reason = "UserNotifications FFI boundary; every block has a SAFETY comment"
)]

use std::ptr::NonNull;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread};
use objc2_foundation::{NSBundle, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};

use super::{classify_authorization_status, on_activated, NotificationPermission};

const SETTINGS_TIMEOUT: Duration = Duration::from_secs(5);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(600);
const NOTIFICATIONS_PANE: &str =
    "x-apple.systempreferences:com.apple.Notifications-Settings.extension";

static PROMPT_TURN: Mutex<()> = Mutex::new(());

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class has no Drop impl.
    #[unsafe(super(NSObject))]
    #[name = "SpeedwaveNotificationDelegate"]
    struct NotificationDelegate;

    // SAFETY: NSObjectProtocol has no requirements beyond the NSObject superclass.
    unsafe impl NSObjectProtocol for NotificationDelegate {}

    // SAFETY: both methods match the protocol's selectors and signatures, and call their completion handlers.
    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion_handler
                .call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &DynBlock<dyn Fn()>,
        ) {
            on_activated(&response.notification().request().identifier().to_string());
            completion_handler.call(());
        }
    }
);

impl NotificationDelegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        // SAFETY: NSObject's `init` is the designated initializer of the superclass.
        unsafe { msg_send![super(this), init] }
    }
}

pub(super) fn install_click_delegate() {
    let Some(center) = center() else {
        return;
    };
    let delegate = NotificationDelegate::new();
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    std::mem::forget(delegate);
}

pub(super) fn permission(_app_id: &str) -> NotificationPermission {
    let Some(center) = center() else {
        return NotificationPermission::Unavailable;
    };
    let (tx, rx) = mpsc::channel::<isize>();
    let tx = Mutex::new(Some(tx));
    let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        // SAFETY: UserNotifications passes a valid settings object for the duration of the call.
        let status = unsafe { settings.as_ref() }.authorizationStatus().0;
        if let Some(sender) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = sender.send(status);
        }
    });
    center.getNotificationSettingsWithCompletionHandler(&handler);
    match rx.recv_timeout(SETTINGS_TIMEOUT) {
        Ok(raw) => classify_authorization_status(raw),
        Err(_) => {
            log::warn!("notification settings did not answer within {SETTINGS_TIMEOUT:?}");
            NotificationPermission::Unavailable
        }
    }
}

pub(super) fn resolve_permission(app_id: &str) -> NotificationPermission {
    let _turn = PROMPT_TURN.lock().unwrap_or_else(|e| e.into_inner());
    match permission(app_id) {
        NotificationPermission::Undetermined => request_permission(app_id),
        other => other,
    }
}

pub(super) fn show(_app_id: &str, id: &str, title: &str, body: &str) -> Result<(), String> {
    let center = center().ok_or("notifications need the installed Speedwave.app")?;
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(id),
        &content,
        None,
    );
    let handler = RcBlock::new(|error: *mut NSError| {
        if !error.is_null() {
            // SAFETY: a non-null error passed to the completion handler is a valid NSError.
            let description = unsafe { &*error }.localizedDescription();
            log::warn!("notification delivery failed: {description}");
        }
    });
    center.addNotificationRequest_withCompletionHandler(&request, Some(&handler));
    Ok(())
}

pub(super) fn open_system_settings(_app_id: &str) -> Result<(), String> {
    speedwave_runtime::binary::system_command("open")
        .arg(NOTIFICATIONS_PANE)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open System Settings: {e}"))
}

fn request_permission(app_id: &str) -> NotificationPermission {
    let Some(center) = center() else {
        return NotificationPermission::Unavailable;
    };
    let (tx, rx) = mpsc::channel::<()>();
    let tx = Mutex::new(Some(tx));
    let handler = RcBlock::new(move |_granted: Bool, error: *mut NSError| {
        if !error.is_null() {
            // SAFETY: a non-null error passed to the completion handler is a valid NSError.
            let description = unsafe { &*error }.localizedDescription();
            log::warn!("notification authorization request failed: {description}");
        }
        if let Some(sender) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = sender.send(());
        }
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &handler,
    );
    if rx.recv_timeout(PROMPT_TIMEOUT).is_err() {
        log::warn!("notification authorization prompt unanswered after {PROMPT_TIMEOUT:?}");
    }
    permission(app_id)
}

fn center() -> Option<Retained<UNUserNotificationCenter>> {
    let bundle_path = NSBundle::mainBundle().bundlePath().to_string();
    if !bundle_path.ends_with(".app") {
        return None;
    }
    Some(UNUserNotificationCenter::currentNotificationCenter())
}
