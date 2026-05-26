//! Behavioural coverage for `update::apply_update_transaction` and
//! `update::apply_rollback_transaction` — replaces brittle source-text
//! ordering assertions with mocked `LockedRuntime` call recording.
//!
//! Lives in its own integration-test binary because `consts::data_dir()`
//! uses a `OnceLock`: the env var is honoured on the first resolution
//! only. All three tests share one tmp dir (one resolution) and serialise
//! to keep recorded call vectors uncontaminated.

use std::sync::OnceLock;

use speedwave_runtime::build;
use speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder;
use speedwave_runtime::update_test_support::{
    apply_rollback_transaction, apply_update_transaction,
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
fn apply_update_transaction_runs_build_then_down_validate_recreate() {
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
    apply_update_transaction(&rt, project, VALID_YAML, &[], "bundle-test").unwrap();

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
fn apply_update_transaction_aborts_recreate_on_build_failure() {
    let data_dir = shared_data_dir();
    let project = "tx-update-fail";
    let compose_dir = data_dir.join("compose").join(project);
    std::fs::create_dir_all(&compose_dir).unwrap();
    std::fs::write(
        compose_dir.join("compose.yml"),
        "version: '3'\nservices: {}\n",
    )
    .unwrap();

    let (rt, handles) = MockRuntimeBuilder::new()
        .with_all_builds_failing("build broke")
        .build();
    let bundle_image = build::ImageDef {
        name: "speedwave-claude",
        context_dir: "claude",
        containerfile: "containers/Containerfile.claude",
        build_args: &[],
    };
    let err =
        apply_update_transaction(&rt, project, VALID_YAML, &[&bundle_image], "b").unwrap_err();
    assert!(
        err.to_string().contains("Image rebuild failed"),
        "got: {err}"
    );

    let down = handles.down_calls.lock().unwrap().clone();
    let recreate = handles.recreate_calls.lock().unwrap().clone();
    assert!(
        down.is_empty(),
        "compose_down must NOT run if build failed: running containers untouched"
    );
    assert!(
        recreate.is_empty(),
        "compose_up_recreate must NOT run if build failed"
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
