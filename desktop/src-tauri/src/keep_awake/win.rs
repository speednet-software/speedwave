#![expect(
    unsafe_code,
    reason = "Power request FFI boundary; every block has a SAFETY comment"
)]

use std::ffi::c_void;
use std::mem::offset_of;

use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Power::{
    PowerClearRequest, PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest,
    PowerSettingRegisterNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, POWERBROADCAST_SETTING,
};
use windows_sys::Win32::System::SystemServices::{
    GUID_SESSION_DISPLAY_STATUS, POWER_REQUEST_CONTEXT_VERSION,
};
use windows_sys::Win32::System::Threading::{
    POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{DEVICE_NOTIFY_CALLBACK, PBT_POWERSETTINGCHANGE};

const POWER_MONITOR_ON: u32 = 1;

/// A `PowerRequestSystemRequired` power request with its reason, cleared and closed on drop.
pub(super) struct Assertion {
    request: HANDLE,
    _reason: Vec<u16>,
}

// SAFETY: a power request is a kernel object of the process, not of the thread that created it,
// so clearing and closing its handle from another thread is sound.
unsafe impl Send for Assertion {}

impl Assertion {
    pub(super) fn acquire() -> Result<Self, String> {
        let mut reason: Vec<u16> = super::ASSERTION_NAME
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let context = REASON_CONTEXT {
            Version: POWER_REQUEST_CONTEXT_VERSION,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 {
                SimpleReasonString: reason.as_mut_ptr(),
            },
        };
        // SAFETY: `context` is a valid REASON_CONTEXT whose reason is a NUL-terminated UTF-16
        // buffer kept alive with the request.
        let request = unsafe { PowerCreateRequest(&context) };
        if request.is_null() || request == INVALID_HANDLE_VALUE {
            return Err(format!(
                "PowerCreateRequest failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: `request` is the valid power request handle created above.
        if unsafe { PowerSetRequest(request, PowerRequestSystemRequired) } == 0 {
            let error = std::io::Error::last_os_error();
            // SAFETY: `request` is valid and closed exactly once, here.
            unsafe { CloseHandle(request) };
            return Err(format!("PowerSetRequest failed: {error}"));
        }
        Ok(Self {
            request,
            _reason: reason,
        })
    }
}

impl Drop for Assertion {
    fn drop(&mut self) {
        // SAFETY: `self.request` is the handle `acquire` created and set; nothing else clears it.
        if unsafe { PowerClearRequest(self.request, PowerRequestSystemRequired) } == 0 {
            log::warn!(
                "PowerClearRequest failed: {}",
                std::io::Error::last_os_error()
            );
        }
        // SAFETY: `self.request` is valid and closed exactly once, here.
        unsafe { CloseHandle(self.request) };
    }
}

/// Calls `super::renew_after_wake` every time the session's display turns on, for the process lifetime.
pub(super) fn watch_display() -> Result<(), String> {
    let subscription = Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
        Callback: Some(on_power_setting),
        Context: std::ptr::null_mut(),
    }));
    let mut registration: *mut c_void = std::ptr::null_mut();
    // SAFETY: the subscription is leaked, so it outlives the registration, which is never undone,
    // and `registration` is a valid out pointer.
    let result = unsafe {
        PowerSettingRegisterNotification(
            &GUID_SESSION_DISPLAY_STATUS,
            DEVICE_NOTIFY_CALLBACK,
            std::ptr::from_mut(subscription).cast(),
            &mut registration,
        )
    };
    if result == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!(
            "PowerSettingRegisterNotification failed: {}",
            std::io::Error::from_raw_os_error(result.cast_signed())
        ))
    }
}

unsafe extern "system" fn on_power_setting(
    _context: *const c_void,
    kind: u32,
    setting: *const c_void,
) -> u32 {
    // SAFETY: Windows passes the setting of this notification, read only for its own kind.
    if unsafe { announces_display_on(kind, setting) } {
        super::renew_after_wake();
    }
    ERROR_SUCCESS
}

