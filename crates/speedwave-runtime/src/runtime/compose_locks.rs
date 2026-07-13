//! Per-project compose transaction lock — in-process Mutex + cross-process file lock
//! (`<data_dir>/compose/<project>/compose.lock`). Innermost layer of `LockedRuntime` transaction.

use anyhow::Context;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

static IN_PROCESS_LOCKS: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn in_process_lock_for(project: &str) -> Arc<Mutex<()>> {
    let mut map = IN_PROCESS_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(project.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Holds in-process + file lock for `project`, runs `f`, releases in reverse.
pub(crate) fn with_project_compose_lock<F, T>(project: &str, f: F) -> anyhow::Result<T>
where
    F: FnOnce() -> anyhow::Result<T>,
{
    with_project_compose_lock_in(crate::consts::data_dir(), project, f)
}

/// Testable variant — lock-file root supplied explicitly.
/// RAII guard releasing the cross-process file lock on drop — panic-safe.
struct FileLockGuard(std::fs::File);

impl Drop for FileLockGuard {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

pub(crate) fn with_project_compose_lock_in<F, T>(
    data_dir: &std::path::Path,
    project: &str,
    f: F,
) -> anyhow::Result<T>
where
    F: FnOnce() -> anyhow::Result<T>,
{
    // Lock path is built from `project`; reject traversal at the boundary.
    crate::validation::validate_project_name(project)?;

    let inner_arc = in_process_lock_for(project);
    let lock_path = data_dir.join("compose").join(project).join("compose.lock");
    with_file_lock_in(&inner_arc, &lock_path, f)
}

/// Holds `in_process` + an exclusive file lock at `lock_path`, runs `f`, releases in reverse.
/// Shared by the per-project compose lock and `build::with_build_lock` (ADR-072).
pub(crate) fn with_file_lock_in<F, T>(
    in_process: &Mutex<()>,
    lock_path: &std::path::Path,
    f: F,
) -> anyhow::Result<T>
where
    F: FnOnce() -> anyhow::Result<T>,
{
    use fs2::FileExt;

    let _inner_guard = in_process.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let lock_file = std::fs::File::create(lock_path)?;
    lock_file
        .lock_exclusive()
        .with_context(|| format!("Failed to acquire lock at '{}'", lock_path.display()))?;
    let _file_guard = FileLockGuard(lock_file);

    f()
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics on failure are the expected fixture behavior"
)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::{Duration, Instant};

    fn tempdir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn same_project_serializes_in_process() {
        let dir = tempdir();
        let root = dir.path().to_path_buf();
        let entries: Arc<Mutex<Vec<(Instant, Instant)>>> = Arc::new(Mutex::new(Vec::new()));

        let mut handles = Vec::new();
        for _ in 0..2 {
            let root = root.clone();
            let entries = Arc::clone(&entries);
            handles.push(thread::spawn(move || {
                with_project_compose_lock_in(&root, "alpha", || {
                    let entered = Instant::now();
                    thread::sleep(Duration::from_millis(100));
                    let exited = Instant::now();
                    entries.lock().unwrap().push((entered, exited));
                    Ok(())
                })
                .unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        let mut e = entries.lock().unwrap().clone();
        e.sort_by_key(|(entered, _)| *entered);
        assert_eq!(e.len(), 2);
        // The second thread must enter only after the first one exited.
        assert!(
            e[1].0 >= e[0].1,
            "expected serialization: second entered {:?} before first exited {:?}",
            e[1].0,
            e[0].1
        );
    }

    #[test]
    fn different_projects_run_in_parallel() {
        let dir = tempdir();
        let root = dir.path().to_path_buf();
        let in_flight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        let barrier = Arc::new(std::sync::Barrier::new(2));

        let mut handles = Vec::new();
        for project in ["alpha", "beta"] {
            let root = root.clone();
            let in_flight = Arc::clone(&in_flight);
            let peak = Arc::clone(&peak);
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                with_project_compose_lock_in(&root, project, || {
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
            "expected both projects in flight simultaneously"
        );
    }

    #[test]
    fn lock_file_created_in_per_project_dir() {
        let dir = tempdir();
        let root = dir.path().to_path_buf();
        with_project_compose_lock_in(&root, "gamma", || Ok(())).unwrap();

        let expected = root.join("compose").join("gamma").join("compose.lock");
        assert!(
            expected.exists(),
            "lock file should be created at {}",
            expected.display()
        );
    }

    #[test]
    fn poisoned_lock_recovers() {
        let dir = tempdir();
        let root = dir.path().to_path_buf();

        // Poison the in-process inner mutex by panicking inside it.
        let root_clone = root.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_project_compose_lock_in(&root_clone, "delta", || -> anyhow::Result<()> {
                panic!("simulated panic inside critical section");
            })
        }));
        assert!(result.is_err(), "panic must propagate");

        // Subsequent acquire must still succeed (PoisonError recovery via `into_inner`).
        let value = with_project_compose_lock_in(&root, "delta", || Ok(42)).unwrap();
        assert_eq!(value, 42);
    }

    #[test]
    fn lock_recreated_after_drop_safe() {
        let dir = tempdir();
        let root = dir.path().to_path_buf();
        for _ in 0..10 {
            with_project_compose_lock_in(&root, "epsilon", || Ok(())).unwrap();
        }
        let map_len = IN_PROCESS_LOCKS.lock().unwrap().len();
        // Parallel tests may add entries, so assert only our key is present.
        let map_contains = IN_PROCESS_LOCKS.lock().unwrap().contains_key("epsilon");
        assert!(map_contains, "epsilon entry should persist for reuse");
        assert!(map_len >= 1);
    }

    #[test]
    fn closure_result_is_returned() {
        let dir = tempdir();
        let root = dir.path().to_path_buf();
        let value: String =
            with_project_compose_lock_in(&root, "zeta", || Ok("hello".to_string())).unwrap();
        assert_eq!(value, "hello");
    }

    #[test]
    fn closure_error_propagates() {
        let dir = tempdir();
        let root = dir.path().to_path_buf();
        let err = with_project_compose_lock_in(&root, "eta", || -> anyhow::Result<()> {
            anyhow::bail!("expected failure")
        })
        .unwrap_err();
        assert!(err.to_string().contains("expected failure"));
    }

    #[test]
    fn panic_releases_file_lock_via_raii() {
        let dir = tempdir();
        let root = dir.path().to_path_buf();
        // Panic in the critical section; FileLockGuard::drop must release the file lock.
        let root_clone = root.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_project_compose_lock_in(&root_clone, "panic_proj", || -> anyhow::Result<()> {
                panic!("simulated panic");
            })
        }));
        assert!(result.is_err(), "panic must propagate");
        // Acquire again — would deadlock if file lock leaked.
        let value = with_project_compose_lock_in(&root, "panic_proj", || Ok(99)).unwrap();
        assert_eq!(value, 99);
    }

    #[test]
    fn invalid_project_name_rejected_at_boundary() {
        let dir = tempdir();
        let root = dir.path().to_path_buf();
        // Path traversal attempt — must be rejected by validate_project_name.
        let err = with_project_compose_lock_in(&root, "../escape", || Ok(0)).unwrap_err();
        assert!(
            err.to_string().to_lowercase().contains("invalid")
                || err.to_string().contains("project"),
            "expected project-name validation error, got: {err}"
        );
    }
}
