//! Per-project compose lock wrapper around `ContainerRuntime`. SSOT for "any VM-side compose.yml
//! read or write is serialised per project". `HELD_LOCKS` thread-local lets `transaction()` nest.

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

type SettledProjects = std::sync::Mutex<HashSet<(std::path::PathBuf, String)>>;

/// RAII: inserts the project into `HELD_LOCKS` on construction and removes it
/// on drop (even on panic).
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

/// Public wrapper for `ContainerRuntime`. Compose mutations lock via `with_acquired`; read-only
/// queries (`ps`, `logs`) and non-compose ops are passthrough. See ADR-066.
pub struct LockedRuntime {
    inner: Box<dyn ContainerRuntime>,
    engine_teardown_started: fn() -> bool,
    #[cfg(any(test, feature = "test-support"))]
    data_dir_override: Option<std::path::PathBuf>,
}

impl LockedRuntime {
    pub(crate) fn new(
        inner: Box<dyn ContainerRuntime>,
        engine_teardown_started: fn() -> bool,
    ) -> Self {
        Self {
            inner,
            engine_teardown_started,
            #[cfg(any(test, feature = "test-support"))]
            data_dir_override: None,
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn with_data_dir_override(mut self, data_dir: Option<std::path::PathBuf>) -> Self {
        self.data_dir_override = data_dir;
        self
    }

    fn refuse_during_engine_teardown(&self) -> anyhow::Result<()> {
        if (self.engine_teardown_started)() {
            return Err(anyhow::Error::new(super::EngineTearingDown));
        }
        Ok(())
    }

    /// Starts the project's compose stack (under the per-project lock) once its egress-less
    /// networks exist isolated, recreating every container while a compose-created one remains;
    /// refused once [`super::begin_engine_teardown`] ran.
    pub fn compose_up(&self, project: &str) -> anyhow::Result<()> {
        with_acquired(project, || {
            self.start_isolated(project, || {
                let result = self.inner.compose_up(project);
                crate::slash::invalidate_cache(project);
                result
            })
        })
    }

    /// Stops the project's compose stack (under the per-project lock).
    pub fn compose_down(&self, project: &str) -> anyhow::Result<()> {
        with_acquired(project, || self.inner.compose_down(project))
    }

    /// Recreates the project's compose stack (under the per-project lock) once its egress-less
    /// networks exist isolated; refused once [`super::begin_engine_teardown`] ran.
    pub fn compose_up_recreate(&self, project: &str) -> anyhow::Result<()> {
        with_acquired(project, || {
            self.start_isolated(project, || {
                let result = self.inner.compose_up_recreate(project);
                crate::slash::invalidate_cache(project);
                result
            })
        })
    }

    /// Recreates one built-in service alone (ADR-073 proxy hot-reload; project lock, no teardown);
    /// a pre-isolation network left fails it with [`super::NetworkMigrationPending`], stack as is.
    pub fn compose_up_service(&self, project: &str, service: &str) -> anyhow::Result<()> {
        with_acquired(project, || {
            self.refuse_during_engine_teardown()?;
            let legacy = self.isolate_egress_less_networks(project)?;
            if !legacy.is_empty() {
                log::warn!(
                    "project {project} still has the compose-created networks {legacy:?}; not \
                     starting {service} alone, the next full start migrates them"
                );
                return Err(anyhow::Error::new(super::NetworkMigrationPending));
            }
            let result = self.inner.compose_up_service(project, service);
            if service == crate::consts::CLAUDE_COMPOSE_SERVICE {
                crate::slash::invalidate_cache(project);
            }
            result
        })
    }

    /// Removes every egress-less network the project can have, and the compose-created network of
    /// an earlier release (project lock); a missing network is skipped, any other failure returned.
    pub fn remove_egress_less_networks(&self, project: &str) -> anyhow::Result<()> {
        with_acquired(project, || {
            for name in crate::compose::egress_less_network_names(project) {
                self.inner.remove_network(&name)?;
                self.inner
                    .remove_network(&crate::compose::legacy_compose_network_name(project, &name))?;
            }
            Ok(())
        })
    }

    /// Validates the project's compose file (under the per-project lock).
    pub fn compose_validate(&self, project: &str) -> anyhow::Result<()> {
        with_acquired(project, || self.inner.compose_validate(project))
    }

    /// Lists the project's running containers.
    pub fn compose_ps(&self, project: &str) -> anyhow::Result<Vec<serde_json::Value>> {
        self.inner.compose_ps(project)
    }

    /// Fetches the last `tail` lines of the project's compose logs.
    pub fn compose_logs(&self, project: &str, tail: u32) -> anyhow::Result<String> {
        self.inner.compose_logs(project, tail)
    }

    /// `true` if the container engine is running and reachable.
    pub fn is_available(&self) -> bool {
        self.inner.is_available()
    }

    /// `true` if the container engine is installed.
    pub fn is_installed(&self) -> bool {
        self.inner.is_installed()
    }

    /// Ensures the VM/engine is provisioned and started.
    pub fn ensure_ready(&self) -> anyhow::Result<()> {
        self.inner.ensure_ready()
    }

    /// Builds an exec command for a running container.
    pub fn container_exec(&self, container: &str, cmd: &[&str]) -> std::process::Command {
        self.inner.container_exec(container, cmd)
    }

    /// Builds an exec command with piped stdio for a running container.
    pub fn container_exec_piped(
        &self,
        container: &str,
        cmd: &[&str],
    ) -> anyhow::Result<std::process::Command> {
        self.inner.container_exec_piped(container, cmd)
    }

    /// Builds a container image from a Containerfile.
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

    /// Stages the build context into the engine and returns its engine path.
    pub fn prepare_build_context(
        &self,
        build_root: &std::path::Path,
    ) -> anyhow::Result<std::path::PathBuf> {
        self.inner.prepare_build_context(build_root)
    }

    /// Fetches the last `tail` lines of a single container's logs.
    pub fn container_logs(&self, container: &str, tail: u32) -> anyhow::Result<String> {
        self.inner.container_logs(container, tail)
    }

    /// `Ok(true)` if an image with this tag exists; `Ok(false)` only when the engine answers that it
    /// is absent, while an engine that cannot answer is `Err`.
    pub fn image_exists(&self, tag: &str) -> anyhow::Result<bool> {
        self.inner.image_exists(tag)
    }

    /// Prunes unused engine data (system prune).
    pub fn system_prune(&self) -> anyhow::Result<()> {
        self.inner.system_prune()
    }

    /// Removes the given image tags.
    pub fn remove_images(&self, tags: &[String], force: bool) -> anyhow::Result<()> {
        self.inner.remove_images(tags, force)
    }

    /// Prunes the BuildKit build cache.
    pub fn prune_buildkit_cache(&self) -> anyhow::Result<()> {
        self.inner.prune_buildkit_cache()
    }

    /// Prunes images not referenced by any container.
    pub fn prune_unused_images(&self) -> anyhow::Result<()> {
        self.inner.prune_unused_images()
    }

    /// Restarts the container engine inside the VM.
    pub fn restart_container_engine(&self) -> anyhow::Result<()> {
        self.inner.restart_container_engine()
    }

    /// Stops the backing VM.
    pub fn stop_vm(&self) -> anyhow::Result<()> {
        self.inner.stop_vm()
    }

    /// Resets (deletes and recreates) the backing VM.
    pub fn reset_vm(&self) -> anyhow::Result<()> {
        self.inner.reset_vm()
    }

    /// Runs a command inside the VM with stdin and a timeout.
    pub fn vm_exec(
        &self,
        cmd: &str,
        args: &[&str],
        stdin: &[u8],
        timeout: std::time::Duration,
    ) -> anyhow::Result<super::VmExecOutput> {
        self.inner.vm_exec(cmd, args, stdin, timeout)
    }

    /// Runs a multi-step compose transaction under the per-project lock. Inner compose ops on
    /// the same project nest reentrantly. Use for snapshot+build+down+save+validate+up.
    pub fn transaction<F, T>(&self, project: &str, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&LockedRuntime) -> anyhow::Result<T>,
    {
        with_acquired(project, || f(self))
    }

    fn start_isolated(
        &self,
        project: &str,
        up: impl FnOnce() -> anyhow::Result<()>,
    ) -> anyhow::Result<()> {
        self.refuse_during_engine_teardown()?;
        let legacy = self.isolate_egress_less_networks(project)?;
        if legacy.is_empty() {
            return up();
        }
        log::warn!(
            "project {project} still has the compose-created networks {legacy:?} of a release \
             before the isolated pre-create; recreating every container so none stays on them"
        );
        let result = self.inner.compose_up_recreate(project);
        crate::slash::invalidate_cache(project);
        result?;
        for name in &legacy {
            self.inner.remove_network(name).map_err(|e| {
                e.context(format!(
                    "the containers of {project} were recreated, but the network {name} could \
                     not be removed; stop the containers attached to it (or remove the network) \
                     and start the project again"
                ))
            })?;
        }
        self.settle_legacy_networks(project);
        Ok(())
    }

    fn isolate_egress_less_networks(&self, project: &str) -> anyhow::Result<Vec<String>> {
        let settled = self.legacy_networks_are_settled(project);
        let mut probed = false;
        let mut legacy = Vec::new();
        for name in crate::compose::compose_egress_less_networks_in(self.data_dir(), project)? {
            self.inner.ensure_internal_network(&name, project)?;
            if settled {
                continue;
            }
            probed = true;
            let compose_created = crate::compose::legacy_compose_network_name(project, &name);
            if self.inner.network_exists(&compose_created)? {
                legacy.push(compose_created);
            }
        }
        if probed && legacy.is_empty() {
            self.settle_legacy_networks(project);
        }
        Ok(legacy)
    }

    fn data_dir(&self) -> &std::path::Path {
        #[cfg(any(test, feature = "test-support"))]
        if let Some(dir) = &self.data_dir_override {
            return dir;
        }
        crate::consts::data_dir()
    }

    fn legacy_networks_are_settled(&self, project: &str) -> bool {
        legacy_networks_settled()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains(&self.settled_key(project))
    }

    fn settled_key(&self, project: &str) -> (std::path::PathBuf, String) {
        (self.data_dir().to_path_buf(), project.to_string())
    }

    fn settle_legacy_networks(&self, project: &str) {
        legacy_networks_settled()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(self.settled_key(project));
    }
}

fn legacy_networks_settled() -> &'static SettledProjects {
    static SETTLED: std::sync::OnceLock<SettledProjects> = std::sync::OnceLock::new();
    SETTLED.get_or_init(Default::default)
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code asserts via unwrap")]
mod tests {
    use super::*;
    use crate::runtime::mock_runtime::MockRuntimeBuilder;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn no_compose_stack_starts_once_the_engine_teardown_began() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_engine_teardown_check(|| true)
            .build();
        for started in [
            rt.compose_up("torn"),
            rt.compose_up_recreate("torn"),
            rt.compose_up_service("torn", crate::consts::CLAUDE_COMPOSE_SERVICE),
        ] {
            let err = started.unwrap_err();
            assert!(
                err.downcast_ref::<crate::runtime::EngineTearingDown>()
                    .is_some(),
                "got: {err}"
            );
        }
        assert!(handles.up_projects().is_empty());
        assert!(!handles.was_recreated());
    }

    #[test]
    fn a_compose_stack_still_goes_down_during_the_engine_teardown() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_engine_teardown_check(|| true)
            .build();
        rt.compose_down("torn").unwrap();
        assert_eq!(handles.down_projects(), vec!["torn".to_string()]);
    }

