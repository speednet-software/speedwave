#![expect(
    unsafe_code,
    reason = "IOKit power-management FFI boundary; every block has a SAFETY comment"
)]

use objc2_core_foundation::CFString;
use objc2_io_kit::{
    kIOPMAssertionLevelOn, kIOReturnSuccess, IOPMAssertionCreateWithName, IOPMAssertionID,
    IOPMAssertionRelease,
};

const PREVENT_USER_IDLE_SYSTEM_SLEEP: &str = "PreventUserIdleSystemSleep";

/// A `PreventUserIdleSystemSleep` assertion, released on drop.
pub(super) struct Assertion(IOPMAssertionID);

impl Assertion {
    pub(super) fn acquire() -> Result<Self, String> {
        let kind = CFString::from_static_str(PREVENT_USER_IDLE_SYSTEM_SLEEP);
        let name = CFString::from_static_str(super::ASSERTION_NAME);
        let mut id: IOPMAssertionID = 0;
        // SAFETY: both strings are live CFStrings for the whole call, and `id` is a valid,
        // writable IOPMAssertionID.
        let result = unsafe {
            IOPMAssertionCreateWithName(Some(&*kind), kIOPMAssertionLevelOn, Some(&*name), &mut id)
        };
        if result == kIOReturnSuccess {
            Ok(Self(id))
        } else {
            Err(format!("IOPMAssertionCreateWithName returned {result:#x}"))
        }
    }
}

impl Drop for Assertion {
    fn drop(&mut self) {
        let result = IOPMAssertionRelease(self.0);
        if result != kIOReturnSuccess {
            log::warn!("IOPMAssertionRelease returned {result:#x}");
        }
    }
}
