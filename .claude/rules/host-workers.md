---
paths:
  - 'desktop/src-tauri/src/bridges/**'
  - 'desktop/src-tauri/src/main.rs'
  - 'desktop/src-tauri/src/firewall.rs'
  - 'crates/speedwave-runtime/src/host_mcp_process/**'
  - 'crates/speedwave-runtime/src/mcp_os_process.rs'
  - 'crates/speedwave-runtime/src/oauth_process.rs'
  - 'crates/speedwave-runtime/src/compose/**'
  - 'crates/speedwave-cli/**'
---

# Host-Side Workers & Bridges

Host-side worker processes (oauth, mcp-os, plugin host bridges) run on the host, outside the VM. Their rules:

- **Exactly one supervisor: the Desktop app.** The CLI never spawns, respawns, health-checks-and-kills, or "cleans up" these processes — it reads their lock files / bearer tokens from disk. Two supervisors see each other's workers as stale and kill them in a loop; the symptom is workers dying with exit 137 within seconds of starting.
- **Exit 137 ≠ OOM.** `is_oom_exit` matches the signal signature only — a SIGKILL from a supervisor looks identical. Never diagnose or log 137 as OOM without corroborating memory evidence.
- **Every off-Desktop `render_compose` caller passes `compose::host_bridges_from_disk()`** — never `HostBridgesInfo::default()`. An empty bridge list re-renders the shared per-project compose without bridge env, and the next `compose up` recreates the worker, stomping the live bridge in a running Desktop session. Desktop callers use `reconcile::current_bridges_info()`.
- **New host-side WebSocket relay = a `HostBridge`** (`bridges/host_bridge.rs`, Endpoint or Pairing mode) — never a hand-rolled TCP listener / lock file / auth token. The skeleton owns the security model: loopback-or-adapter bind via `host_bind_address()`, 0o600 lock file, constant-time token compare, Origin/subprotocol policy, watchdog — plus the full mirror-relay lifecycle below.
- **WSL2 mirrored-relay lifecycle is mandatory (ADR-080):** every host listener a container must reach calls `mirror_relay::ensure_relay_for_port(port)` after bind/spawn, `remove_relay_for_port(port)` on stop, and a periodic (~30 s) watchdog re-ensure — the relay is a transient unit inside the distro; a WSL restart wipes it while the host process survives. Compose-side URLs translate via `compose::container_facing_port` automatically; a worker skipping any of the three steps is unreachable from containers under mirrored mode (the Windows default). `HostBridge` does all three internally — hand-wired workers (mcp-os, oauth) must replicate them.
- **Windows firewall before bind:** every host-listener starter calls `firewall::ensure_firewall_rule` (process-wide `Once`) before binding. The Hyper-V engine rule makes a NAT-mode WSL-adapter-IP bind reachable across the VM boundary (mirrored mode binds loopback and rides the ADR-080 relay instead); both modes need the host application allow rules to suppress the per-binary consent prompt. Rule presence on disk is the live source of truth — never persist a "user declined" state.
- **Hub → bridge auth:** the hub reaches host bridges through `HOST_GATEWAY_ALIAS` with per-project bearer tokens mounted at `/secrets/<service>-auth-token:ro`; distribution of `extra_hosts`/tokens is handled by the compose renderer — never hardcode the alias or the token path at a call site.
- Worker stdout/stderr drains through `host_mcp_process/drain.rs` (shared by mcp-os and oauth) into chmod-600 rotated logs (`log_file.rs`) — a new host worker reuses `WorkerSpec` + the drain, not a bespoke logger.
