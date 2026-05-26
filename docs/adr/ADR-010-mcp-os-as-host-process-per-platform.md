# ADR-010: mcp-os as Host Process Per Platform

## Decision

mcp-os runs as a **host process** (inside the Speedwave Desktop app), not in a container. It implements native OS integrations separately per platform.

| Platform | Technology                           | Status            |
| -------- | ------------------------------------ | ----------------- |
| macOS    | AppleScript / EventKit via Swift CLI | Implemented       |
| Windows  | WinRT + mapi-rs (Outlook)            | To be implemented |

Port 4007 in dev (not 3007, to avoid v1 collision). Before public release, changed to 3007 along with other constants.

## Rationale

WinRT/MAPI (Windows) and AppleScript (macOS) are **host-only APIs** — they are inaccessible from inside an isolated container. Running mcp-os on the host is the only correct approach.

On macOS, AppleScript/EventKit is the only stable path to Reminders, Calendar, Mail, and Notes.[^24]

On Windows, `mapi-rs`[^14] (Microsoft-maintained, 21 releases) provides access to Outlook via MAPI COM. `windows-rs`[^13] provides WinRT bindings for Windows Calendar and Mail apps.

## Network Model

mcp-os is a **host process** — it binds to `127.0.0.1:4007` on the host. It never binds to `0.0.0.0` because it runs outside the container network and must not be exposed to the LAN.

Containers cannot reach `127.0.0.1` on the host directly (that is the container's own loopback). All platforms use the canonical gateway alias `host.docker.internal`, injected into each consuming container's `/etc/hosts` via Compose `extra_hosts`[^32] (statically for `claude`, dynamically for `mcp-hub` and OAuth-consumers via `ensure_host_gateway_extra_host`). The alias maps to the per-platform gateway IP — Lima vzNAT (192.168.5.2) on macOS, WSL2 NAT (192.168.65.1) on Windows. The "per-platform" in the title refers to the host-side process model (Lima VM vs WSL2), not the network alias.

`render_compose()` injects `WORKER_OS_URL=http://host.docker.internal:4007` into the mcp-hub container environment. Claude never talks to mcp-os directly — requests go through the hub.

**Note:** containerized MCP servers (hub, slack, redmine, etc.) bind to `0.0.0.0` **inside their containers** — this is correct and necessary, because other containers on the same Docker bridge network need to reach them.[^29] Their ports are published to the host as `127.0.0.1:<port>` in `compose.template.yml`[^30], which prevents LAN exposure.[^31] The "never 0.0.0.0" rule applies only to mcp-os because it runs on the host network.

## Security

The network model follows OWASP Docker Security Cheat Sheet[^23] recommendations:

- **Bearer token auth:** UUID v4 token generated per app session; every mcp-os request must include `Authorization: Bearer <token>`; protects against other processes on the same host accessing the endpoint
- **Host loopback only:** mcp-os binds to `127.0.0.1`, not `0.0.0.0` — the port is not reachable from the LAN[^30]
- **Container isolation preserved:** containers reach mcp-os through platform-specific gateway routing, not by sharing the host network namespace[^29]
- **OWASP RULE #3 + #4:** all containers run with `cap_drop: ALL` and `no-new-privileges:true`[^23]
- **OWASP RULE #7:** CPU and memory limits on every container to prevent DoS[^23]
- **OWASP RULE #8:** read-only root filesystem + `tmpfs /tmp:noexec,nosuid` on all containers[^23]

---

[^13]: [microsoft/windows-rs - Rust for Windows](https://github.com/microsoft/windows-rs)

[^14]: [microsoft/mapi-rs - Rust bindings for Outlook MAPI](https://github.com/microsoft/mapi-rs)

[^23]: [OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)

[^24]: [Apple EventKit - Calendar and Reminders](https://developer.apple.com/documentation/eventkit)

[^28]: [Lima Network — user-mode networking (vzNAT, host.lima.internal)](https://lima-vm.io/docs/config/network/user/)

[^29]: [Docker — Networking in Compose](https://docs.docker.com/compose/how-tos/networking/)

[^30]: [Docker — Port publishing and mapping](https://docs.docker.com/engine/network/port-publishing/)

[^31]: [Publishing Docker ports to 127.0.0.1 instead of 0.0.0.0](https://brokkr.net/2022/03/29/publishing-docker-ports-to-127-0-0-1-instead-of-0-0-0-0/)

[^32]: [nerdctl command reference — --add-host / host-gateway](https://github.com/containerd/nerdctl/blob/main/docs/command-reference.md)
