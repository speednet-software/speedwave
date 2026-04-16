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

Container memory limits are defined in `containers/compose.template.yml`. The Claude container memory is **adaptive** based on host RAM; other services use fixed limits:

- **Claude container:** adaptive (`${CLAUDE_MEMORY}` — see scaling below)
- **MCP Hub:** 512 MiB (fixed)
- **MCP workers:** 128 MiB each (fixed)

**Minimum requirement:** 8 GiB RAM. Speedwave warns at startup if the host has less than 8 GiB.

All resource formulas live in `crates/speedwave-runtime/src/resources.rs` (SSOT).

### Adaptive scaling (macOS — Lima VM)

The Lima VM and Claude container memory scale based on host RAM. The VM never takes more than 50% of host RAM (capped at 32 GiB):

| Host RAM | Lima VM      | Claude container |
| -------- | ------------ | ---------------- |
| 8 GiB    | 4 GiB        | 4 g (floor)      |
| 16 GiB   | 8 GiB        | 4 g              |
| 24 GiB   | 12 GiB       | 8 g              |
| 32 GiB   | 16 GiB       | 12 g             |
| 64 GiB   | 32 GiB (cap) | 28 g (cap)       |

Formulas: VM = `(host_ram / 2).clamp(4, 32)`, Claude = `(vm_mem - 4).clamp(4, 28)`.

### Adaptive scaling (Linux — native nerdctl)

No VM layer. Claude container memory scales directly from host RAM with 6 GiB reserved for the OS and user applications:

| Host RAM | Claude container |
| -------- | ---------------- |
| 8 GiB    | 4 g (floor)      |
| 16 GiB   | 10 g             |
| 32 GiB   | 26 g             |
| 64 GiB   | 28 g (cap)       |

### Windows (WSL2)

Same adaptive formula as Linux. Falls back to 10 g when RAM detection fails (`host_total_memory_gib()` returns 16 on failure → 16 − 6 = 10).

### Migration

On upgrade from older versions, `ensure_lima_vm_config()` automatically migrates the VM memory on startup. The migration stops the VM, edits both the source template and instance config, and restarts — no VM recreation needed. The migration applies both upgrades and downgrades so that a reduced VM formula takes effect immediately (triggers when `current != desired`).

Existing projects receive the new Claude container memory limit on next container start (when `render_compose()` generates a fresh compose.yml), not immediately on upgrade.

## Image Build

- Containerfiles live in `containers/` (e.g., `Containerfile.claude`) and in individual MCP server directories (e.g., `mcp-servers/hub/Containerfile`, `mcp-servers/slack/Dockerfile`)
- `scripts/bundle-build-context.sh` bundles MCP sources into Tauri resources for Desktop builds
- The `IMAGES` constant in `crates/speedwave-runtime/src/build.rs` must stay aligned with `scripts/bundle-build-context.sh`
- All binary downloads in Containerfiles are **SHA256-verified** for supply chain security

### Image pruning on update

When the bundle ID changes (app version bump or build-context change), disk space is reclaimed in two steps **before** building the new image set:

1. The previous bundle's 6 tagged images are removed via `nerdctl rmi`, reclaiming ~4–6 GiB.
2. BuildKit build cache is pruned via `nerdctl builder prune --all --force`, reclaiming an additional ~5–15 GiB of transient layers from `--mount=type=cache` steps.

This two-step cleanup ensures the Lima VM diffdisk (50 GiB cap) has sufficient space for the new build.

Both update paths perform this pruning:

- **Desktop** (`reconcile_bundle_update_inner` in `desktop/src-tauri/src/reconcile.rs`) — prunes before calling `build_all_images_for_bundle`
- **CLI** (`update_containers` in `crates/speedwave-runtime/src/update.rs`) — prunes before calling `build_all_images`

The guard condition is: `applied_bundle_id` exists **and** differs from the new bundle ID. Fresh installs (no `applied_bundle_id`) and rebuilds without a version change produce no prune call.

Failure to prune is warn-only and never blocks the update — the build proceeds regardless.

## Dynamic Port Reconciliation (mcp-os)

The mcp-os process runs on the host (not in a container) and binds to a dynamic port at startup. When the Desktop app starts — or when the mcp-os watchdog respawns a crashed process — the new port may differ from the `WORKER_OS_URL` baked into the running compose configuration.

`reconcile_compose_port` runs in a background thread to fix this:

