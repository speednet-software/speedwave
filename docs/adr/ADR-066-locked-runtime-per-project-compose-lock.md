# ADR-066: LockedRuntime — per-project compose transaction lock

> **Status:** Accepted
> **Context:** Concurrent compose operations on the same project (Desktop vs. CLI, or racing Desktop callers) corrupted compose state, producing "undefined network ... invalid compose project" errors after updates and project switches.

## Decision

Make `LockedRuntime` the sole public runtime handle. It wraps the now-`pub(crate)` `ContainerRuntime` trait and forces every compose-_mutating_ op through a per-project lock (in-process mutex plus a cross-process file lock). `detect_runtime()` is the only public factory; external crates can no longer name, implement, or hold a bare `Box<dyn ContainerRuntime>`, so they cannot bypass serialisation.

## Why

- The reproducible production bug was a cross-process race: the previous global `Arc<Mutex<()>>` could not serialise the Desktop process against a concurrent `speedwave update` CLI run on the same project.
- The structural cause was that the lock was _optional_ — any new caller acquiring the runtime directly was one missed lock away from breaking the invariant. Type-level enforcement removes that footgun.
- A single global mutex was also too coarse: it blocked every project's compose ops on every other project's. Per-project granularity lets different projects run in parallel while the same project serialises across threads and processes.

## How it works

- **Two lock layers (per project):** an in-process `Arc<Mutex<()>>` keyed by project name (cheap, no syscall), plus a cross-process exclusive file lock on `<data_dir>/compose/<project>/compose.lock`. Both release via RAII drop guards, so panics never leak a lock.
- **Locked vs. passthrough:** only the compose _mutations_ — `compose_up`, `compose_down`, `compose_up_recreate`, `compose_validate` — wrap their call in `with_acquired(project, …)`. The read-only queries `compose_ps` (list containers) and `compose_logs` (read logs) are passthrough, calling the inner runtime directly with no lock. All other non-compose ops (`is_available`, `ensure_ready`, `container_exec`, `build_image`, `vm_exec`, …) are passthrough too.
- **Reentrancy:** multi-step transactions (snapshot → build → down → render/save → validate → up) hold the lock across many calls. A `thread_local!` `HELD_LOCKS` set lets nested inner compose ops on the same project pass through without re-acquiring (and without deadlocking). `LockedRuntime::transaction(project, |rt| …)` is the canonical multi-step API.
- **Defence-in-depth validation:** the host writes compose via `save_compose`, which runs `validate_compose_network_refs` on the in-memory YAML before the atomic rename and again on the on-disk content after. Each transaction then runs `compose_validate_with_retry` guest-side. That retry uses capped exponential backoff (100, 200, 400, 800, 1600 ms, doubling and then capped) for up to 6 attempts — roughly a 3.1 s retry window — and only retries errors that look like virtiofs/9p propagation lag ("undefined network" / "invalid compose project"); any other error propagates immediately.
- **Network cleanup:** `compose_down_and_cleanup` also runs `force_remove_project_networks` after removing containers, because nerdctl-compose can leave orphan networks behind after a bundle change, and a stale network blocks the next `compose up`.

## Where it lives in code

- Public wrapper + locked/passthrough method split — `crates/speedwave-runtime/src/runtime/locked.rs` (`LockedRuntime`, `with_acquired`, `transaction`)
- Two-layer lock primitive — `crates/speedwave-runtime/src/runtime/compose_locks.rs` (`with_project_compose_lock`, `FileLockGuard`)
- Trait visibility + factory + validate-retry + network cleanup — `crates/speedwave-runtime/src/runtime/mod.rs` (`pub(crate) trait ContainerRuntime`, `detect_runtime`, `compose_validate_with_retry`, `force_remove_project_networks`, `compose_down_and_cleanup`)
- Host-side compose validation — `crates/speedwave-runtime/src/compose.rs` (`save_compose`, `validate_compose_network_refs`)
- Test infrastructure — `crates/speedwave-runtime/src/runtime/mock_runtime.rs` (`MockRuntimeBuilder`, gated by the `test-support` Cargo feature); inline `impl ContainerRuntime` mocks were all replaced by this one builder
- SSOT enforcement — `crates/speedwave-runtime/tests/ssot_enforcement.rs` pins `pub(crate) trait ContainerRuntime` and `pub(crate) mod {compose_locks,lima,wsl}` via source-string assertions

## Consequences

- Public API change: callers that previously held `Box<dyn ContainerRuntime>` now hold `LockedRuntime` (touched ~30 signatures across desktop and cli). Accepted — it is what buys the type-system enforcement.
- Slight latency: `compose_validate_with_retry` adds a guest-side `nerdctl compose config --quiet` round-trip per transaction; cost is dominated by VM-shell startup, not the validation itself.
- The in-process lock map grows monotonically per distinct project name ever seen. Desktop is single-user with a small project count, so eviction complexity is not worth it.

## Rejected alternatives

- **Single global `Mutex<()>`** (the status quo before this ADR): process-local only, so the cross-process race remained; also coarse-grained.
- **A `parking_lot` reentrant mutex**: adds a dependency; the thread-local marker is portable, explicit, and tests cleanly.
- **Per-callsite lock blocks without a wrapper struct**: not type-system enforced, so future callers would silently bypass it.
- **Hand-rolled advisory locks via filesystem rename**: an exclusive file lock (`flock`[^1] on Unix, `LockFileEx`[^2] on Windows) is the standard primitive for exactly this purpose.

[^1]: [flock(2) - Linux manual page](https://man7.org/linux/man-pages/man2/flock.2.html) - `LOCK_EX` places an exclusive advisory lock; only one process may hold it at a time.

[^2]: [LockFileEx function (fileapi.h) - Win32 apps, Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex) - `LOCKFILE_EXCLUSIVE_LOCK` requests exclusive access to the locked region.
