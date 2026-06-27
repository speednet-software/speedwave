//! Behavioural coverage for `update::apply_update_transaction` and
//! `update::apply_rollback_transaction` via mocked `LockedRuntime` call
//! recording. Own binary: `consts::data_dir()` `OnceLock` resolves once.

#![allow(clippy::unwrap_used, clippy::expect_used)]

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
    // Contract pin (ADR-066): builds happen OUTSIDE the lock.
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
fn apply_update_transaction_fails_after_down_when_recreate_fails() {
    // The dangerous window: compose_down succeeds, compose_up_recreate fails.
    // The transaction errors with the project torn down — exactly the state the
    // CLI update path now auto-rolls-back from (a snapshot was saved first).
    let data_dir = shared_data_dir();
    let project = "tx-recreate-fail";
    let compose_dir = data_dir.join("compose").join(project);
    std::fs::create_dir_all(&compose_dir).unwrap();
    std::fs::write(
        compose_dir.join("compose.yml"),
        "version: '3'\nservices: {}\n",
    )
    .unwrap();

    let (rt, handles) = MockRuntimeBuilder::new()
        .with_fail_on_recreate(&[project])
        .build();
    let err = apply_update_transaction(&rt, project, VALID_YAML).unwrap_err();
    assert!(
        !err.to_string().is_empty(),
        "recreate failure must propagate"
    );

    let down = handles.down_calls.lock().unwrap().clone();
    let recreate = handles.recreate_calls.lock().unwrap().clone();
    assert_eq!(
        down,
        vec![project.to_string()],
        "compose_down ran — the project is torn down"
    );
    assert_eq!(
        recreate,
        vec![project.to_string()],
        "compose_up_recreate was attempted and failed (the rollback-worthy window)"
    );
    // The snapshot saved before compose_down is what rollback restores.
    let snapshot = data_dir
        .join("snapshots")
        .join(project)
        .join("snapshot.json");
    assert!(
        snapshot.exists(),
        "a snapshot must exist so the CLI can roll back after a recreate failure"
    );
}

/// Pre-ADR-072 state: legacy single-id applied, no per-image map.
fn legacy_state(applied: Option<&str>) -> speedwave_runtime::bundle::BundleState {
    speedwave_runtime::bundle::BundleState {
        applied_bundle_id: applied.map(str::to_string),
        ..Default::default()
    }
}

#[test]
#[serial_test::serial]
fn maybe_prune_previous_bundle_prunes_legacy_tags_on_migration() {
    let _ = shared_data_dir();
    let (rt, handles) = MockRuntimeBuilder::new().build();
    let manifest = speedwave_runtime::bundle::BundleManifest::for_tests("new-bundle");
    maybe_prune_previous_bundle(&rt, &legacy_state(Some("old-bundle")), &manifest);

    let removed = handles.remove_images_calls.lock().unwrap().clone();
    assert!(
        !removed.is_empty(),
        "remove_images must be called when migrating off a legacy bundle id"
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
    let manifest = speedwave_runtime::bundle::BundleManifest::for_tests("same-bundle");
    maybe_prune_previous_bundle(&rt, &legacy_state(Some("same-bundle")), &manifest);

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
    let manifest = speedwave_runtime::bundle::BundleManifest::for_tests("new-bundle");
    maybe_prune_previous_bundle(&rt, &legacy_state(None), &manifest);

    assert!(
        handles.remove_images_calls.lock().unwrap().is_empty(),
        "remove_images must NOT be called on first install (no previous bundle)"
    );
}

#[test]
#[serial_test::serial]
fn maybe_prune_previous_bundle_prunes_replaced_per_image_tags() {
    let _ = shared_data_dir();
    let manifest = speedwave_runtime::bundle::BundleManifest::for_tests("newhash");
    // Applied state matches the manifest except one image on an older hash.
    let mut state = legacy_state(Some("aggregate-id"));
    state.applied_image_hashes = manifest.image_hashes.clone();
    state
        .applied_image_hashes
        .insert("speedwave-claude".to_string(), "oldhash".to_string());

    let (rt, handles) = MockRuntimeBuilder::new()
        .with_image_exists("speedwave-claude:oldhash", true)
        .build();
    maybe_prune_previous_bundle(&rt, &state, &manifest);

    let removed = handles.remove_images_calls.lock().unwrap().clone();
    assert_eq!(removed.len(), 1, "exactly one remove_images call expected");
    assert_eq!(removed[0].0, vec!["speedwave-claude:oldhash".to_string()]);
    assert!(
        !removed[0].0.iter().any(|tag| tag.contains("aggregate-id")),
        "non-empty per-image map must suppress the legacy single-id prune"
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
        let manifest = speedwave_runtime::bundle::BundleManifest::for_tests("new");
        maybe_prune_previous_bundle(&rt, &legacy_state(Some("old")), &manifest);
    }
    assert!(
        handles.remove_images_calls.lock().unwrap().is_empty(),
        "prune must not run when update transaction failed"
    );
}

#[test]
#[serial_test::serial]
fn apply_rollback_transaction_runs_save_then_recreate_skipping_vm_validate() {
    let data_dir = shared_data_dir();
    let project = "tx-rollback";
    let (rt, handles) = MockRuntimeBuilder::new().build();
    apply_rollback_transaction(&rt, project, VALID_YAML).unwrap();

    let validate = handles.validate_calls.lock().unwrap().clone();
    let recreate = handles.recreate_calls.lock().unwrap().clone();
    assert!(
        validate.is_empty(),
        "rollback path skips VM-side validate (recovery resilience, ADR-066)"
    );
    assert_eq!(recreate, vec![project.to_string()]);

    let compose_path = data_dir.join("compose").join(project).join("compose.yml");
    let on_disk = std::fs::read_to_string(&compose_path).unwrap();
    assert_eq!(
        on_disk, VALID_YAML,
        "save_compose ran inside the transaction"
    );
}

#[test]
#[serial_test::serial]
fn apply_rollback_transaction_proceeds_with_recreate_when_validate_would_fail() {
    // Resilience contract: rollback attempts recreate even if validate would fail.
    let data_dir = shared_data_dir();
    let project = "tx-rollback-no-validate";
    let (rt, handles) = MockRuntimeBuilder::new()
        .push_validate_result(Err(
            "service \"x\" refers to undefined network y: invalid compose project".to_string(),
        ))
        .build();
    apply_rollback_transaction(&rt, project, VALID_YAML).unwrap();

    // Pre-loaded validate failure was never consumed (rollback never called validate).
    assert!(
        handles.validate_calls.lock().unwrap().is_empty(),
        "rollback must not consume the queued validate failure"
    );
    assert_eq!(
        handles.recreate_calls.lock().unwrap().clone(),
        vec![project.to_string()],
        "recreate proceeds despite virtiofs lag that would block validate"
    );

    let compose_path = data_dir.join("compose").join(project).join("compose.yml");
    assert_eq!(std::fs::read_to_string(&compose_path).unwrap(), VALID_YAML);
}
