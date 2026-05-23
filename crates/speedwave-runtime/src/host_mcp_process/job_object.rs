//! Windows Job Object kill-on-close: child dies with parent.
//!
//! Every host MCP worker (`mcp-os`, `host_exec`, `oauth`) is attached
//! to a Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
//! and `JOB_OBJECT_LIMIT_BREAKAWAY_OK`. When the parent process
//! (`Speedwave.exe`) exits — gracefully or via crash / SIGKILL / Task
//! Manager — the kernel closes the Job handle and the child node is
//! terminated automatically. This prevents the orphan `node.exe` that
//! would otherwise block the next installer from overwriting
//! `nodejs\node.exe`.
//!
//! Known limitation — TOCTOU between `Command::spawn` and
//! `AssignProcessToJobObject`: the child runs for a brief window
//! (microseconds, but unbounded under heavy load) before it is
//! placed in the job. Grandchildren spawned in that window inherit
//! no job and survive a parent crash. The atomic fix
//! (`PROC_THREAD_ATTRIBUTE_JOB_LIST` in `STARTUPINFOEX`, or
//! `CREATE_SUSPENDED` + `ResumeThread`) requires bypassing
//! `std::process::Command` and calling `CreateProcessW` manually —
//! the host MCP workers do not spawn grandchildren during their
//! synchronous startup phase, so the residual risk is small. The
//! NSIS PRE-INSTALL sweep is the backup for any orphan that does
//! slip through.
//!
//! On non-Windows targets every function is a no-op stub so the crate
//! still compiles on macOS/Linux dev hosts and CI.

#[cfg(target_os = "windows")]
// FFI into Win32 Job Object APIs requires `unsafe` for every syscall
// and for the `Send` marker on the raw HANDLE wrapper. The unsafety
// is intrinsic to the boundary (windows-sys exposes raw C signatures),
// not a workaround for a lint — we still satisfy
// `unsafe_code = "deny"` everywhere else in this crate. All unsafe
// blocks below carry SAFETY comments documenting the invariants.
#[allow(unsafe_code)]
mod imp {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Owns a Job Object HANDLE. Dropping the handle closes the job,
    /// which (with `KILL_ON_JOB_CLOSE`) terminates every process in it.
    pub struct JobHandle(HANDLE);

    // SAFETY: `JobHandle` wraps a single Windows kernel HANDLE that is
    // (a) created in `attach_to_kill_on_close_job` and never aliased,
    // (b) closed exactly once in `Drop::drop`. No outside code holds
    // or observes the inner HANDLE — the field is private and there
    // are no accessor methods. Concurrent access on the SAME handle
    // cannot occur because the value moves through `Option<JobHandle>`
    // owned by a single `HostMcpProcess`. Send is required because
    // `HostMcpProcess` is moved between watchdog / cleanup threads.
    unsafe impl Send for JobHandle {}

    impl Drop for JobHandle {
        fn drop(&mut self) {
            // SAFETY: handle is owned by this struct; we created it via
            // `CreateJobObjectW` and have not closed it before.
            let ok = unsafe { CloseHandle(self.0) };
            if ok == 0 {
                // Surface a leak signal at debug level — most CloseHandle
                // failures indicate either an already-closed handle (a
                // bug we want to know about) or kernel quota pressure.
                log::debug!(
                    "Job Object: CloseHandle failed ({}); possible handle leak",
                    std::io::Error::last_os_error()
                );
            }
        }
    }

    // Compile-time guarantee that the struct fits in a u32 length
    // argument to `SetInformationJobObject`. If this ever fails the
    // call below would silently truncate via `try_from`.
    const _: () =
        assert!(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() <= u32::MAX as usize);

