# Containers

Speedwave uses OCI containers (via nerdctl) for isolation and reproducibility. Each project gets its own network and set of containers.

## Container Topology

Each project runs an isolated set of containers on a dedicated network:

```
speedwave_<project>_network
├── speedwave_<project>_claude      # Claude Code — no tokens, no container socket
├── speedwave_<project>_mcp_hub     # MCP Hub (port 4000) — ONLY MCP server Claude sees
│   ├── search_tools                # Discovers OS tools alongside Slack, GitLab, etc.
│   ├── execute_code                # os.listReminders(), os.createEvent(), etc.
│   └── HTTP bridge                 # Routes to mcp-os on host via WORKER_OS_URL
└── speedwave_<project>_mcp_<service>  # Per-service workers (own tokens only)
```

- The Claude container has **no tokens** and **no container socket** — it communicates only with the MCP Hub
- Each MCP worker mounts only its own service credentials at `/tokens` (read-only)
- The Hub has **zero tokens** and acts as a router

## Compose Template

`containers/compose.template.yml` is the **SSOT** for container definitions:

- `render_compose()` in `crates/speedwave-runtime/src/compose.rs` generates per-project compose files from the template
- Never hand-edit generated compose files — modify the template instead
- Plugin services are merged into the compose document by `compose.rs`

## Resource Limits

Container limits are the resource SSOT in Rust (not the compose template, which
carries only placeholders the renderer fills — see ADR-068):

- **Claude container:** fixed **6 GiB** cap on every platform/host size. Claude Code needs 4 GB+ officially and its process is light (heavy compute is server-side), so a fixed cap is generous and immune to drift when workers are added. (`resources.rs::CLAUDE_MEMORY_GIB`)
- **MCP Hub:** 512 MiB, `cpus: 1.0` (on the path of every request, does real CPU work)
- **MCP workers:** 128 MiB / `cpus: 0.5` each (`resources::STANDARD_WORKER_RESOURCES`), except:
  - `mcp-github` — 256 MiB (Octokit + throttling/retry plugins + `octokit.paginate` buffering full result sets OOM-kills a 128 MiB cap on a busy repo)
  - `mcp-office` — 1 GiB / `cpus: 1.0`; LibreOffice headless needs the headroom. Internal-only network (no egress) — see ADR-055
  - `mcp-playwright` — 2048 MiB / `cpus: 2.0` + 2 GiB shm (Chromium IPC)

Container limits are **ceilings, not reservations** — the limit sum may exceed
the VM (overcommit is fine) as long as live usage does not. Only the always-on
set (Claude + hub) is asserted to fit the smallest supported VM.

