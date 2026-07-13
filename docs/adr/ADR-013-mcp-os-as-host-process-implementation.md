# ADR-013: mcp-os as Host Process — Implementation Details

> **Status:** Accepted (Windows bind revised by [ADR-079](ADR-079-wsl2-mirrored-container-host-relay.md))
> **Context:** OS-integration APIs (Calendar, Reminders, Mail on macOS; Outlook/MAPI on Windows) are host-only and cannot be reached from inside an isolated container.
>
> **Update (ADR-079):** the "`MCP_LISTEN_HOST` = WSL vEthernet adapter IP because mirrored mode breaks `127.0.0.1`" note below holds only under **NAT** networking. Under genuine **mirrored** networking (the default) mcp-os binds `127.0.0.1` and containers reach it through a guest-side `socat` relay — so the `127.0.0.1` server-factory default is the intended mirrored bind, not a macOS-only fallback.

## Decision

mcp-os runs on the **host** (spawned by the Speedwave Desktop app), not in a container. It is a Node.js MCP worker that shells out to per-platform native CLI binaries, and it is reachable only from containers over a bearer-authenticated, loopback/adapter-bound port — never `0.0.0.0`.

## Why

- macOS AppleScript/EventKit access to Reminders, Calendar, Mail, and Notes is gated by TCC and only granted to the host process that holds the user's permission (declared in the app's `Info.plist`).
- Windows WinRT and MAPI APIs require the caller to run in the user's desktop session — impossible from an isolated container.
- Mounting host sockets into containers would break the per-worker token-isolation model from [ADR-009](ADR-009-per-project-isolation-preserved.md). Running mcp-os on the host is the only approach that preserves it.

## How it works

- mcp-os is a Node MCP server; its entry point is `mcp-servers/os/src/index.ts`.
- The actual OS work is dispatched per platform by `mcp-servers/os/src/platform-runner.ts`: on macOS (`darwin`) it runs four Swift CLI binaries (reminders, calendar, mail, notes); on Windows (`win32`) it runs a single Rust `.exe`.
- The host-side lifecycle (spawn, stale-PID cleanup, port handshake, health probe, cleanup) is owned by the runtime SSOT crate, not Desktop. `crates/speedwave-runtime/src/mcp_os_process.rs` is a thin `McpOsProcess` type alias over the generic `HostMcpProcess<McpOsSpec>` in `crates/speedwave-runtime/src/host_mcp_process/`. Desktop's `desktop/src-tauri/src/main.rs` (`ensure_mcp_os_running`) starts it via `speedwave_runtime::mcp_os_process::McpOsProcess::spawn`.
- **Port is dynamic, not fixed.** The spawner sets `PORT=0` so the OS picks a free port; the worker announces the real port as a JSON line on stdout, and it is persisted in `mcp-os.lock.json` under the data dir. `render_compose` reads that lock file to build the `WORKER_OS_URL` env var injected into the hub (`crates/speedwave-runtime/src/compose.rs`).
- **Bind host is platform-specific.** macOS binds `127.0.0.1`; on Windows the spawner injects `MCP_LISTEN_HOST` set to the WSL vEthernet adapter IP via `compose::host_bind_address()` (WSL2 mirrored mode breaks `127.0.0.1` loopback — microsoft/WSL#11312). The `127.0.0.1` default in the shared server factory (`mcp-servers/shared/src/server.ts`) is the macOS-only fallback. It never binds `0.0.0.0`.

## Security

- Bearer token auth: a UUID v4 is generated per spawn (rotated on respawn) in `host_mcp_process/process.rs` and required on every request as `Authorization: Bearer <token>`.
- No `0.0.0.0` binding — the port is reachable only by containers through platform-specific gateway routing (see [ADR-010](ADR-010-mcp-os-as-host-process-per-platform.md) for the full per-platform network model), not by the external network.

## Rejected alternatives

- **Run mcp-os inside a container and mount host sockets/IPC in.** Rejected: it would punch a hole through the container/VM isolation boundary that the whole token-isolation model (ADR-009) depends on.
