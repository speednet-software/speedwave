//! Each LOCKED method on `LockedRuntime` acquires the per-project compose lock exactly once;
//! passthrough methods do not. Own process, so `LOCK_ACQUISITIONS` starts at zero.

#![expect(
    clippy::unwrap_used,
    reason = "test assertions on setup/mock calls that must not silently fail"
)]

use speedwave_runtime::runtime::mock_runtime::MockRuntimeBuilder;

// Internal hook from the crate's `runtime::locked` module.
extern crate speedwave_runtime as _runtime;

fn count() -> usize {
    speedwave_runtime::runtime::lock_acquisitions_for_test()
}

#[test]
#[serial_test::serial]
fn locked_methods_each_acquire_exactly_once() {
    let (rt, _) = MockRuntimeBuilder::new().build();

    let s = count();
    rt.compose_down("b").unwrap();
    assert_eq!(count() - s, 1, "compose_down");

    let s = count();
    rt.compose_up("c").unwrap();
    assert_eq!(count() - s, 1, "compose_up");

    let s = count();
    rt.compose_up_recreate("d").unwrap();
    assert_eq!(count() - s, 1, "compose_up_recreate");

    let s = count();
    rt.compose_validate("f").unwrap();
    assert_eq!(count() - s, 1, "compose_validate");
}

#[test]
#[serial_test::serial]
fn passthrough_methods_do_not_acquire() {
    let (rt, _) = MockRuntimeBuilder::new().build();

    let s = count();
    let _ = rt.is_available();
    let _ = rt.ensure_ready();
    let _ = rt.image_exists("tag:1");
    let _ = rt.build_image("t", "c", "Cf", &[]);
    let _ = rt.container_logs("ctr", 10);
    let _ = rt.compose_ps("a");
    let _ = rt.compose_logs("e", 10);
    let _ = rt.system_prune();
    let _ = rt.prune_buildkit_cache();
    let _ = rt.prune_unused_images();
    let _ = rt.remove_images(&["x".to_string()], false);
    let _ = rt.stop_vm();
    let _ = rt.reset_vm();
    let _ = rt.restart_container_engine();
    assert_eq!(count() - s, 0, "passthrough must not touch lock");
}

#[test]
#[serial_test::serial]
fn transaction_with_many_inner_ops_acquires_once() {
    let (rt, _) = MockRuntimeBuilder::new().build();

    let s = count();
    rt.transaction("tx", |inner| {
        inner.compose_down("tx")?;
        inner.compose_up_recreate("tx")?;
        inner.compose_validate("tx")?;
        Ok(())
    })
    .unwrap();
    assert_eq!(count() - s, 1, "reentrant inner ops must not re-acquire");
}

#[test]
#[serial_test::serial]
fn different_projects_acquire_independently() {
    let (rt, _) = MockRuntimeBuilder::new().build();

    let s = count();
    rt.compose_down("alpha").unwrap();
    rt.compose_down("beta").unwrap();
    assert_eq!(count() - s, 2, "two different projects must acquire twice");
}