    #[test]
    fn compose_up_reads_the_engine_teardown_under_the_project_lock() {
        static TEARDOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        fn teardown_started() -> bool {
            TEARDOWN.load(Ordering::SeqCst)
        }
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_engine_teardown_check(teardown_started)
            .build();
        let rt = Arc::new(rt);
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let holder = {
            let rt = Arc::clone(&rt);
            std::thread::spawn(move || {
                rt.transaction("race", |_| {
                    held_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
            })
        };
        held_rx.recv().unwrap();
        let starter = {
            let rt = Arc::clone(&rt);
            std::thread::spawn(move || rt.compose_up("race"))
        };
        std::thread::sleep(std::time::Duration::from_millis(100));
        TEARDOWN.store(true, Ordering::SeqCst);
        release_tx.send(()).unwrap();
        holder.join().unwrap().unwrap();
        let err = starter.join().unwrap().unwrap_err();
        assert!(
            err.downcast_ref::<crate::runtime::EngineTearingDown>()
                .is_some(),
            "a start waiting on the lock while exit took the stack down must not bring it back, got: {err}"
        );
        assert!(handles.up_projects().is_empty());
    }

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
    fn is_installed_defaults_to_is_available() {
        let (rt_yes, _) = MockRuntimeBuilder::new().with_is_available(true).build();
        assert!(rt_yes.is_installed());
        let (rt_no, _) = MockRuntimeBuilder::new().with_is_available(false).build();
        assert!(!rt_no.is_installed());
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

    fn rendered(project: &str, yaml: &str) -> tempfile::TempDir {
        let data_dir = tempfile::tempdir().unwrap();
        write_rendered(data_dir.path(), project, yaml);
        data_dir
    }

    fn write_rendered(data_dir: &std::path::Path, project: &str, yaml: &str) {
        let path = crate::compose::compose_output_path_in(data_dir, project).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, yaml).unwrap();
    }

    fn compose_with_office(project: &str) -> String {
        let office = crate::compose::egress_less_network_names(project).remove(0);
        format!(
            "services: {{}}\nnetworks:\n  main:\n    driver: bridge\n  {office}:\n    name: {office}\n    external: true\n"
        )
    }

    fn start_every_way(rt: &LockedRuntime, project: &str) -> Vec<anyhow::Result<()>> {
        vec![
            rt.compose_up(project),
            rt.compose_up_recreate(project),
            rt.compose_up_service(project, crate::consts::CLAUDE_COMPOSE_SERVICE),
        ]
    }

    #[test]
    fn every_start_creates_the_egress_less_networks_first() {
        let project = "locked-net-ensure";
        let data_dir = rendered(project, &compose_with_office(project));
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .build();
        for started in start_every_way(&rt, project) {
            started.unwrap();
        }
        let office = crate::compose::egress_less_network_names(project).remove(0);
        assert_eq!(
            handles.ensured_networks(),
            vec![office.clone(), office.clone(), office]
        );
        assert!(handles
            .ensure_network_calls
            .lock()
            .unwrap()
            .iter()
            .all(|(_, p)| p == project));
        assert_eq!(handles.up_projects(), vec![project.to_string()]);
        assert!(handles.was_recreated());
        assert_eq!(handles.up_service_calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn no_stack_starts_when_its_egress_less_network_cannot_be_isolated() {
        let project = "locked-net-fail";
        let data_dir = rendered(project, &compose_with_office(project));
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .with_ensure_network_error("network has egress")
            .build();
        for started in start_every_way(&rt, project) {
            let err = started.unwrap_err();
            assert!(err.to_string().contains("network has egress"), "{err}");
        }
        assert_eq!(handles.ensured_networks().len(), 3);
        assert!(handles.up_projects().is_empty());
        assert!(!handles.was_recreated());
        assert!(handles.up_service_calls.lock().unwrap().is_empty());
    }

    #[test]
    fn a_stack_without_egress_less_networks_creates_none() {
        let project = "locked-net-none";
        let data_dir = rendered(
            project,
            "services: {}\nnetworks:\n  main:\n    driver: bridge\n",
        );
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .build();
        for started in start_every_way(&rt, project) {
            started.unwrap();
        }
        assert!(handles.ensured_networks().is_empty());
        assert_eq!(handles.up_projects(), vec![project.to_string()]);
    }

    #[test]
    fn a_project_without_a_rendered_compose_creates_no_network() {
        let data_dir = tempfile::tempdir().unwrap();
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .build();
        rt.compose_up("locked-net-unrendered").unwrap();
        assert!(handles.ensured_networks().is_empty());
        assert_eq!(
            handles.up_projects(),
            vec!["locked-net-unrendered".to_string()]
        );
    }

    #[test]
    fn an_unparsable_compose_stops_the_start() {
        let project = "locked-net-garbage";
        let data_dir = rendered(project, "networks: [unclosed");
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .build();
        assert!(rt.compose_up(project).is_err());
        assert!(handles.up_projects().is_empty());
    }

    #[test]
    fn the_teardown_refusal_comes_before_any_network_is_created() {
        let project = "locked-net-teardown";
        let data_dir = rendered(project, &compose_with_office(project));
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .with_engine_teardown_check(|| true)
            .build();
        assert!(rt.compose_up(project).is_err());
        assert!(handles.ensured_networks().is_empty());
    }

    fn legacy_office(project: &str) -> String {
        let office = crate::compose::egress_less_network_names(project).remove(0);
        crate::compose::legacy_compose_network_name(project, &office)
    }

    #[test]
    fn a_plain_start_over_the_compose_created_network_recreates_and_removes_it() {
        let project = "locked-net-legacy";
        let data_dir = rendered(project, &compose_with_office(project));
        let legacy = legacy_office(project);
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .with_existing_network(&legacy)
            .build();
        rt.compose_up(project).unwrap();
        assert!(handles.up_projects().is_empty(), "never a plain up");
        assert_eq!(
            *handles.recreate_calls.lock().unwrap(),
            vec![project.to_string()]
        );
        assert_eq!(handles.removed_networks(), vec![legacy.clone()]);
        assert_eq!(handles.probed_networks(), vec![legacy]);
        assert_eq!(handles.ensured_networks().len(), 1);
    }

    #[test]
    fn every_full_start_over_the_compose_created_network_recreates_the_whole_stack() {
        let full_starts: [fn(&LockedRuntime, &str) -> anyhow::Result<()>; 2] = [
            LockedRuntime::compose_up,
            LockedRuntime::compose_up_recreate,
        ];
        for full_start in full_starts {
            let project = "locked-net-legacy-all";
            let data_dir = rendered(project, &compose_with_office(project));
            let legacy = legacy_office(project);
            let (rt, handles) = MockRuntimeBuilder::new()
                .with_data_dir(data_dir.path())
                .with_existing_network(&legacy)
                .build();
            full_start(&rt, project).unwrap();
            assert!(handles.up_projects().is_empty());
            assert_eq!(handles.recreate_calls.lock().unwrap().len(), 1);
            assert_eq!(handles.removed_networks(), vec![legacy]);
        }
    }

    #[test]
    fn a_service_start_over_the_compose_created_network_leaves_the_stack_running() {
        let project = "locked-net-legacy-service";
        let data_dir = rendered(project, &compose_with_office(project));
        let legacy = legacy_office(project);
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .with_existing_network(&legacy)
            .build();
        let err = rt.compose_up_service(project, "proxy").unwrap_err();
        assert!(err
            .downcast_ref::<super::super::NetworkMigrationPending>()
            .is_some());
        assert_eq!(
            err.to_string(),
            "The project network is being migrated to an isolated network; restart the project \
             to finish it."
        );
        assert!(handles.up_service_calls.lock().unwrap().is_empty());
        assert!(!handles.was_recreated());
        assert!(handles.up_projects().is_empty());
        assert!(handles.down_projects().is_empty());
        assert!(handles.removed_networks().is_empty());
        assert_eq!(handles.probed_networks(), vec![legacy]);
        assert_eq!(handles.ensured_networks().len(), 1);
    }

    #[test]
    fn a_service_start_works_again_once_a_full_start_migrated_the_network() {
        let project = "locked-net-legacy-then-service";
        let data_dir = rendered(project, &compose_with_office(project));
        let legacy = legacy_office(project);
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .with_existing_network(&legacy)
            .build();
        assert!(rt.compose_up_service(project, "proxy").is_err());
        rt.compose_up(project).unwrap();
        rt.compose_up_service(project, "proxy").unwrap();
        assert_eq!(
            *handles.up_service_calls.lock().unwrap(),
            vec![(project.to_string(), "proxy".to_string())]
        );
        assert_eq!(handles.recreate_calls.lock().unwrap().len(), 1);
        assert_eq!(handles.removed_networks(), vec![legacy.clone()]);
        assert_eq!(handles.probed_networks(), vec![legacy; 2]);
    }

    #[test]
    fn a_start_after_one_that_found_no_compose_created_network_probes_no_more() {
        let project = "locked-net-settled";
        let data_dir = rendered(project, &compose_with_office(project));
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .build();
        for started in start_every_way(&rt, project) {
            started.unwrap();
        }
        rt.compose_up(project).unwrap();
        assert_eq!(handles.probed_networks(), vec![legacy_office(project)]);
        assert_eq!(handles.ensured_networks().len(), 4);
        assert!(handles.removed_networks().is_empty());
    }

    #[test]
    fn a_start_after_a_migration_probes_no_more_and_keeps_its_own_up() {
        let project = "locked-net-settled-after-migration";
        let data_dir = rendered(project, &compose_with_office(project));
        let legacy = legacy_office(project);
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .with_existing_network(&legacy)
            .build();
        rt.compose_up(project).unwrap();
        rt.compose_up(project).unwrap();
        assert_eq!(handles.probed_networks(), vec![legacy.clone()]);
        assert_eq!(handles.recreate_calls.lock().unwrap().len(), 1);
        assert_eq!(handles.up_projects(), vec![project.to_string()]);
        assert_eq!(handles.removed_networks(), vec![legacy]);
        assert_eq!(handles.ensured_networks().len(), 2);
    }

    #[test]
    fn a_compose_created_network_left_in_place_is_probed_again_on_the_next_start() {
        let project = "locked-net-unsettled-after-busy";
        let data_dir = rendered(project, &compose_with_office(project));
        let legacy = legacy_office(project);
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .with_existing_network(&legacy)
            .with_remove_network_error("network is in use by container \"abc\"")
            .build();
        assert!(rt.compose_up(project).is_err());
        assert!(rt.compose_up(project).is_err());
        assert_eq!(handles.probed_networks(), vec![legacy; 2]);
        assert_eq!(handles.recreate_calls.lock().unwrap().len(), 2);
    }

    #[test]
    fn the_settled_probe_is_kept_per_data_dir_and_project() {
        let project = "locked-net-settled-scope";
        let first = rendered(project, &compose_with_office(project));
        let (rt, _) = MockRuntimeBuilder::new()
            .with_data_dir(first.path())
            .build();
        rt.compose_up(project).unwrap();
        let second = rendered(project, &compose_with_office(project));
        let other = "locked-net-settled-scope-other";
        write_rendered(first.path(), other, &compose_with_office(other));
        let (rt_second, handles_second) = MockRuntimeBuilder::new()
            .with_data_dir(second.path())
            .build();
        rt_second.compose_up(project).unwrap();
        assert_eq!(
            handles_second.probed_networks(),
            vec![legacy_office(project)]
        );
        let (rt_other, handles_other) = MockRuntimeBuilder::new()
            .with_data_dir(first.path())
            .build();
        rt_other.compose_up(other).unwrap();
        assert_eq!(handles_other.probed_networks(), vec![legacy_office(other)]);
    }

    #[test]
    fn a_mock_without_a_data_dir_reads_an_empty_one_of_its_own() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        let (other, _) = MockRuntimeBuilder::new().build();
        let dir = rt.data_dir().to_path_buf();
        assert!(dir.is_dir());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        assert_ne!(dir, other.data_dir());
        rt.compose_up("locked-net-own-data-dir").unwrap();
        assert!(handles.ensured_networks().is_empty());
        drop(rt);
        assert!(!dir.exists());
    }

    #[test]
    fn a_start_without_the_compose_created_network_keeps_its_own_up() {
        let project = "locked-net-no-legacy";
        let data_dir = rendered(project, &compose_with_office(project));
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .build();
        rt.compose_up(project).unwrap();
        assert_eq!(handles.up_projects(), vec![project.to_string()]);
        assert!(!handles.was_recreated());
        assert!(handles.removed_networks().is_empty());
        assert_eq!(handles.probed_networks(), vec![legacy_office(project)]);
    }

    #[test]
    fn a_stack_without_egress_less_networks_probes_no_compose_created_one() {
        let project = "locked-net-no-office";
        let data_dir = rendered(
            project,
            "services: {}\nnetworks:\n  main:\n    driver: bridge\n",
        );
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .with_existing_network(&legacy_office(project))
            .build();
        rt.compose_up(project).unwrap();
        assert!(handles.probed_networks().is_empty());
        assert_eq!(handles.up_projects(), vec![project.to_string()]);
        assert!(!handles.was_recreated());
    }

    #[test]
    fn an_unreadable_compose_created_network_stops_the_start() {
        let project = "locked-net-legacy-unreadable";
        let data_dir = rendered(project, &compose_with_office(project));
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .with_network_exists_error("command 'limactl' timed out after 60s")
            .build();
        for started in start_every_way(&rt, project) {
            let err = started.unwrap_err();
            assert!(err.to_string().contains("timed out"), "{err}");
        }
        assert_eq!(
            handles.probed_networks().len(),
            3,
            "an unanswered probe is never settled"
        );
        assert!(handles.up_projects().is_empty());
        assert!(!handles.was_recreated());
        assert!(handles.up_service_calls.lock().unwrap().is_empty());
        assert!(handles.removed_networks().is_empty());
    }

    #[test]
    fn a_compose_created_network_still_in_use_fails_the_start_after_the_recreate() {
        let project = "locked-net-legacy-busy";
        let data_dir = rendered(project, &compose_with_office(project));
        let legacy = legacy_office(project);
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .with_existing_network(&legacy)
            .with_remove_network_error("network is in use by container \"abc\"")
            .build();
        let err = rt.compose_up(project).unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("is in use"), "{msg}");
        assert!(msg.contains(&legacy), "{msg}");
        assert!(
            msg.contains("stop the containers attached to it (or remove the network)"),
            "{msg}"
        );
        assert!(!msg.contains("stop the project"), "{msg}");
        assert!(handles.was_recreated());
        assert_eq!(handles.removed_networks(), vec![legacy]);
    }

    #[test]
    fn a_failed_recreate_leaves_the_compose_created_network_in_place() {
        let project = "locked-net-legacy-recreate-fails";
        let data_dir = rendered(project, &compose_with_office(project));
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_data_dir(data_dir.path())
            .with_existing_network(&legacy_office(project))
            .with_fail_on_recreate(&[project])
            .build();
        assert!(rt.compose_up(project).is_err());
        assert!(handles.up_projects().is_empty());
        assert!(handles.removed_networks().is_empty());
    }

    #[test]
    fn removing_egress_less_networks_removes_every_one_of_the_project() {
        let (rt, handles) = MockRuntimeBuilder::new().build();
        rt.remove_egress_less_networks("gone").unwrap();
        let expected: Vec<String> = crate::compose::egress_less_network_names("gone")
            .into_iter()
            .flat_map(|name| {
                let legacy = crate::compose::legacy_compose_network_name("gone", &name);
                [name, legacy]
            })
            .collect();
        assert_eq!(handles.removed_networks(), expected);
    }

    #[test]
    fn removing_egress_less_networks_returns_the_engine_error() {
        let (rt, handles) = MockRuntimeBuilder::new()
            .with_remove_network_error("network is in use")
            .build();
        let err = rt.remove_egress_less_networks("busy").unwrap_err();
        assert!(err.to_string().contains("in use"), "{err}");
        assert_eq!(handles.removed_networks().len(), 1);
    }

    #[test]
    fn builder_construction_yields_locked_wrapper() {
        let (rt, _) = MockRuntimeBuilder::new().build();
        assert!(rt.is_available());
    }
}
