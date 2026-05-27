# ADR-066: LockedRuntime — per-project compose transaction lock

## Status

Accepted.

## Context

Speedwave v0.12.0 hit a production-only race condition: concurrent compose operations on the same project produced `nerdctl-compose: service "X" refers to undefined network speedwave_<project>_network: invalid compose project` errors after updates and project switches. Multiple callers — `start_chat`, `resume_conversation`, `restart_integration_containers`, `reconcile_compose_port`, `recreate_project_containers_if_running`, `update_containers`, `setup_wizard::start_containers`, `main.rs::switch_project` — would race on `compose_down → render/save → compose_up_recreate`. The previous protection (a global `Arc<Mutex<()>>` named `ComposeLock` in Tauri state) had three defects:

1. **Process-local only** — could not serialize the Desktop process against a concurrent `speedwave update` CLI invocation on the same project.[^1]
2. **Coarse-grained** — blocked every project's compose ops on every other project's compose op.
3. **Optional** — a new caller could acquire the runtime directly via `detect_runtime() -> Box<dyn ContainerRuntime>` and bypass the lock entirely; the type system did not enforce serialisation.

The first symptom (cross-process race) was the reproducible production bug. The third defect (no enforcement) was the structural cause: every new code path was one missed `compose_lock.lock()` away from breaking the invariant.

## Decision

Introduce `LockedRuntime` as the sole public runtime handle, wrapping the existing `Box<dyn ContainerRuntime>` and forcing every compose-touching operation through a per-project lock. The `ContainerRuntime` trait becomes `pub(crate)` so external callers cannot bypass the wrapper.

### Lock architecture (two layers)

Defined in `crates/speedwave-runtime/src/runtime/compose_locks.rs`:

1. **In-process `Mutex` per project** — an `Arc<Mutex<()>>` keyed by project name in a `LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>>`. Serialises threads within one process cheaply (no syscall).
2. **Cross-process file lock** — `fs2::FileExt::lock_exclusive` on `<data_dir>/compose/<project>/compose.lock`.[^2] Serialises against CLI invocations and other Desktop instances. The file handle is held by a `FileLockGuard` with a `Drop` impl that calls `unlock` — panic-safe.

Per-project granularity: different projects never block each other; the same project serialises across threads **and** across processes.

### Type-level enforcement

- `pub(crate) trait ContainerRuntime` — cannot be named, implemented, or held as `Box<dyn _>` from outside `speedwave-runtime`.
- `pub struct LockedRuntime { inner: Box<dyn ContainerRuntime> }` — the only type external callers can hold. All compose-touching methods (`compose_up`, `compose_down`, `compose_ps`, `compose_up_recreate`, `compose_logs`, `compose_validate`) wrap their call in `with_acquired(project, || ...)`. Non-compose methods (`is_available`, `ensure_ready`, `container_exec`, `build_image`, `image_exists`, `vm_exec`, etc.) are passthrough.
- `pub fn detect_runtime() -> LockedRuntime` — the only public factory. `LockedRuntime::new` is `pub(crate)`.

### Reentrancy via `thread_local`

Multi-step transactions (`save_snapshot → build_image → compose_down → render_and_save_compose → compose_validate → compose_up_recreate`) need to hold the lock across many calls without deadlocking on inner compose ops. `with_acquired` uses a `thread_local!` `HELD_LOCKS: RefCell<HashSet<String>>` to detect whether the current thread already holds the lock for `project`. If yes, the inner call passes through without re-acquiring. `LockedRuntime::transaction(project, |rt| ...)` is the canonical multi-step API.

A `HeldGuard` struct with a `Drop` impl removes the project from `HELD_LOCKS` on every exit path including panic, mirroring the `FileLockGuard` pattern.

### Test infrastructure

`ContainerRuntime` is `pub(crate)` — downstream tests cannot implement it. The `runtime::mock_runtime` module (gated `#[cfg(any(test, feature = "test-support"))]`) provides `MockRuntimeBuilder` with `MockHandles` for assertion. Cargo feature `test-support = []` in `speedwave-runtime/Cargo.toml`; desktop dev-dependencies enable it. All inline `impl ContainerRuntime for X` mocks across `build.rs`, `plugin.rs`, `slash.rs`, `update.rs`, `runtime/mod.rs`, `containers_cmd.rs`, `reconcile.rs`, `setup_wizard.rs` were replaced by a single builder API.

