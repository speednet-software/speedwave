//! Integration test for `SPEEDWAVE_DATA_DIR` env var → OnceLock wiring.
//!
//! OnceLock is immutable after first init, so we cannot test multiple env var
//! values in a single process.  The Makefile sets `SPEEDWAVE_DATA_DIR=` (empty)
//! for unit tests, which causes `data_dir()` to fall back to `~/.speedwave/`.
//!
//! This integration test binary verifies the custom-env-var scenario by
//! spawning a subprocess with `SPEEDWAVE_DATA_DIR` set.  The subprocess is
//! a small Rust program compiled as a test helper.

use std::process::Command;

/// Spawns a child process that sets `SPEEDWAVE_DATA_DIR` and verifies
/// the OnceLock-backed functions return correct derived values.
///
/// We use the cargo test binary itself with a marker env var to detect
/// the child role.
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