1. Reads the current mcp-os port from `~/.speedwave/mcp-os.port`
2. Reads the active compose file and checks `WORKER_OS_URL` for a matching port
3. If the port is stale, regenerates the compose YAML via `render_compose()`, runs the security check, and saves the new compose file
4. Calls `compose_up_recreate` to recreate containers with the updated `WORKER_OS_URL`
5. Emits a `containers_reconciled` Tauri event to notify the frontend

This ensures the MCP Hub always routes OS integration requests to the live mcp-os instance, even after process restarts.

## Reconcile Guard (Image Readiness)

When Speedwave detects a bundle change (e.g. after an app update), it rebuilds container images in a background thread (`reconcile_bundle_update`). During this time, any operation that starts containers (`start_containers`, `add_project`, `recreate_project_containers`, `switch_project`) will block via `ensure_images_ready()` until images are ready.

The mechanism uses a `Condvar` with tri-state `ImageReadiness` (`Ready`, `Building`, `Failed`):

- **Before reconcile spawn**: state set to `Building`
- **After images built**: state set to `Ready`, all waiters unblocked
- **On error or panic**: state set to `Failed`, all waiters unblocked with error
- **Scope guard**: ensures `Building→Failed` transition even if the reconcile thread panics

The Desktop frontend shows a unified blocking overlay in the Shell component while containers are not ready (checking, starting, switching, rebuilding states).

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

The recovery logic is in `ensure_exec_healthy()` (`crates/speedwave-runtime/src/runtime/mod.rs`), called from four sites: CLI (`main.rs`), Desktop chat (`chat.rs`), auth check (`setup_wizard.rs`), and container start (`setup_wizard.rs`).

### Missing images (reconcile-time detection)

At startup, `reconcile_bundle_update` verifies that all expected container images exist even when the bundle ID has not changed. If images are missing (e.g. containerd was reinstalled), the reconcile forces a full image rebuild before setting `IMAGES_READY = Ready`. This prevents `start_containers` from attempting `compose_up` with nonexistent images.

## VM Lifecycle on Exit

When the Desktop app exits, Speedwave stops the underlying VM (where applicable) to free RAM and system resources.

### macOS (Lima VM)

The Lima VM reserves ~9–32 GiB of RAM for the lifetime of the process — QEMU/VZ does not support memory ballooning, so this RAM is not returned to the system while the VM is running. On app exit, `LimaRuntime::stop_vm()` runs `limactl stop --force <vm_name>` with a 30s timeout.

- **Next startup:** `ensure_ready()` detects the stopped VM and runs `limactl start` automatically. Startup is ~10–20s slower due to VM cold boot.
- **If the process is force-killed during `limactl stop`:** The VM may be left in a `"Stopping"` state. `ensure_ready_inner()` on next launch polls until the VM finishes stopping, then starts it — no user intervention required.
- **Cleanup is non-blocking:** All exit cleanup (container stop, VM stop, IDE Bridge, mcp-os) runs in a spawned background thread. The Tauri event loop is not blocked.

### Linux (native nerdctl)

There is no VM layer. Containers are stopped by `compose_down`. The containerd daemon continues as a systemd user service — this matches the Docker Desktop model where containerd is always available.

### Windows (WSL2)

`stop_vm()` is a no-op for `WslRuntime`. Running `wsl --terminate Speedwave` would stop all processes in the WSL2 distro — including workloads unrelated to Speedwave. Windows manages WSL2 memory via the hypervisor; Speedwave does not control the distro lifecycle.

### Signal handling

SIGTERM and SIGINT (and `SetConsoleCtrlHandler` on Windows) are handled by the `ctrlc` crate. The signal handler calls `run_exit_cleanup()`, which is guarded by `CLEANUP_ONCE` — the cleanup body runs exactly once across all three call sites:

1. **Signal handler** (`ctrlc::set_handler`) — SIGTERM/SIGINT
2. **`WindowEvent::Destroyed`** — main window destroyed (app closed without tray, or Linux without libappindicator)
3. **`RunEvent::ExitRequested`** — tray menu "Quit", macOS Cmd+Q / app-menu "Quit", or SIGTERM via the Tauri runtime (paths where the main window is hidden rather than destroyed)

## See Also

- [ADR-001: Eliminate Docker Desktop](../adr/ADR-001-eliminate-docker-desktop.md)
- [ADR-008: No Background Daemon](../adr/ADR-008-no-background-daemon.md)
- [ADR-017: Claude Code in Container via entrypoint.sh](../adr/ADR-017-claude-code-in-container-via-entrypoint.md)