### Compose validation (defence in depth, two layers)

- **Host-side**: `compose::save_compose` calls `validate_compose_network_refs` on the in-memory YAML before writing, and again on the on-disk content after the atomic rename. Catches torn-write / undeclared-network bugs at the source.
- **VM-side**: every transaction calls `compose_validate_with_retry(rt, project)` after save, which invokes `nerdctl compose -f <file> -p <project> config --quiet` inside the VM/distro. Retries on transient virtiofs/9p propagation lag (errors matching `"undefined network"` or `"invalid compose project"`) with 100/200 ms backoff before bailing.[^3]

### Network cleanup (orphan reclaim)

`compose_down_and_cleanup` adds `force_remove_project_networks` after `force_remove_project_containers` — nerdctl-compose left orphan networks after bundle changes, and a stale network blocks the next `compose up`.[^4]

## Consequences

### Positive

- Production race fixed: cross-process serialisation makes Desktop+CLI compose ops safe.
- Type-system enforced: external code cannot bypass the lock. `tests/ssot_enforcement.rs` pins this via source-string assertions (`pub(crate) trait ContainerRuntime`, `pub(crate) mod lima`, `pub(crate) mod wsl`, `pub(crate) mod compose_locks`).
- Reentrancy lets multi-step transactions stay readable: callers write `rt.transaction(p, |rt| { rt.compose_down(p); ...; rt.compose_up_recreate(p) })`.
- Mock test infrastructure consolidated: ~700 lines of inline mock structs replaced by one builder.
- Network cleanup eliminates a class of "compose up after bundle change" failures.

### Negative

- Public API change. All callers of `detect_runtime()` previously held `Box<dyn ContainerRuntime>`; they now hold `LockedRuntime`. Migration touched ~30 function signatures across desktop and cli. Trade-off accepted: the API change is what gives the type-system enforcement.
- Slight latency cost: `compose_validate_with_retry` adds a `nerdctl compose config --quiet` round-trip into the VM on every transaction. Measured cost is dominated by `limactl shell` startup (the validation itself is microseconds). Acceptable for the diagnostic benefit.
- Test-only `pub fn lock_acquisitions_for_test()` and `with_project_compose_lock_in_for_test()` are exposed under the `test-support` feature so integration tests can assert acquisition counts and cross-process behaviour without re-opening the trait surface.

### Risks accepted

- `IN_PROCESS_LOCKS` HashMap grows monotonically per distinct project ever seen. Desktop is single-user with ≤100 projects in realistic use — acceptable cost vs. eviction complexity.
- `compose_validate_with_retry` retries on substring match (`"undefined network"`, `"invalid compose project"`). A non-propagation error containing those substrings would burn 300 ms of retries before bailing. The error is still propagated correctly.

## Alternatives considered

- **Single global `Mutex<()>`** (status quo before this ADR). Rejected: process-local only; cross-process race remained. Coarse-grained.
- **Reentrant mutex from `parking_lot`**. Rejected: adds dependency. Thread-local marker is portable, explicit, and tests cleanly.
- **Per-callsite `with_project_compose_lock(project, || ...)` blocks** without a wrapper struct. Rejected: not type-system enforced; future callers would silently bypass.
- **Cross-process advisory locks via filesystem rename**. Rejected: `fs2::FileExt::lock_exclusive` (POSIX `flock` on Unix, `LockFileEx` on Windows) is the standard library-blessed primitive for this exact purpose.

## References

[^1]: nerdctl-compose error pattern reproduced in production logs (`compose_validate: ... service "claude" refers to undefined network speedwave-dev_downloads_network: invalid compose project`).

[^2]: `fs2::FileExt::lock_exclusive` — https://docs.rs/fs2/0.4/fs2/trait.FileExt.html#method.lock_exclusive

[^3]: virtiofs propagation lag on Lima with file mode `none` (default) — https://github.com/lima-vm/lima/blob/master/docs/config/mount.md

[^4]: nerdctl-compose down does not remove networks by default — https://github.com/containerd/nerdctl/blob/main/docs/command-reference.md#compose