**Minimum requirement:** 16 GiB RAM (`resources::MIN_SUPPORTED_HOST_GIB`). At 16 GiB the VM is sized to 8 GiB, which fits the always-on set (Claude's 6 GiB cap + hub) without overcommit; a smaller host would size the VM below Claude's cap and risk an OOM. Speedwave warns at startup if the host has less than 16 GiB.

The SSOT spans two files (ADR-068 §3): always-on limits + VM sizing in
`crates/speedwave-runtime/src/resources.rs`; per-worker limits on
`consts::McpServiceDescriptor.resources`; the plugin default/cap envelope in
`consts.rs`. A drift test (`compose::tests::resources_render_from_ssot`) enforces
template ↔ SSOT parity.

### Adaptive VM sizing (macOS — Lima VM)

Only the **VM** is host-adaptive; the Claude container cap is fixed (above). The
VM never takes more than 50% of host RAM/cores:

| Host RAM / cores | Lima VM RAM   | Lima VM vCPUs |
| ---------------- | ------------- | ------------- |
| 16 GiB / 8       | 8 GiB (floor) | 4 (floor)     |
| 32 GiB / 16      | 16 GiB        | 8 (cap)       |
| 64 GiB / 24      | 32 GiB (cap)  | 8 (cap)       |

Formulas: VM RAM = `(host_ram / 2).clamp(8, 32)`, VM vCPUs = `(host_cores / 2).clamp(4, 8)`. The 8 GiB RAM floor matches the 16 GiB minimum host (a sub-minimum host still floors at an 8 GiB VM so the always-on set fits).

### Windows (WSL2)

WSL2 sizing is **deliberately unmanaged** (ADR-068 §4): WSL2 schedules CPU
dynamically and defaults the VM to half host RAM, and `.wslconfig` is a global,
user-owned file shared with Docker Desktop. Speedwave does not set
`memory`/`processors` there. The Claude container's fixed 6 GiB cap applies on
Windows too.

### Migration

On upgrade, `ensure_lima_vm_config()` regenerates `lima.yaml` from the SSOT
template (macOS only) when the VM memory, vCPU count, or VPN netplan drop-in
drifts from the current formulas. `lima.yaml` is treated as a generated file —
user hand-edits are not preserved (ADR-068). The migration stops the VM, rewrites
both source and instance config, and restarts — no VM recreation.

Existing projects receive the new Claude container memory limit on next container start (when `render_compose()` generates a fresh compose.yml), not immediately on upgrade.

## Image Build

- Containerfiles live in `containers/` (e.g., `Containerfile.claude`) and in individual MCP server directories (e.g., `mcp-servers/hub/Containerfile`, `mcp-servers/slack/Dockerfile`)
- `scripts/bundle-build-context.sh` bundles MCP sources into Tauri resources for Desktop builds
- The `IMAGES` constant in `crates/speedwave-runtime/src/build.rs` must stay aligned with `scripts/bundle-build-context.sh`
- All binary downloads in Containerfiles are **SHA256-verified** for supply chain security

### Lazy build of enabled images (ADR-057)

Builds are scoped to what the user actually runs:

- `build::enabled_images(integrations)` returns `claude` + `mcp-hub` always, plus the worker image for each enabled built-in MCP integration. Plugin images go through `plugin::ensure_plugin_images(rt, enabled_plugin_service_ids)`.
- The same per-project predicate (`is_service_enabled`) drives the hub's `ENABLED_SERVICES` env var — `compose::enabled_hub_service_ids` and `build::enabled_images` are the SSOT for "enabled". Build- and compose-filtering can't drift.
- **Reconcile and setup build only the active project's enabled set.** On a fresh setup with no active project, only claude + mcp-hub are built.
- **Enabling an integration in a running project triggers a single-image build on demand** (`integrations_cmd::ensure_project_images_built` → `build::build_missing_images`). The build is part of the existing "Restarting containers…" wait; on failure the just-enabled integration is rolled back to `enabled: false` and the prior containers keep running.
- **Project switch runs the same lazy build for the destination project** before `compose_up`, so switching to a project whose integrations weren't yet built never fails with `no such image`. The build is part of the "Switching project…" wait.
- `images_exist(rt, integrations)` checks only images that should exist for the given set, so disabled integrations don't force a phantom rebuild at reconcile time.
- After each reconcile and every successful `restart_integration_containers`, `prune_orphan_current_bundle_images` force-removes worker tags that the **active project** no longer enables (`enabled_images(active)`). Per-project scope: switching to another project that needs the pruned image triggers a lazy build during the switch.
- Pruning is unchanged: `prune_old_bundle_images` still `rmi`s every catalogue tag for the old bundle id; `rmi` of an absent tag is a no-op.

### Image pruning on update

When the bundle ID changes (app version bump or build-context change), disk space is reclaimed in two steps **after** the new image set has been built (atomicity: the previous bundle's images stay on disk until the new build succeeds, so a partial failure leaves a known-good set to fall back to):

1. The previous bundle's tagged images (one per `build.rs::IMAGES` entry) are removed via `nerdctl rmi`, reclaiming several GiB.
2. BuildKit build cache is pruned via `nerdctl builder prune --all --force`, reclaiming an additional ~5–15 GiB of transient layers from `--mount=type=cache` steps.

This two-step cleanup frees the Lima VM diffdisk (50 GiB cap) once the new build has succeeded, removing the now-superseded previous bundle.

Both update paths perform this pruning:

- **Desktop** (`reconcile_bundle_update_inner` in `desktop/src-tauri/src/reconcile.rs`) — calls `build::build_images_for_bundle` for the active project's enabled set first, restores projects, then prunes (`should_prune_bundle` → `prune_old_bundle_images`) after `ProjectsRestored`
- **CLI** (`update_containers` in `crates/speedwave-runtime/src/update.rs`) — builds via `build::build_images_for_bundle` for the current project's enabled set first, then prunes via `maybe_prune_previous_bundle`

The guard condition is: `applied_bundle_id` exists **and** differs from the new bundle ID. Fresh installs (no `applied_bundle_id`) and rebuilds without a version change produce no prune call.

Failure to prune is warn-only and never blocks the update — the build proceeds regardless.

## Dynamic Port Reconciliation (mcp-os)

The mcp-os process runs on the host (not in a container) and binds to a dynamic port at startup. When the Desktop app starts — or when the mcp-os watchdog respawns a crashed process — the new port may differ from the `WORKER_OS_URL` baked into the running compose configuration.

`reconcile_compose_port` runs in a background thread to fix this:

1. Reads the current mcp-os port from the unified lock file `~/.speedwave/mcp-os.lock.json` (`consts::MCP_OS_LOCK_FILE`) via `host_mcp_process::lock::read`
2. Reads the active compose file and checks `WORKER_OS_URL` for a matching port
3. If the port is stale, regenerates the compose YAML via `render_compose()`, runs the security check, and saves the new compose file
4. Calls `compose_up_recreate` to recreate containers with the updated `WORKER_OS_URL`
5. Emits a `containers_reconciled` Tauri event to notify the frontend

This ensures the MCP Hub always routes OS integration requests to the live mcp-os instance, even after process restarts.

## Dynamic Port Reconciliation (oauth worker)

The host-side `oauth` worker (ADR-060) follows the same pattern as `mcp-os`. It binds to a dynamic loopback port on startup; the watchdog respawns it on liveness failure, picking a fresh ephemeral port each time. OAuth-consuming workers (currently SharePoint) read this port from `WORKER_OAUTH_URL` baked into compose env.

When the watchdog respawns the oauth worker it:

1. Stops and re-runs `OauthProcess::spawn_in`, getting a new port.
2. Adds the project to a `respawned` list (built under the worker map's mutex, then drained outside it).
3. Calls `host_exec_cmd::recreate_project_containers_if_running` for each respawned project — wrapped in `std::panic::catch_unwind` so a single bad project does not silently kill the watchdog thread.
4. `recreate_project_containers_if_running` regenerates the compose YAML via `render_compose()`, runs the security check, and recreates the project's containers — they pick up the new `WORKER_OAUTH_URL` in env.

The `is_oauth_alive` TCP probe retries 3 × with a 200 ms backoff before declaring a worker dead, because every false-positive respawn cascades into a full container recreate of every OAuth consumer.

## Reconcile Guard (Image Readiness)

When Speedwave detects a bundle change (e.g. after an app update), it rebuilds container images in a background thread (`reconcile_bundle_update`). During this time, any operation that starts containers (`start_containers`, `add_project`, `recreate_project_containers`, `switch_project`) will block via `ensure_images_ready()` until images are ready.

The mechanism uses a `Condvar` with tri-state `ImageReadiness` (`Ready`, `Building`, `Failed`):

- **Before reconcile spawn**: state set to `Building`
- **After images built**: state set to `Ready`, all waiters unblocked
- **On error or panic**: state set to `Failed`, all waiters unblocked with error
- **Scope guard**: ensures `Building→Failed` transition even if the reconcile thread panics

The Desktop frontend shows a unified blocking overlay in the Shell component while containers are not ready (checking, starting, switching, rebuilding states).

## Per-Project Compose Transaction Lock (ADR-066)

Every compose-touching operation (`compose_up`, `compose_down`, `compose_ps`, `compose_up_recreate`, `compose_logs`, `compose_validate`) goes through `LockedRuntime` — the public wrapper returned by `detect_runtime()`. The wrapped `ContainerRuntime` trait is `pub(crate)`; no caller outside `speedwave-runtime` can hold a raw `Box<dyn ContainerRuntime>`. This is enforced by `tests/ssot_enforcement.rs`.

`LockedRuntime::transaction(project, |rt| { ... })` is the canonical API for multi-step sequences (`save_snapshot → build → compose_down → render/save → compose_validate → compose_up_recreate → rollback`). Reentrant: inner compose ops on the same project skip re-acquisition via a `thread_local` marker.

The lock has two layers:

1. **In-process** — `Arc<Mutex<()>>` per project, interned in a static `HashMap`. Serialises threads cheaply (no syscall).
2. **Cross-process** — `fs2::FileExt::lock_exclusive` on `<data_dir>/compose/<project>/compose.lock`. Serialises Desktop against CLI (`speedwave update`) and other Desktop instances. RAII via `FileLockGuard::drop` — released on panic.

Per-project granularity: different projects never block each other; the same project serialises across threads and processes.

## VM-side Compose Validation

After every `save_compose`, transactions call `compose_validate_with_retry(rt, project)` which runs `nerdctl compose -f <file> -p <project> config --quiet` inside the VM/distro. This catches virtiofs/9p propagation lag — the host atomic-write succeeded but the engine still sees stale or torn YAML.

Retries on errors matching `is_propagation_error` (all lowercased): `"undefined network"`, `"invalid compose project"`, plus the schema/parse symptoms of a torn read — a truncated scalar makes compose-go report the field as the wrong type (`networks.<n>.driver`, `deploy.resources.limits.cpus`, `deploy.resources.limits.memory`) and a mid-line cut makes libyaml's scanner emit `"could not find expected"` / `"did not find expected"`. Capped exponential backoff: 100/200/400/800/1600 ms between attempts, doubling each retry up to `COMPOSE_VALIDATE_MAX_DELAY_MS` = 1600 ms. Max `COMPOSE_VALIDATE_MAX_ATTEMPTS` = 6 attempts. Non-propagation errors propagate immediately.

The error-fragment strings are SSOT'd as `compose::UNDEFINED_NETWORK_ERROR_FRAGMENT`, `compose::INVALID_COMPOSE_PROJECT_ERROR_FRAGMENT`, and `compose::COMPOSE_SCHEMA_VALIDATION_ERROR_FRAGMENTS` (the torn-field / scanner symptoms above), shared between the host-side `validate_compose_network_refs` (which emits the network fragment) and `runtime::is_propagation_error` (which recognises them). The `deploy.resources.limits.cpus` case was surfaced in production by `mcp-office`.

## Network Cleanup (compose_down)

`compose_down_and_cleanup` calls `force_remove_project_containers` followed by `force_remove_project_networks` — containers must be removed first because nerdctl refuses to drop a network with attached containers. Cleanup is best-effort: failures are logged at `warn!` (not `debug!`, since an orphan network blocks the next `compose_up`).

The shared algorithm lives in `runtime::force_remove_project_networks_with_run_fn`, parameterised on a run closure: Lima wraps each `nerdctl network ls / rm` call in `retry_on_eof` for transient VM-shell EOF on macOS sleep/resume; WSL calls the runner directly.

## Container Recovery

Speedwave auto-recovers from two container failure modes:

### Stale containers (post-sleep/resume)

After macOS sleep/resume the Lima VM's virtiofs/9p mounts can become stale while containers remain "running" in containerd state. Any `nerdctl exec` into such a container triggers runc's `verifyCwd()` security check (CVE-2024-21626), which rejects the operation:

```
OCI runtime exec failed: … current working directory is outside of container
mount namespace root -- possible container breakout detected
```

### Missing containers (after containerd restart/VM recreation)

After a containerd reinstall, VM recreation, or other event that wipes container state, containers no longer exist despite `setup_state.json` reporting them as started. The exec probe detects "no such container" errors and triggers the same recovery path.

### Recovery flow

1. Before each interactive exec (CLI) or chat session start (Desktop), a lightweight probe runs `nerdctl exec <container> true`
2. If the probe fails with a stale-mount or missing-container error, `compose_up_recreate()` force-recreates all project containers
3. A second probe verifies the fix succeeded
4. If recovery fails, the user sees an actionable message ("Please restart Speedwave")
5. `start_containers()` additionally verifies exec health before marking `containers_started = true` in setup state

The recovery logic is in `ensure_exec_healthy()` (`crates/speedwave-runtime/src/runtime/mod.rs`), called from three sites: CLI (`main.rs`), auth check (`check_claude_auth` in `setup_wizard.rs`), and container start (`start_containers` in `setup_wizard.rs`). The Desktop chat path (`chat.rs`) does **not** call it directly — `ChatSession::start` requires the caller to have already verified health (e.g. via `check_claude_auth`) and skips the check to avoid double health-checks.

### Missing images (reconcile-time detection)

At startup, `reconcile_bundle_update` verifies that the expected container images exist for the active project even when the bundle ID has not changed. If any of those images are missing (e.g. containerd was reinstalled), the reconcile forces a rebuild of the active project's enabled set before setting `IMAGES_READY = Ready`. Disabled-integration images are intentionally absent under lazy builds (ADR-057) and don't trigger a rebuild.

## VM Lifecycle on Exit

When the Desktop app exits, Speedwave stops the underlying VM (where applicable) to free RAM and system resources.

### macOS (Lima VM)

The Lima VM reserves 8–32 GiB of RAM for the lifetime of the process (`desired_vm_memory_gib` = `(host_ram / 2).clamp(8, 32)`, per the adaptive table above) — QEMU/VZ does not support memory ballooning, so this RAM is not returned to the system while the VM is running. On app exit, `LimaRuntime::stop_vm()` runs `limactl stop --force <vm_name>` with a 30s timeout.

- **Next startup:** `ensure_ready()` detects the stopped VM and runs `limactl start` automatically. Startup is ~10–20s slower due to VM cold boot.
- **If the process is force-killed during `limactl stop`:** The VM may be left in a `"Stopping"` state. `ensure_ready_inner()` on next launch polls until the VM finishes stopping, then starts it — no user intervention required.
- **Cleanup is non-blocking:** All exit cleanup (VM stop, IDE Bridge, mcp-os) runs in a spawned background thread. The Tauri event loop is not blocked.
- **Per-project `compose_down` is skipped on macOS:** the VM poweroff reaps every container in one shot; calling `compose_down` would add ~10 s per project of nerdctl's hard-coded graceful-stop timeout. The full macOS exit sequence is just `limactl stop --force` (hard Apple Virtualization Framework VM poweroff, typically under a second).

### Windows (WSL2)

`stop_vm()` is a no-op for `WslRuntime`. Running `wsl --terminate Speedwave` would stop all processes in the WSL2 distro — including workloads unrelated to Speedwave. Windows manages WSL2 memory via the hypervisor; Speedwave does not control the distro lifecycle. Because `stop_vm()` is a no-op, containers are stopped via per-project `compose_down` on app exit. Without it, containers would survive in the `Speedwave` distro until the next Windows boot or manual `wsl --shutdown`.

### Signal handling

SIGTERM and SIGINT (and `SetConsoleCtrlHandler` on Windows) are handled by the `ctrlc` crate. The signal handler calls `run_exit_cleanup()`, which is guarded by `CLEANUP_ONCE` — the cleanup body runs exactly once across all three call sites:

1. **Signal handler** (`ctrlc::set_handler`) — SIGTERM/SIGINT
2. **`WindowEvent::Destroyed`** — main window destroyed (app closed without tray)
3. **`RunEvent::ExitRequested`** — tray menu "Quit", macOS Cmd+Q / app-menu "Quit", or SIGTERM via the Tauri runtime (paths where the main window is hidden rather than destroyed)

## See Also

- [ADR-001: Eliminate Docker Desktop](../adr/ADR-001-eliminate-docker-desktop.md)
- [ADR-008: No Background Daemon](../adr/ADR-008-no-background-daemon.md)
- [ADR-017: Claude Code in Container via entrypoint.sh](../adr/ADR-017-claude-code-in-container-via-entrypoint.md)
