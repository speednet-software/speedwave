# ADR-013: mcp-os as Host Process — Implementation Details

## Decision

mcp-os runs on the host (inside the Speedwave Desktop app), not in a container.

## Rationale

D-Bus (Linux), WinRT/MAPI (Windows), and AppleScript/EventKit (macOS) are host-level APIs that are inaccessible from inside an isolated container:

- **macOS:** AppleScript and EventKit require direct access to macOS system services (Reminders, Calendar, Mail, Notes). These are gated by TCC (Transparency, Consent, and Control)[^22] and only available to the host process that received user permission via `Info.plist` declarations.
- **Linux:** D-Bus is a host IPC bus. Mounting `/var/run/dbus/system_bus_socket` into a container would violate the principle of minimal host exposure and expand the attack surface. EDS (Evolution Data Server) is accessed via D-Bus.[^26]
- **Windows:** WinRT APIs[^13] and MAPI COM[^14] are host-only. They require the calling process to run in the user's desktop session.

Mounting host sockets into containers would break the security model established in ADR-009. Running mcp-os on the host is the only correct approach.

## Implementation

mcp-os is a **TypeScript MCP server** located at `mcp-servers/os/src/index.ts`. It runs as a separate Node.js process spawned by the Tauri backend. The Rust code at `desktop/src-tauri/src/mcp_os_process.rs` is a **process manager** only — it handles spawning, stopping, and health-checking the Node.js process. The actual OS integration logic (calling Swift CLIs on macOS) lives entirely in the TypeScript layer.

## Binding and Routing

mcp-os binds to `127.0.0.1:4007` on all platforms (the default in the shared MCP server factory). It never binds to `0.0.0.0`. Containers reach it via platform-specific gateway routing — see ADR-010 for the full network model.

## Security

- Bearer token auth: UUID v4 generated per app session; every request must include `Authorization: Bearer <token>`
- No 0.0.0.0 binding: port is only reachable by containers through platform-specific gateway routing, not by the external network

---

[^13]: [microsoft/windows-rs - Rust for Windows](https://github.com/microsoft/windows-rs)

[^14]: [microsoft/mapi-rs - Rust bindings for Outlook MAPI](https://github.com/microsoft/mapi-rs)

[^22]: [macOS TCC - Transparency Consent and Control](https://developer.apple.com/documentation/bundleresources/information-property-list/nscalendarsusagedescription)

[^26]: [zbus - D-Bus library for Rust](https://docs.rs/zbus)
