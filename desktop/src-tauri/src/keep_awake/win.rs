#![expect(
    unsafe_code,
    reason = "Power request FFI boundary; every block has a SAFETY comment"
)]

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Power::{
    PowerClearRequest, PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest,
};
use windows_sys::Win32::System::SystemServices::POWER_REQUEST_CONTEXT_VERSION;
use windows_sys::Win32::System::Threading::{
    POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
};

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
