# ADR-072: Fast project switch — SIGTERM-responsive PID1 + background teardown

## Status

Accepted

## Context

Switching projects ran `compose_down(previous)` **synchronously, before**
starting the destination project. A live measurement (13 containers, macOS
Lima, nerdctl 2.2.2) put that down at ~89 seconds, with the destination's
`compose up` taking single-digit seconds afterwards — the user stared at
"Switching project..." for the part they care least about. Two independent
costs stacked:

1. **Ignored SIGTERM.** A container's PID 1 receives no default signal
   handling — signals with default dispositions are discarded for the init
   process of a PID namespace[^1]. Speedwave's `claude` keep-alive
   (`sleep infinity`), every worker's bare `node` entry, and the playwright
   binary all installed no handler, so each container ate the full 10-second
   stop timeout[^2] before SIGKILL. Service-level `stop_grace_period` cannot
   help: `nerdctl compose down` passes empty stop options, ignoring it[^3].
2. **Sequential per-container machinery.** `compose down` stops containers
   one at a time; even with instant process exit, each stop costs seconds of
   nerdctl/network/healthcheck teardown. Thirteen containers ≈ 80-90 s
   regardless of signal handling.

## Decision

### SIGTERM-responsive PID 1 in every image

- `containers/entrypoint.sh` keep-alive traps `TERM`/`INT` and exits 0
  (`sleep` in background + `wait`, so the trap fires immediately).
- `mcp-servers/shared/src/server.ts` registers a `SIGTERM`/`SIGINT` handler
  in `start()` — one change covers all built-in workers (shared is baked
  into each image).
- `mcp-servers/playwright/Containerfile` wraps the upstream binary in
  `sh -c 'trap … & wait'` since it registers no handler itself.

Measured effect: per-container stop drops from 10 s+ to ~3 s (machinery
only). This also speeds up update, restart and quit — every `compose down`.

### Background teardown on switch

`switch_project_core` is reordered: the destination project is started
**first** (user-visible latency = `compose up` only), and the previous
project is handed back to the caller, which stops it on a detached
background thread after the switch — including chat rebind — fully
succeeds. Consequences of the reorder:

- **Failed start leaves the previous project untouched and running** — the
  restore path (`teardown_and_restore`) is gone entirely; cleanup is only
  `teardown_only(new)`.
- **Pending-teardown registry.** In-flight background teardowns are tracked
  per project; before starting a destination, `wait_for_pending_teardown`
  joins any teardown still running for it. Without this, a quick
  switch-back (A→B→A) could have the background `down(A)` kill the freshly
  started A — the per-project compose lock serialises the operations but
  does not order them.
- **Brief container overlap** of two projects is safe: resource limits are
  ceilings, not reservations (ADR-068), per-project networks are isolated,
  and no service publishes host ports (enforced by the compose security
  check).
- **Best-effort failure mode:** a failed background teardown only leaves
  idle containers; the next compose operation on that project converges
  them. Quitting the app mid-teardown leaves the previous project running
  in the VM until the next operation — accepted.

## Alternatives considered

- **Parallel stop in nerdctl** — `compose down` exposes no parallelism
  knob; upstream change out of scope.
- **`stop_grace_period` tuning in the compose template** — ignored by
  `nerdctl compose down` (empty `StopOptions`)[^3]; the fix must live in
  PID 1.
- **Keep synchronous down with a better progress UI** — still blocks the
  user ~90 s for work that does not concern them.

## Consequences

- User-perceived switch time = destination `compose up` (+ chat rebind):
  seconds instead of ~90 s+.
- Plugin workers (separate repository) vendor their own copy of
  `mcp-shared` and still lack the SIGTERM handler — each pending teardown
  may wait their 10 s timeout in the background until the vendored copy is
  re-synced (cross-repo follow-up).
- One more failure surface (background thread) — mitigated by warn-level
  logging and idempotent compose convergence.

[^1]:
    `pid_namespaces(7)` — signals with default dispositions are discarded
    when sent to the init process of a PID namespace:
    <https://man7.org/linux/man-pages/man7/pid_namespaces.7.html>

[^2]:
    nerdctl command reference, `nerdctl stop` — default 10-second grace
    period before SIGKILL:
    <https://github.com/containerd/nerdctl/blob/main/docs/command-reference.md#nerdctl-stop>

[^3]:
    nerdctl `pkg/composer/down.go` — `down` calls container stop with empty
    `StopOptions`, so per-service `stop_grace_period` is not applied:
    <https://github.com/containerd/nerdctl/blob/main/pkg/composer/down.go>
