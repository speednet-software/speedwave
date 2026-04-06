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
- **MCP Hub:** 256 MiB (fixed)
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

## See Also

- [ADR-001: Eliminate Docker Desktop](../adr/ADR-001-eliminate-docker-desktop.md)
- [ADR-017: Claude Code in Container via entrypoint.sh](../adr/ADR-017-claude-code-in-container-via-entrypoint.md)
