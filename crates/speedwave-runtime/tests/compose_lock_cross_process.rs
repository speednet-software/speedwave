//! Cross-process file-lock test — re-execs the test binary as parent+child
//! per `tests/data_dir_integration.rs` pattern, asserts the second process
//! blocks until the first releases.

#![expect(
    clippy::expect_used,
    clippy::print_stderr,
    reason = "test child process reports failure on stderr and asserts on setup calls"
)]

use std::process::Command;
use std::time::Duration;

const CHILD_ENV: &str = "__SPEEDWAVE_COMPOSE_LOCK_CHILD";
const ROOT_ENV: &str = "__SPEEDWAVE_COMPOSE_LOCK_ROOT";
const HOLD_MS_ENV: &str = "__SPEEDWAVE_COMPOSE_LOCK_HOLD_MS";

/// Holder acquires the lock, writes a sentinel, sleeps `HOLD_MS`; parent polls
/// for the sentinel, then spawns the waiter and measures its blocking time.
const READY_SENTINEL: &str = "ready.lock";
const HOLD_MS: u64 = 800;
const MIN_BLOCK_MS: u64 = 200;
const READY_TIMEOUT_MS: u64 = 5_000;

#[test]
fn second_process_blocks_until_first_releases() {
    if let Ok(role) = std::env::var(CHILD_ENV) {
        run_child_role(&role);
        return;
    }

    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().to_path_buf();
    let sentinel = root.join(READY_SENTINEL);
    let exe = std::env::current_exe().expect("current_exe");

    let mut holder = Command::new(&exe)
        .env(CHILD_ENV, "hold")
        .env(ROOT_ENV, &root)
        .env(HOLD_MS_ENV, HOLD_MS.to_string())
        .arg("second_process_blocks_until_first_releases")
        .arg("--exact")
        .arg("--nocapture")
        .spawn()
        .expect("spawn holder");

    // Wait until holder writes the sentinel (lock acquired).
    let deadline = std::time::Instant::now() + Duration::from_millis(READY_TIMEOUT_MS);
    while !sentinel.exists() {
        if std::time::Instant::now() >= deadline {
            let _ = holder.kill();
            panic!("holder never signalled ready within {READY_TIMEOUT_MS} ms");
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    let waiter_start = std::time::Instant::now();
    let waiter = Command::new(&exe)
        .env(CHILD_ENV, "wait")
        .env(ROOT_ENV, &root)
        .env(HOLD_MS_ENV, "0")
        .arg("second_process_blocks_until_first_releases")
        .arg("--exact")
        .arg("--nocapture")
        .output()
        .expect("spawn waiter");
    let waiter_wallclock = waiter_start.elapsed();

    let holder_status = holder.wait().expect("holder wait");
    assert!(
        holder_status.success(),
        "holder process failed: {holder_status:?}"
    );

    let stdout = String::from_utf8_lossy(&waiter.stdout);
    let stderr = String::from_utf8_lossy(&waiter.stderr);
    assert!(
        waiter.status.success(),
        "waiter process failed:\nstdout: {stdout}\nstderr: {stderr}"
    );

    // MIN_BLOCK_MS: conservative lower bound for observed blocking time.
    assert!(
        waiter_wallclock >= Duration::from_millis(MIN_BLOCK_MS),
        "waiter returned in {waiter_wallclock:?}; expected ≥ {MIN_BLOCK_MS} ms of blocking"
    );
}

fn run_child_role(role: &str) {
    use speedwave_runtime::runtime::with_project_compose_lock_in_for_test as with_project_compose_lock_in;
    let root = std::env::var(ROOT_ENV).expect("ROOT_ENV must be set in child");
    let hold_ms: u64 = std::env::var(HOLD_MS_ENV)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let root_path = std::path::PathBuf::from(&root);

    let result =
        with_project_compose_lock_in(&root_path, "cross-proc-test", || -> anyhow::Result<()> {
            if role == "hold" {
                // Signal "lock acquired" to the parent via sentinel file.
                std::fs::write(root_path.join(READY_SENTINEL), b"ok")?;
            }
            if hold_ms > 0 {
                std::thread::sleep(Duration::from_millis(hold_ms));
            }
            Ok(())
        });

    if let Err(e) = result {
        eprintln!("child[{role}] failed: {e:?}");
        std::process::exit(2);
    }
}