/// # Safety
/// For `PBT_POWERSETTINGCHANGE`, `setting` is null or a `POWERBROADCAST_SETTING` with `DataLength` bytes of `Data`.
unsafe fn announces_display_on(kind: u32, setting: *const c_void) -> bool {
    if kind != PBT_POWERSETTINGCHANGE || setting.is_null() {
        return false;
    }
    let base = setting.cast::<u8>();
    // SAFETY: the caller guarantees a POWERBROADCAST_SETTING, which starts with the setting GUID
    // and its data length.
    let (guid, length) = unsafe {
        (
            std::ptr::read_unaligned(setting.cast::<GUID>()),
            std::ptr::read_unaligned(
                base.add(offset_of!(POWERBROADCAST_SETTING, DataLength))
                    .cast::<u32>(),
            ),
        )
    };
    let state = (length >= 4).then(|| {
        // SAFETY: `Data` holds `DataLength` bytes, at least the four read here.
        unsafe {
            std::ptr::read_unaligned(
                base.add(offset_of!(POWERBROADCAST_SETTING, Data))
                    .cast::<u32>(),
            )
        }
    });
    display_turned_on(&guid, state)
}

fn display_turned_on(setting: &GUID, state: Option<u32>) -> bool {
    same_guid(setting, &GUID_SESSION_DISPLAY_STATUS) && state == Some(POWER_MONITOR_ON)
}

fn same_guid(a: &GUID, b: &GUID) -> bool {
    (a.data1, a.data2, a.data3, a.data4) == (b.data1, b.data2, b.data3, b.data4)
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions may unwrap freely")]
mod tests {
    use super::*;

    #[test]
    fn only_the_session_display_turning_on_counts_as_a_wake() {
        assert!(display_turned_on(&GUID_SESSION_DISPLAY_STATUS, Some(1)));
        assert!(
            !display_turned_on(&GUID_SESSION_DISPLAY_STATUS, Some(0)),
            "off"
        );
        assert!(
            !display_turned_on(&GUID_SESSION_DISPLAY_STATUS, Some(2)),
            "dimmed"
        );
        assert!(!display_turned_on(&GUID_SESSION_DISPLAY_STATUS, None));
        let other = GUID::from_u128(0x6fe69556_704a_47a0_8f24_c28d936fda47);
        assert!(!display_turned_on(&other, Some(1)));
    }

    fn broadcast(setting: GUID, state: u32, length: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; offset_of!(POWERBROADCAST_SETTING, Data) + 4];
        // SAFETY: `bytes` holds a POWERBROADCAST_SETTING header plus four bytes of `Data`.
        unsafe {
            let base = bytes.as_mut_ptr();
            std::ptr::write_unaligned(base.cast::<GUID>(), setting);
            std::ptr::write_unaligned(
                base.add(offset_of!(POWERBROADCAST_SETTING, DataLength))
                    .cast::<u32>(),
                length,
            );
            std::ptr::write_unaligned(
                base.add(offset_of!(POWERBROADCAST_SETTING, Data))
                    .cast::<u32>(),
                state,
            );
        }
        bytes
    }

    #[test]
    fn a_broadcast_of_the_display_turning_on_is_read_as_a_wake() {
        let on = broadcast(GUID_SESSION_DISPLAY_STATUS, POWER_MONITOR_ON, 4);
        let off = broadcast(GUID_SESSION_DISPLAY_STATUS, 0, 4);
        let truncated = broadcast(GUID_SESSION_DISPLAY_STATUS, POWER_MONITOR_ON, 0);
        // SAFETY: every buffer holds a POWERBROADCAST_SETTING with four bytes of `Data`.
        unsafe {
            assert!(announces_display_on(
                PBT_POWERSETTINGCHANGE,
                on.as_ptr().cast()
            ));
            assert!(!announces_display_on(
                PBT_POWERSETTINGCHANGE,
                off.as_ptr().cast()
            ));
            assert!(!announces_display_on(
                PBT_POWERSETTINGCHANGE,
                truncated.as_ptr().cast()
            ));
            assert!(
                !announces_display_on(0, on.as_ptr().cast()),
                "another event kind"
            );
            assert!(!announces_display_on(
                PBT_POWERSETTINGCHANGE,
                std::ptr::null()
            ));
        }
    }

    #[test]
    fn windows_accepts_the_display_subscription() {
        watch_display().unwrap();
    }
}