    pub fn attach_to_kill_on_close_job(child: &std::process::Child) -> Option<JobHandle> {
        // SAFETY: CreateJobObjectW with NULL attributes / NULL name is
        // a documented call that returns a valid handle or NULL on
        // failure. We check for NULL before using it.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            log::warn!(
                "Job Object: CreateJobObjectW failed ({}); child will not be auto-killed on parent exit",
                std::io::Error::last_os_error()
            );
            return None;
        }
        // From here on the handle is owned by `JobHandle` — every
        // early return drops it and CloseHandle runs.
        let handle = JobHandle(job);

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        // KILL_ON_JOB_CLOSE: child dies when the last job handle closes.
        // BREAKAWAY_OK: descendants that legitimately need to escape
        // the job (UAC elevation prompts, MSI subprocesses, detached
        // `cmd /c start /b` style launches) can do so by passing
        // CREATE_BREAKAWAY_FROM_JOB. Without this flag the kernel
        // returns ERROR_ACCESS_DENIED to any such spawn — `host_exec`
        // recipes that shell out would fail opaquely.
        //
        // Invariant when adding new flags: any LIMIT flag that pairs
        // with a numeric field MUST set that field to non-zero in
        // the same diff. Otherwise the kernel applies the zeroed
        // value as a hard limit and the child is killed on first
        // allocation / CPU tick (mem::zeroed initialises all fields
        // to 0). See `debug_assert` below.
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        debug_assert_limit_flags_have_required_fields(&info);

        // SAFETY: `info` is a valid stack value of the correct type;
        // `size_of` matches what `SetInformationJobObject` expects.
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

        // Use the existing process handle from std — avoids OpenProcess
        // (no extra handle to close, no DuplicateHandle dance).
        let child_handle = child.as_raw_handle() as HANDLE;
        // SAFETY: `child_handle` is the live process handle owned by
        // `std::process::Child`; `job` was just created above.
        let ok = unsafe { AssignProcessToJobObject(job, child_handle) };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            // ERROR_ACCESS_DENIED here usually means Speedwave.exe is
            // already inside a non-breakaway parent job (debugger,
            // Windows Sandbox, MSIX container, PCA compatibility
            // job). Surface as ERROR so the user sees a single clear
            // diagnostic instead of debugging a downstream symptom.
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

    /// Validates that any limit flag set in `info.BasicLimitInformation
    /// .LimitFlags` whose semantics depend on a paired numeric field
    /// (e.g. `JOB_OBJECT_LIMIT_PROCESS_MEMORY` requires
    /// `ProcessMemoryLimit > 0`) is matched by a non-zero value.
    /// Debug-only: in release builds the kernel will simply enforce a
    /// zero limit, killing the worker on first allocation — we want
    /// future contributors to catch this in tests, not in prod.
    fn debug_assert_limit_flags_have_required_fields(info: &JOBOBJECT_EXTENDED_LIMIT_INFORMATION) {
        use windows_sys::Win32::System::JobObjects::{
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_JOB_MEMORY,
            JOB_OBJECT_LIMIT_JOB_TIME, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
            JOB_OBJECT_LIMIT_PROCESS_TIME,
        };
        let flags = info.BasicLimitInformation.LimitFlags;
        debug_assert!(
            flags & JOB_OBJECT_LIMIT_PROCESS_MEMORY == 0 || info.ProcessMemoryLimit != 0,
            "JOB_OBJECT_LIMIT_PROCESS_MEMORY set but ProcessMemoryLimit == 0 — worker would be killed on first allocation"
        );
        debug_assert!(
            flags & JOB_OBJECT_LIMIT_JOB_MEMORY == 0 || info.JobMemoryLimit != 0,
            "JOB_OBJECT_LIMIT_JOB_MEMORY set but JobMemoryLimit == 0"
        );
        debug_assert!(
            flags & JOB_OBJECT_LIMIT_ACTIVE_PROCESS == 0
                || info.BasicLimitInformation.ActiveProcessLimit != 0,
            "JOB_OBJECT_LIMIT_ACTIVE_PROCESS set but ActiveProcessLimit == 0"
        );
        debug_assert!(
            flags & JOB_OBJECT_LIMIT_PROCESS_TIME == 0
                || info.BasicLimitInformation.PerProcessUserTimeLimit != 0,
            "JOB_OBJECT_LIMIT_PROCESS_TIME set but PerProcessUserTimeLimit == 0"
        );
        debug_assert!(
            flags & JOB_OBJECT_LIMIT_JOB_TIME == 0
                || info.BasicLimitInformation.PerJobUserTimeLimit != 0,
            "JOB_OBJECT_LIMIT_JOB_TIME set but PerJobUserTimeLimit == 0"
        );
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use std::cell::Cell;
    use std::marker::PhantomData;

    // `PhantomData<Cell<()>>` derives auto-`Send` (Cell is Send) but
    // auto-`!Sync` (Cell is !Sync), mirroring the Windows variant
    // (which is Send via manual impl but !Sync because of the raw
    // HANDLE). Without this asymmetry-mirror, the non-Windows stub
    // would be auto-Send + Sync and code that compiles on macOS /
    // Linux dev hosts could fail on Windows CI for !Sync reasons —
    // exactly the wrong direction for cross-platform safety. No
    // `unsafe impl` needed: PhantomData carries the auto-trait
    // restrictions for us, which is what the workspace
    // `unsafe_code = "deny"` lint demands.
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
        // Use `/bin/sh -c true` instead of `true` directly: more
        // robust against minimal containers / sandboxed PATH where
        // /usr/bin/true may not resolve.
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        assert!(attach_to_kill_on_close_job(&child).is_none());
        // Reap to avoid zombies.
        let mut c = child;
        let _ = c.wait();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn attach_to_live_child_kills_on_handle_drop() {
        use std::os::windows::process::ExitStatusExt;

        // `timeout /t 30 /nobreak` runs 30 s and ignores Ctrl+C — it
        // will not exit naturally during the test window, so an early
        // exit can only be caused by the Job Object kill. `ping` was
        // previously used but could legitimately exit early on a
        // flaky network stack and produce a false-positive pass.
        let mut child = std::process::Command::new("timeout")
            .args(["/t", "30", "/nobreak"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("timeout.exe must be available on Windows test hosts");

        let job = attach_to_kill_on_close_job(&child).expect("attach must succeed for live child");
        drop(job);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let exit = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Ok(None) => {
                    let _ = child.kill();
                    panic!("child still alive 2 s after dropping Job handle — kill-on-close did not fire");
                }
                Err(e) => panic!("try_wait failed: {e}"),
            }
        };

        // Job-terminated processes get a non-zero exit code. A clean
        // exit (code == 0) would mean the child exited naturally
        // before drop(job) — which shouldn't happen with
        // `timeout /t 30`. Asserting non-zero distinguishes
        // "killed by job" from "exited for unrelated reason".
        let code = exit.code().or_else(|| exit.signal());
        assert!(
            code != Some(0),
            "expected non-zero exit (job termination); got {code:?}"
        );
    }
}
