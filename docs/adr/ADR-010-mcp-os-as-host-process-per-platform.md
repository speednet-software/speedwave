# ADR-010: mcp-os as Host Process Per Platform

> **Status:** Accepted (Windows bind revised by [ADR-079](ADR-079-wsl2-mirrored-container-host-relay.md))
> **Context:** Native OS integrations (Calendar, Mail, Reminders, Notes, Outlook) need host-only APIs that an isolated container cannot reach.
>
> **Update (ADR-079):** the "Windows binds the WSL vEthernet adapter IP" claim below holds only under **NAT** networking. Under **mirrored** networking (the default) the worker binds `127.0.0.1` and containers reach it via a guest-side `socat` relay; `host_bind_address()` returns the adapter IP only in NAT mode.

## Decision

mcp-os runs as a **host process** spawned by the Speedwave Desktop app, not in a container. It exposes native OS integrations over local HTTP and is implemented per platform: macOS via Swift CLIs (AppleScript / EventKit[^1]), Windows via a Rust binary (`windows-rs`[^2] WinRT + `mapi-rs`[^3] for Outlook). Claude never talks to mcp-os directly — the MCP Hub proxies requests.

| Platform | Technology                            | Status            |
| -------- | ------------------------------------- | ----------------- |
| macOS    | AppleScript / EventKit via Swift CLIs | Implemented       |
| Windows  | WinRT + mapi-rs (Outlook)             | To be implemented |

## Why

- WinRT/MAPI (Windows) and AppleScript/EventKit (macOS) are **host-only APIs** — inaccessible from inside an isolated container, so running mcp-os on the host is the only correct approach.
- On macOS, AppleScript/EventKit is the only stable path to Reminders, Calendar, Mail, and Notes.
- On Windows, `mapi-rs`[^3] provides Outlook access via MAPI COM and `windows-rs`[^2] provides WinRT bindings for the Calendar and Mail apps.
- The "per-platform" in the title refers to this host-side process/native-API split (Lima VM on macOS vs WSL2 on Windows), not to any network alias.

## Network model

- mcp-os binds a **dynamically allocated port**, not a fixed one. The manager spawns Node with `PORT=0`; Node lets the OS pick a free port, announces it as a `{"port":N}` JSON line on stdout, and the manager persists it in `mcp-os.lock.json`. There is no fixed mcp-os port constant in production code.
- The bind address is platform-split. macOS binds `127.0.0.1`; Windows binds the WSL vEthernet adapter IP (WSL2 mirrored-mode loopback is broken[^4]). The worker's listen host comes from `compose::host_bind_address()`, never a hardcoded loopback literal.
- Containers cannot reach the host's `127.0.0.1` directly, so both platforms use the canonical gateway alias `host.docker.internal`, injected into each consuming container's `/etc/hosts` via Compose `extra_hosts` (statically for `claude` and `mcp-playwright`, dynamically for `mcp-hub` and OAuth consumers via `ensure_host_gateway_extra_host`).
- The alias resolves to the per-platform gateway IP — Lima vzNAT static `192.168.5.2` on macOS (`consts::LIMA_VZ_HOST_IP`); on Windows the gateway IP is detected at runtime by parsing `wsl.exe -d <distro> -- sh -c 'ip -4 route show default'` (no hardcoded Windows gateway literal exists).
- `render_compose()` injects `WORKER_OS_URL=http://host.docker.internal:<port>` into the `mcp-hub` container, where `<port>` is the dynamic port read from `mcp-os.lock.json`.
- Containerized MCP servers (hub, slack, redmine, etc.) bind `0.0.0.0` **inside their containers** — correct and necessary so peers on the same bridge network can reach them; their ports are published to the host as `127.0.0.1:<port>`. The "never 0.0.0.0" rule applies only to mcp-os because it runs on the host network.

## Security

- **Bearer token auth:** a per-session token (`MCP_OS_AUTH_TOKEN`) is injected at spawn; every mcp-os request must carry it, so other host processes cannot reach the endpoint.
- **No LAN exposure:** mcp-os never binds `0.0.0.0`; it listens only on the host loopback (macOS) or the WSL adapter IP (Windows), neither of which is reachable from the LAN.
- **Container isolation preserved:** containers reach mcp-os through gateway routing (`host.docker.internal`), not by sharing the host network namespace.
- Follows OWASP Docker hardening[^5] for the containerized side: `cap_drop: ALL`, `no-new-privileges`, read-only root filesystem + `tmpfs /tmp:noexec,nosuid`, and per-container CPU/memory limits.

## Where it lives in code

- Process manager (spawn `PORT=0`, lock-file persistence, liveness probe) — `crates/speedwave-runtime/src/mcp_os_process.rs` and the generic `crates/speedwave-runtime/src/host_mcp_process/process.rs` (`{"port":N}` stdout handshake).
- mcp-os Node worker (reads `PORT`, announces the OS-assigned port on stdout) — `mcp-servers/os/src/index.ts`.
- Hub URL injection / lock-port read — `crates/speedwave-runtime/src/compose.rs` (`apply_mcp_os_config_in`, `read_lock_port`, `worker_gateway_url`).
- Host addressing SSOT (gateway IP + bind address, platform split) — `crates/speedwave-runtime/src/compose.rs` (`host_gateway_ip`, `host_bind_address`).
- Gateway alias + Lima host IP constants — `crates/speedwave-runtime/src/consts.rs` (`HOST_GATEWAY_ALIAS`, `LIMA_VZ_HOST_IP`).
- macOS native helpers — `native/macos/{calendar,mail,reminders,notes}/`; Windows placeholder — `native/windows/README.md`.

## References

- [ADR-062: playwright host-gateway access (static extra_hosts)](ADR-062-playwright-host-gateway-access.md)

[^1]: [Apple EventKit - Calendar and Reminders](https://developer.apple.com/documentation/eventkit)

[^2]: [microsoft/windows-rs - Rust for Windows](https://github.com/microsoft/windows-rs)

[^3]: [microsoft/mapi-rs - Rust bindings for Outlook MAPI](https://github.com/microsoft/mapi-rs)

[^4]: [microsoft/WSL#11312 - mirrored mode loopback (127.0.0.1) connectivity broken](https://github.com/microsoft/WSL/issues/11312)

[^5]: [OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)
