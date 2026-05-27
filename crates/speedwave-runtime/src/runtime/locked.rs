//! Per-project compose lock wrapper around `ContainerRuntime`. SSOT for "any
//! VM-side compose.yml read or write is serialised per project". Reentrancy via
//! `HELD_LOCKS` thread-local lets `transaction()` nest inner compose ops.

use super::ContainerRuntime;
use std::cell::RefCell;
use std::collections::HashSet;

thread_local! {
    static HELD_LOCKS: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

#[cfg(test)]
pub(super) fn held_locks_snapshot() -> HashSet<String> {
    HELD_LOCKS.with(|s| s.borrow().clone())
}

#[cfg(any(test, feature = "test-support"))]
pub(super) static LOCK_ACQUISITIONS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// RAII: inserts the project into `HELD_LOCKS` on construction and removes it
/// on drop (even on panic). Insertion is atomic with guard creation — there
/// is no window where the thread-local marker exists without a live drop guard.
struct HeldGuard {
    project: String,
}

impl HeldGuard {
    fn acquire(project: &str) -> Self {
        HELD_LOCKS.with(|s| {
            s.borrow_mut().insert(project.to_string());
        });
        Self {
            project: project.to_string(),
        }
    }
}

impl Drop for HeldGuard {
    fn drop(&mut self) {
        HELD_LOCKS.with(|s| {
            s.borrow_mut().remove(&self.project);
        });
    }
}

/// Acquires the per-project compose lock if not already held by this thread,
/// then runs `f`. Reentrant: nested calls on the same project skip re-acquire.
pub(crate) fn with_acquired<F, T>(project: &str, f: F) -> anyhow::Result<T>
where
    F: FnOnce() -> anyhow::Result<T>,
{
    let already_held = HELD_LOCKS.with(|s| s.borrow().contains(project));
    if already_held {
        return f();
    }
    super::compose_locks::with_project_compose_lock(project, || {
        #[cfg(any(test, feature = "test-support"))]
        LOCK_ACQUISITIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _guard = HeldGuard::acquire(project);
        f()
    })
}

/// Public wrapper for `ContainerRuntime`. Compose mutations lock via
/// `with_acquired`; read-only queries (`ps`, `logs`) and non-compose ops
/// are passthrough. See ADR-066.
pub struct LockedRuntime {
    inner: Box<dyn ContainerRuntime>,
}

impl LockedRuntime {
    pub(crate) fn new(inner: Box<dyn ContainerRuntime>) -> Self {
        Self { inner }
    }

    // ----- LOCKED: every call goes through with_acquired -----

    pub fn compose_up(&self, project: &str) -> anyhow::Result<()> {
        with_acquired(project, || self.inner.compose_up(project))
    }

    pub fn compose_down(&self, project: &str) -> anyhow::Result<()> {
        with_acquired(project, || self.inner.compose_down(project))
    }

    pub fn compose_up_recreate(&self, project: &str) -> anyhow::Result<()> {
        with_acquired(project, || self.inner.compose_up_recreate(project))
    }

    pub fn compose_validate(&self, project: &str) -> anyhow::Result<()> {
        with_acquired(project, || self.inner.compose_validate(project))
    }

    // ----- PASSTHROUGH: no lock, do not touch compose.yml -----

    pub fn compose_ps(&self, project: &str) -> anyhow::Result<Vec<serde_json::Value>> {
        self.inner.compose_ps(project)
    }

    pub fn compose_logs(&self, project: &str, tail: u32) -> anyhow::Result<String> {
        self.inner.compose_logs(project, tail)
    }

    pub fn is_available(&self) -> bool {
        self.inner.is_available()
    }

    pub fn ensure_ready(&self) -> anyhow::Result<()> {
        self.inner.ensure_ready()
    }

    pub fn container_exec(&self, container: &str, cmd: &[&str]) -> std::process::Command {
        self.inner.container_exec(container, cmd)
    }

    pub fn container_exec_piped(
        &self,
        container: &str,
        cmd: &[&str],
    ) -> anyhow::Result<std::process::Command> {
        self.inner.container_exec_piped(container, cmd)
    }

    pub fn build_image(
        &self,
        tag: &str,
        context_dir: &str,
        containerfile: &str,
        build_args: &[(&str, &str)],
    ) -> anyhow::Result<()> {
        self.inner
            .build_image(tag, context_dir, containerfile, build_args)
    }

    pub fn prepare_build_context(
        &self,
        build_root: &std::path::Path,
    ) -> anyhow::Result<std::path::PathBuf> {
        self.inner.prepare_build_context(build_root)
    }

    pub fn container_logs(&self, container: &str, tail: u32) -> anyhow::Result<String> {
        self.inner.container_logs(container, tail)
    }

    pub fn image_exists(&self, tag: &str) -> anyhow::Result<bool> {
        self.inner.image_exists(tag)
    }

    pub fn system_prune(&self) -> anyhow::Result<()> {
        self.inner.system_prune()
    }

    pub fn remove_images(&self, tags: &[String], force: bool) -> anyhow::Result<()> {
        self.inner.remove_images(tags, force)
    }

    pub fn prune_buildkit_cache(&self) -> anyhow::Result<()> {
        self.inner.prune_buildkit_cache()
    }

    pub fn prune_unused_images(&self) -> anyhow::Result<()> {
        self.inner.prune_unused_images()
    }

    pub fn restart_container_engine(&self) -> anyhow::Result<()> {
        self.inner.restart_container_engine()
    }

    pub fn stop_vm(&self) -> anyhow::Result<()> {
        self.inner.stop_vm()
    }

    pub fn reset_vm(&self) -> anyhow::Result<()> {
        self.inner.reset_vm()
    }

    pub fn vm_exec(
        &self,
        cmd: &str,
        args: &[&str],
        stdin: &[u8],
        timeout: std::time::Duration,
    ) -> anyhow::Result<super::VmExecOutput> {
        self.inner.vm_exec(cmd, args, stdin, timeout)
    }

    /// Runs a multi-step compose transaction under the per-project lock.
    /// Inner compose ops on the same project nest reentrantly without
    /// re-acquiring. Use for snapshot+build+down+save+validate+up sequences.
    pub fn transaction<F, T>(&self, project: &str, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&LockedRuntime) -> anyhow::Result<T>,
    {
        with_acquired(project, || f(self))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::runtime::mock_runtime::MockRuntimeBuilder;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn reentrant_call_on_same_project_does_not_redacquire() {
        let depth_seen = Arc::new(AtomicUsize::new(0));
        let d1 = Arc::clone(&depth_seen);
        with_acquired("alpha", || {
            assert!(held_locks_snapshot().contains("alpha"));
            with_acquired("alpha", || {
                d1.store(held_locks_snapshot().len(), Ordering::SeqCst);
                Ok(())
            })?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            depth_seen.load(Ordering::SeqCst),
            1,
            "nested call must not push a duplicate entry"
        );
        assert!(
            !held_locks_snapshot().contains("alpha"),
            "outer release must clean up"
        );
    }

    #[test]
    fn separate_projects_have_independent_held_state() {
        with_acquired("p1", || {
            assert!(held_locks_snapshot().contains("p1"));
            with_acquired("p2", || {
                let snap = held_locks_snapshot();
                assert!(snap.contains("p1"));
                assert!(snap.contains("p2"));
                Ok(())
            })?;
            assert!(!held_locks_snapshot().contains("p2"));
            assert!(held_locks_snapshot().contains("p1"));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn closure_error_releases_held_marker() {
        let _ = with_acquired("err_proj", || -> anyhow::Result<()> {
            anyhow::bail!("forced");
        });
        assert!(
            !held_locks_snapshot().contains("err_proj"),
            "Err path must release held marker"
        );
    }

    #[test]
    fn panic_inside_closure_releases_held_marker() {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = with_acquired("panic_proj", || -> anyhow::Result<()> {
                panic!("forced panic");
            });
        }));
        assert!(
            !held_locks_snapshot().contains("panic_proj"),
            "panic path must release held marker"
        );
    }

    #[test]
    fn closure_return_value_is_propagated() {
        let v: i32 = with_acquired("val_proj", || Ok::<i32, anyhow::Error>(42)).unwrap();
        assert_eq!(v, 42);
    }

    #[test]
    fn transaction_runs_closure_and_returns_value() {
        let (rt, _) = MockRuntimeBuilder::new().build();
        let v = rt
            .transaction("p", |_| Ok::<i32, anyhow::Error>(7))
            .unwrap();
        assert_eq!(v, 7);
    }

    #[test]
    fn transaction_inner_compose_ops_do_not_redacquire_lock() {
        let (rt, _) = MockRuntimeBuilder::new().build();
        let snap = Arc::new(std::sync::Mutex::new(HashSet::new()));
        let s = Arc::clone(&snap);
        rt.transaction("nested", |inner| {
            inner.compose_validate("nested")?;
            inner.compose_down("nested")?;
            inner.compose_up_recreate("nested")?;
            *s.lock().unwrap() = held_locks_snapshot();
            Ok(())
        })
        .unwrap();
        let snap = snap.lock().unwrap();
        assert!(snap.contains("nested"));
        assert_eq!(snap.len(), 1, "no extra projects should be held");
    }

    #[test]
    fn transaction_error_propagates_and_releases_lock() {
        let (rt, _) = MockRuntimeBuilder::new().build();
        let err = rt
            .transaction("err", |_| -> anyhow::Result<()> { anyhow::bail!("boom") })
            .unwrap_err();
        assert!(err.to_string().contains("boom"));
        assert!(!held_locks_snapshot().contains("err"));
    }

    #[test]
    fn same_project_transactions_serialise_across_threads() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::thread;
        use std::time::{Duration, Instant};

        let in_flight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut handles = vec![];
        for _ in 0..2 {
            let in_flight = Arc::clone(&in_flight);
            let peak = Arc::clone(&peak);
            handles.push(thread::spawn(move || {
                let (rt, _) = MockRuntimeBuilder::new().build();
                rt.transaction("ser", |_| {
                    let cur = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(cur, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(80));
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
                .unwrap();
            }));
        }
        let start = Instant::now();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1, "must serialise per project");
        assert!(
            start.elapsed() >= Duration::from_millis(150),
            "serialised total must be ≥ sum of single durations"
        );
    }

    #[test]
    fn different_project_transactions_run_in_parallel() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Barrier;
        use std::thread;

        let in_flight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(2));
        let mut handles = vec![];
        for proj in ["p_a", "p_b"] {
            let in_flight = Arc::clone(&in_flight);
            let peak = Arc::clone(&peak);
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                let (rt, _) = MockRuntimeBuilder::new().build();
                rt.transaction(proj, |_| {
                    let cur = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(cur, Ordering::SeqCst);
                    barrier.wait();
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
                .unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(
            peak.load(Ordering::SeqCst),
            2,
            "different projects must overlap"
        );
    }

    #[test]
    fn transaction_inner_call_on_different_project_acquires_separate_lock() {
        let (rt, _) = MockRuntimeBuilder::new().build();
        let snap = Arc::new(std::sync::Mutex::new(HashSet::new()));
        let s = Arc::clone(&snap);
        rt.transaction("outer", |inner| {
            inner.compose_validate("inner_diff_project")?;
            *s.lock().unwrap() = held_locks_snapshot();
            Ok(())
        })
        .unwrap();
        let final_snap = snap.lock().unwrap();
        assert!(final_snap.contains("outer"));
        assert!(
            !final_snap.contains("inner_diff_project"),
            "inner lock must be released before snapshot is taken (snapshot runs after inner returns)"
        );
    }

    #[test]
    fn builder_construction_yields_locked_wrapper() {
        // Smoke-test that the test-support builder produces a working
        // `LockedRuntime`. All transaction tests above rely on this; this
        // test pins the basic constructor contract on its own.
        let (rt, _) = MockRuntimeBuilder::new().build();
        assert!(rt.is_available());
    }
}
