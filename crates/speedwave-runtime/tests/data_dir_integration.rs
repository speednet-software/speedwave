//! Integration test for `SPEEDWAVE_DATA_DIR` env var → OnceLock wiring via subprocess re-exec.

#![expect(
    clippy::expect_used,
    reason = "test assertions on setup/mock calls that must not silently fail"
)]

use std::process::Command;

/// Platform-absolute fixture: `data_dir_from` rejects a non-absolute path,
/// and `/tmp/...` is not absolute on Windows.
#[cfg(windows)]
const TEST_DATA_DIR: &str = r"C:\tmp\test-speedwave-xyz";
#[cfg(not(windows))]
const TEST_DATA_DIR: &str = "/tmp/test-speedwave-xyz";

/// Spawns a child process that sets `SPEEDWAVE_DATA_DIR` and verifies
/// the OnceLock-backed functions return correct derived values.
#[test]
fn data_dir_respects_env_var_and_derives_names() {
    if std::env::var("__SPEEDWAVE_INTEGRATION_CHILD").is_ok() {
        child_assertions();
        return;
    }

    let exe = std::env::current_exe().expect("current_exe");
    let output = Command::new(&exe)
        .env("SPEEDWAVE_DATA_DIR", TEST_DATA_DIR)
        .env("__SPEEDWAVE_INTEGRATION_CHILD", "1")
        .arg("data_dir_respects_env_var_and_derives_names")
        .arg("--exact")
        .arg("--nocapture")
        .output()
        .expect("failed to spawn child process");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        output.status.success(),
        "child process failed:\nstdout: {stdout}\nstderr: {stderr}"
    );
}

fn child_assertions() {
    use speedwave_runtime::consts;

    let dd = consts::data_dir();
    assert_eq!(
        dd.as_path(),
        std::path::Path::new(TEST_DATA_DIR),
        "data_dir() should return SPEEDWAVE_DATA_DIR value"
    );

    assert_eq!(
        consts::lima_vm_name(),
        "test-speedwave-xyz",
        "lima_vm_name() should derive from data_dir basename"
    );

    assert_eq!(
        consts::compose_prefix(),
        "test-speedwave-xyz",
        "compose_prefix() should derive from data_dir basename"
    );
}
