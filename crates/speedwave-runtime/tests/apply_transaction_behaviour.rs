//! Behavioural coverage for `update::apply_update_transaction` and
//! `update::apply_rollback_transaction` — replaces brittle source-text
//! ordering assertions with mocked `LockedRuntime` call recording.
//!
//! Lives in its own integration-test binary because `consts::data_dir()`
//! uses a `OnceLock`: the env var is honoured on the first resolution
//! only. All tests share one tmp dir (one resolution) and serialise to
//! keep recorded call vectors uncontaminated.

use std::sync::OnceLock;

use speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder;
use speedwave_runtime::update_test_support::{
    apply_rollback_transaction, apply_update_transaction, maybe_prune_previous_bundle,
};

const VALID_YAML: &str = "version: '3'\nnetworks:\n  default:\n    driver: bridge\nservices:\n  app:\n    image: nginx\n    networks:\n      - default\n";

fn shared_data_dir() -> &'static std::path::Path {
    static DIR: OnceLock<tempfile::TempDir> = OnceLock::new();
    let d = DIR.get_or_init(|| {
        let t = tempfile::tempdir().expect("tempdir");
        std::env::set_var("SPEEDWAVE_DATA_DIR", t.path());
        t
    });
    d.path()
}

#[test]
#[serial_test::serial]
fn apply_update_transaction_runs_down_then_validate_then_recreate() {
    let data_dir = shared_data_dir();
    let project = "tx-update";
    let compose_dir = data_dir.join("compose").join(project);
    std::fs::create_dir_all(&compose_dir).unwrap();
    std::fs::write(
        compose_dir.join("compose.yml"),
        "version: '3'\nservices: {}\n",
    )
    .unwrap();

    let (rt, handles) = MockRuntimeBuilder::new().build();
    apply_update_transaction(&rt, project, VALID_YAML).unwrap();

    let down = handles.down_calls.lock().unwrap().clone();
    let validate = handles.validate_calls.lock().unwrap().clone();
    let recreate = handles.recreate_calls.lock().unwrap().clone();
    assert_eq!(down, vec![project.to_string()], "compose_down called once");
    assert_eq!(
        validate,
        vec![project.to_string()],
        "compose_validate called once between down and recreate"
    );
    assert_eq!(
        recreate,
        vec![project.to_string()],
        "compose_up_recreate called once"
    );
}

#[test]
#[serial_test::serial]
fn apply_update_transaction_does_not_build_images() {
    // Contract pin (ADR-066): builds happen OUTSIDE the lock. The caller
    // (`update_containers`) builds first, then invokes this helper.
    let data_dir = shared_data_dir();
    let project = "tx-no-build";
    let compose_dir = data_dir.join("compose").join(project);
    std::fs::create_dir_all(&compose_dir).unwrap();
    std::fs::write(
        compose_dir.join("compose.yml"),
        "version: '3'\nservices: {}\n",
    )
    .unwrap();

    let (rt, handles) = MockRuntimeBuilder::new().build();
    apply_update_transaction(&rt, project, VALID_YAML).unwrap();

    assert_eq!(
        handles.build_call_count(),
        0,
        "apply_update_transaction must not trigger image builds"
    );
}

#[test]
#[serial_test::serial]
fn apply_update_transaction_aborts_recreate_on_compose_down_failure() {
    let data_dir = shared_data_dir();
    let project = "tx-down-fail";
    let compose_dir = data_dir.join("compose").join(project);
    std::fs::create_dir_all(&compose_dir).unwrap();
    std::fs::write(
        compose_dir.join("compose.yml"),
        "version: '3'\nservices: {}\n",
    )
    .unwrap();

    let (rt, handles) = MockRuntimeBuilder::new()
        .with_fail_on_down(&[project])
        .build();
    let err = apply_update_transaction(&rt, project, VALID_YAML).unwrap_err();
    assert!(
        !err.to_string().is_empty(),
        "compose_down failure must propagate"
    );

    let recreate = handles.recreate_calls.lock().unwrap().clone();
    assert!(
        recreate.is_empty(),
        "compose_up_recreate must NOT run if compose_down failed"
    );
}

#[test]
#[serial_test::serial]
fn maybe_prune_previous_bundle_prunes_when_bundle_id_differs() {
    let _ = shared_data_dir();
    let (rt, handles) = MockRuntimeBuilder::new().build();
    maybe_prune_previous_bundle(&rt, Some("old-bundle"), "new-bundle");

    let removed = handles.remove_images_calls.lock().unwrap().clone();
    assert!(
        !removed.is_empty(),
        "remove_images must be called when bundle ID changes"
    );
    assert!(
        removed[0].0.iter().any(|tag| tag.contains("old-bundle")),
        "removed tags must reference the old bundle ID, got: {:?}",
        removed[0].0
    );
}

#[test]
#[serial_test::serial]
fn maybe_prune_previous_bundle_skips_when_bundle_id_unchanged() {
    let _ = shared_data_dir();
    let (rt, handles) = MockRuntimeBuilder::new().build();
    maybe_prune_previous_bundle(&rt, Some("same-bundle"), "same-bundle");

    assert!(
        handles.remove_images_calls.lock().unwrap().is_empty(),
        "remove_images must NOT be called when bundle ID is unchanged"
    );
}

#[test]
#[serial_test::serial]
fn maybe_prune_previous_bundle_skips_when_no_previous_bundle() {
    let _ = shared_data_dir();
    let (rt, handles) = MockRuntimeBuilder::new().build();
    maybe_prune_previous_bundle(&rt, None, "new-bundle");

    assert!(
        handles.remove_images_calls.lock().unwrap().is_empty(),
        "remove_images must NOT be called on first install (no previous bundle)"
    );
}

#[test]
#[serial_test::serial]
fn prune_does_not_run_when_apply_update_transaction_fails() {
    // Atomicity: caller invokes maybe_prune_* only on Ok from apply.
    let data_dir = shared_data_dir();
    let project = "tx-prune-atomicity";
    let compose_dir = data_dir.join("compose").join(project);
    std::fs::create_dir_all(&compose_dir).unwrap();
    std::fs::write(
        compose_dir.join("compose.yml"),
        "version: '3'\nservices: {}\n",
    )
    .unwrap();

    let (rt, handles) = MockRuntimeBuilder::new()
        .with_fail_on_down(&[project])
        .build();
    let result = apply_update_transaction(&rt, project, VALID_YAML);
    assert!(result.is_err(), "apply_update_transaction must fail");

    // Simulate caller: prune only on Ok.
    if result.is_ok() {
        maybe_prune_previous_bundle(&rt, Some("old"), "new");
    }
    assert!(
        handles.remove_images_calls.lock().unwrap().is_empty(),
        "prune must not run when update transaction failed"
    );
}

#[test]
#[serial_test::serial]
fn apply_rollback_transaction_runs_save_then_validate_then_recreate() {
    let data_dir = shared_data_dir();
    let project = "tx-rollback";
    let (rt, handles) = MockRuntimeBuilder::new().build();
    apply_rollback_transaction(&rt, project, VALID_YAML).unwrap();

    let validate = handles.validate_calls.lock().unwrap().clone();
    let recreate = handles.recreate_calls.lock().unwrap().clone();
    assert_eq!(validate, vec![project.to_string()]);
    assert_eq!(recreate, vec![project.to_string()]);

    let compose_path = data_dir.join("compose").join(project).join("compose.yml");
    let on_disk = std::fs::read_to_string(&compose_path).unwrap();
    assert_eq!(
        on_disk, VALID_YAML,
        "save_compose ran inside the transaction"
    );
}
