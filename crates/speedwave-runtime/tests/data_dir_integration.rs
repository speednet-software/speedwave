//! Integration test for `SPEEDWAVE_DATA_DIR` env var → OnceLock wiring via subprocess re-exec.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::process::Command;

/// Spawns a child process that sets `SPEEDWAVE_DATA_DIR` and verifies
/// the OnceLock-backed functions return correct derived values.
#[test]
fn data_dir_respects_env_var_and_derives_names() {
    if std::env::var("__SPEEDWAVE_INTEGRATION_CHILD").is_ok() {
        // We are in the child — run assertions
        child_assertions();
        return;
    }

    // Parent: re-exec this test binary with the env var set
    let exe = std::env::current_exe().expect("current_exe");
    let output = Command::new(&exe)
        .env("SPEEDWAVE_DATA_DIR", "/tmp/test-speedwave-xyz")
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

    // data_dir() should return the env var value
    let dd = consts::data_dir();
    assert_eq!(
        dd.as_path(),
        std::path::Path::new("/tmp/test-speedwave-xyz"),
        "data_dir() should return SPEEDWAVE_DATA_DIR value"
    );

    // lima_vm_name() should derive from basename
    assert_eq!(
        consts::lima_vm_name(),
        "test-speedwave-xyz",
        "lima_vm_name() should derive from data_dir basename"
    );

    // compose_prefix() should derive identically
    assert_eq!(
        consts::compose_prefix(),
        "test-speedwave-xyz",
        "compose_prefix() should derive from data_dir basename"
    );
}
