//! Static enforcement of the LockedRuntime SSOT contract: `ContainerRuntime` stays `pub(crate)`,
//! `with_project_compose_lock` is never re-exported, `detect_runtime()` returns `LockedRuntime`.

#[test]
fn trait_container_runtime_is_pub_crate() {
    let src = include_str!("../src/runtime/mod.rs");
    assert!(
        src.contains("pub(crate) trait ContainerRuntime"),
        "ContainerRuntime trait must be pub(crate) — downstream must not see it"
    );
    assert!(
        !src.contains("\npub trait ContainerRuntime"),
        "ContainerRuntime must not be `pub trait` — only LockedRuntime is the public entry point"
    );
}

#[test]
fn with_project_compose_lock_is_not_publicly_reexported() {
    let src = include_str!("../src/runtime/mod.rs");
    assert!(
        !src.contains("pub use compose_locks::with_project_compose_lock"),
        "with_project_compose_lock must not be re-exported — use LockedRuntime::transaction()"
    );
}

#[test]
fn compose_locks_module_is_not_publicly_exported() {
    let src = include_str!("../src/runtime/mod.rs");
    assert!(
        src.contains("pub(crate) mod compose_locks"),
        "compose_locks module must be `pub(crate) mod` — its `with_project_compose_lock_in` function \
         would otherwise be reachable from downstream code and bypass LockedRuntime"
    );
    assert!(
        !src.contains("\npub mod compose_locks"),
        "compose_locks must not be `pub mod` — downstream must use LockedRuntime::transaction()"
    );
}

#[test]
fn lima_and_wsl_modules_are_not_publicly_exported() {
    let src = include_str!("../src/runtime/mod.rs");
    assert!(
        src.contains("pub(crate) mod lima"),
        "lima module must be `pub(crate) mod` — concrete implementation, not API"
    );
    assert!(
        src.contains("pub(crate) mod wsl"),
        "wsl module must be `pub(crate) mod` — concrete implementation, not API"
    );
}

#[test]
fn detect_runtime_returns_locked_runtime() {
    let src = include_str!("../src/runtime/mod.rs");
    assert!(
        src.contains("pub fn detect_runtime() -> LockedRuntime"),
        "detect_runtime() must return LockedRuntime — never Box<dyn ContainerRuntime>"
    );
}

#[test]
fn locked_runtime_has_no_public_inner_accessor() {
    let src = include_str!("../src/runtime/locked.rs");
    assert!(
        !src.contains("pub fn inner(") && !src.contains("pub(crate) fn inner("),
        "LockedRuntime must not expose its `inner: Box<dyn ContainerRuntime>` field — \
         all access goes through wrapper methods"
    );
    assert!(
        !src.contains("pub fn new_for_test("),
        "LockedRuntime must not expose `new_for_test` — use MockRuntimeBuilder instead"
    );
}
