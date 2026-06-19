//! Windows Job Object kill-on-close: host MCP workers die with the parent.
//! No-op stubs on non-Windows. See ADR-048 ("PRE-INSTALL orphan worker
//! sweep") for the architectural rationale and TOCTOU known-limitation.

#[cfg(target_os = "windows")]
// FFI boundary — `unsafe_code` is allowed only here; each block carries SAFETY docs.
#[allow(unsafe_code)]
mod imp {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Owns a Job Object HANDLE. Dropping closes the job, terminating
    /// every process in it (KILL_ON_JOB_CLOSE).
    // `!Sync` intentional — raw HANDLE is not safe to share across threads.
    pub struct JobHandle(HANDLE);

    // SAFETY: HANDLE is owned by this struct (created once, closed in Drop),
    // never aliased, and only moved through a Mutex-guarded Option<JobHandle>.
    unsafe impl Send for JobHandle {}

    impl Drop for JobHandle {
        fn drop(&mut self) {
            // SAFETY: owned handle from CreateJobObjectW, not closed before.
            let ok = unsafe { CloseHandle(self.0) };
            if ok == 0 {
                log::warn!(
                    "Job Object: CloseHandle failed ({}); possible double-close or handle leak",
                    std::io::Error::last_os_error()
                );
            }
        }
    }

    // Guard the `as u32` cast in SetInformationJobObject below.
    const _: () =
        assert!(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() <= u32::MAX as usize);

    pub fn attach_to_kill_on_close_job(child: &std::process::Child) -> Option<JobHandle> {
        // SAFETY: documented FFI call; null return is the error signal.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            log::warn!(
                "Job Object: CreateJobObjectW failed ({}); child will not be auto-killed on parent exit",
                std::io::Error::last_os_error()
            );
            return None;
        }
        // From here on the handle is owned by `JobHandle`.
        let handle = JobHandle(job);

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        // KILL_ON_JOB_CLOSE + BREAKAWAY_OK — see ADR-048 for rationale.
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;

        // SAFETY: `info` is a valid stack value; size matches struct.
        let ok = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            log::warn!(
                "Job Object: SetInformationJobObject failed ({}); child will not be auto-killed",
                std::io::Error::last_os_error()
            );
            return None;
        }

        // Use the existing handle from std (avoids OpenProcess + DuplicateHandle dance).
        let child_handle = child.as_raw_handle() as HANDLE;
        // SAFETY: live process handle owned by std::process::Child; job just created.
        let ok = unsafe { AssignProcessToJobObject(job, child_handle) };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            // ACCESS_DENIED = nested non-breakaway parent job; see ADR-048.
            if err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
                log::error!(
                    "Job Object: AssignProcessToJobObject denied — Speedwave.exe appears to be \
                     inside a non-breakaway parent job (debugger, Windows Sandbox, MSIX, PCA). \
                     Parent-crash protection is disabled for this worker; NSIS PRE-INSTALL \
                     sweep is the only orphan defence."
                );
            } else {
                log::warn!(
                    "Job Object: AssignProcessToJobObject failed ({err}); child will not be auto-killed"
                );
            }
            return None;
        }

        Some(handle)
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use std::cell::Cell;
    use std::marker::PhantomData;

    // PhantomData<Cell<()>> mirrors Windows variant: Send but !Sync.
    pub struct JobHandle(PhantomData<Cell<()>>);

    pub fn attach_to_kill_on_close_job(_child: &std::process::Child) -> Option<JobHandle> {
        None
    }
}

pub use imp::{attach_to_kill_on_close_job, JobHandle};

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn stub_returns_none_without_panic() {
        // `/bin/sh -c "exit 0"` works under minimal/sandboxed PATH.
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        assert!(attach_to_kill_on_close_job(&child).is_none());
        let mut c = child;
        let _ = c.wait();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn attach_to_live_child_kills_on_handle_drop() {
        // PS Start-Sleep blocks 30 s ignoring stdio (timeout.exe exits early on null stdout).
        let mut child = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("powershell.exe must be available on Windows test hosts");

        let job = match attach_to_kill_on_close_job(&child) {
            Some(j) => j,
            None => {
                // Skip when inside a non-breakaway parent job (CI / MSIX / debugger).
                let _ = child.kill();
                let _ = child.wait();
                eprintln!("skipping: attach_to_kill_on_close_job returned None (likely a non-breakaway parent job)");
                return;
            }
        };
        drop(job);

        // Child must die within 2 s of dropping the job; assert "no longer running".
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Ok(None) => {
                    let _ = child.kill();
                    panic!("child still alive 2 s after dropping Job handle — kill-on-close did not fire");
                }
                Err(e) => panic!("try_wait failed: {e}"),
            }
        }
    }
}
