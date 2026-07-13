# ADR-067: HostAddressing SSOT — host-side bind / container-side gateway under WSL2 mirrored networking

> **Status:** Accepted (mirrored-mode addressing revised by [ADR-080](ADR-080-wsl2-mirrored-container-host-relay.md))
> **Context:** Under WSL2 mirrored networking (enabled for VPN compatibility), TCP loopback (`127.0.0.1`) from a container to a host process is broken by a kernel bug (microsoft/WSL#11312)[^1], so every host-side bridge Desktop binds becomes unreachable from containers on Windows.
>
> **Update (ADR-080):** the claim below that "the two halves are mandatorily equal (the WSL vEthernet adapter IP)" holds only under **NAT** networking. Under genuine **mirrored** networking the default-route gateway is the LAN router (not host-bindable) and the guest adapter IP is guest-local (not container-reachable). ADR-080 keeps the SSOT but splits the halves in mirrored mode — bind `127.0.0.1`, expose a guest-local relay address — bridged by a `socat` relay in the distro.

## Decision

A single SSOT, `compose::HostAddressing`, owns both halves of the addressing pair: `gateway_ip` (what the container's `host.docker.internal` resolves to) and `bind_address` (what the host process passes to `TcpListener::bind`). Every host listener bind, every Compose `extra_hosts` substitution, and every Node-side MCP worker default reads these through thin wrappers — never a hardcoded literal. On Windows the two halves are mandatorily equal (the WSL vEthernet adapter IP, e.g. `172.x.x.1`), detected at runtime; on macOS they split (gateway `192.168.5.2`, bind `127.0.0.1`) because Lima's vzNAT translates the gateway to host loopback. There is no stable Windows IP, so it must be probed live, not pinned in a const.

## Why

- Mirrored-mode loopback is broken; binding on the WSL adapter IP and exposing the same IP to containers is the only reachable option that stays invisible to the LAN (binding the Windows LAN IP would work but is a security regression).
- A previous compile-time placeholder const (`192.168.65.1`) broke as soon as Microsoft changed WSL networking. The adapter IP also changes across `wsl --shutdown`, so the value must be re-detectable, not cached forever.
- Detection failure on Windows is fatal by design: silent fallback to `0.0.0.0` would expose host MCP workers to the LAN, and falling back to a stale const would silently break IDE-bridge connectivity. The error names the missing capability so the user can fix the environment.
- One SSOT means adding a new host listener costs a single call to `host_bind_address()`, and a drift detector blocks any new hardcoded loopback bind.

## Where it lives in code

- HostAddressing SSOT (struct, `HostAddressingComputer` trait, wrappers `host_addressing` / `host_gateway_ip` / `host_bind_address`, cache invalidation, the `LimaStatic` / `WslDetector` crate-private computers, and `parse_default_route_gateway`) — `crates/speedwave-runtime/src/compose.rs`
- macOS gateway constant — `crates/speedwave-runtime/src/consts.rs::LIMA_VZ_HOST_IP`
- Cache invalidated proactively before `${HOST_GATEWAY}` substitution — `render_compose` in `crates/speedwave-runtime/src/compose.rs`; per-service `extra_hosts` distribution via `ensure_host_gateway_extra_host` in the same file
- Host bind sites — `desktop/src-tauri/src/bridges/host_bridge.rs::bind_with_retry` (IDE bridge + every plugin bridge; reactively re-detects on `EADDRNOTAVAIL`), and `crates/speedwave-runtime/src/host_mcp_process/process.rs::spawn_with_spec` (injects `MCP_LISTEN_HOST` into Node)
- Node-side mirror — `mcp-servers/shared/src/server.ts::createMCPServer` (`process.env.MCP_LISTEN_HOST ?? '127.0.0.1'`)
- Drift detector — `crates/speedwave-runtime/tests/no_hardcoded_loopback_bind.rs` fails the build on new hardcoded loopback bind/connect literals; legitimate sites carry `// SSOT-allow: <reason>`
- Test isolation — `set_host_addressing_computer_for_test` mutates a global slot, so tests that fill it are keyed `#[serial_test::serial(host_addressing)]` (e.g. `host_gateway_ip_and_bind_address_split_correctly`, which asserts the macOS split; the Windows equality contract is encoded in the `sample_addr()` fixture — both halves `172.24.48.1` — consumed by the caching/recompute/concurrent tests). `failing_computer_returns_err` is the one exception: it exercises the failing computer directly without touching the global slot, so it is deliberately not serialized.

## Two firewall layers (perUser-install elevation gap)

Windows has two independent firewall engines, and Speedwave needs a rule in each under mirrored networking. A Hyper-V firewall rule (scoped to the WSL VMCreatorId) makes the host-bound worker reachable across the WSL VM boundary but does not govern host processes. Separately, the host Windows Defender Firewall raises a per-binary "allow an app" consent prompt when `node.exe` or `speedwave-desktop.exe` first listens on the WSL adapter IP (a Public-profile interface); the only way to suppress it is a host WDF application allow rule created before that first listen. The original design created only the Hyper-V rule, so the prompt still fired — confirmed live. `firewall.ps1` now creates both, and removes stale WDF Block rules first (an explicit Block beats an Allow).

Both rules require admin. Tauri's NSIS installer defaults to perUser (no elevation)[^2], so the install-time hook's privileged cmdlets fail and its fail-open exit swallows the error. The load-bearing fix is the Desktop runtime: `desktop/src-tauri/src/firewall.rs::ensure_firewall_rule` runs as the first statement of every host-listener starter (`ensure_ide_bridge_running` / `ensure_mcp_os_running` / `ensure_host_exec_running` / `ensure_oauth_running` in `desktop/src-tauri/src/main.rs`), guarded by a process-wide `Once`, so the rule is ensured before any WSL-adapter-IP bind. Program paths are resolved at runtime via `firewall::host_listener_programs` (from `current_exe()` plus the bundled `nodejs/node.exe`) because WDF application rules need exact paths and those differ between perUser and per-machine installs. Rule presence is the only source of truth (no persisted decline state, so an accidental "No" on UAC is not a permanent lock-out), and headless/SCCM sessions skip elevation to avoid hanging on a non-interactive elevation prompt.

## SSOT alignment

Recorded in CLAUDE.md under the `HOST_GATEWAY_ALIAS`, `host_addressing`, `MCP_LISTEN_HOST`, and `firewall.ps1` rows. The `windows/sweep.ps1` + WiX CustomAction pair added alongside this work ensures stale CLI processes do not block binary overwrite on either installer format — see [ADR-048 §"MSI parity (resolved)"](ADR-048-windows-uninstall-cleanup.md#msi-parity-resolved).

## Rejected alternatives

- A `OnceLock` for the addressing pair: simpler, but it could never recover from a stale adapter IP after `wsl --shutdown`. An `RwLock` with explicit invalidation was chosen instead.
- Binding `0.0.0.0` or the Windows LAN IP: both reachable from containers, but they expose host MCP workers to the LAN — rejected on security grounds.
- Creating only the Hyper-V firewall rule: insufficient, because it does not suppress the host WDF per-binary consent prompt for the Node workers.

[^1]: [microsoft/WSL#11312 - mirrored networking: loopback (127.0.0.1) from WSL to host is unreachable](https://github.com/microsoft/WSL/issues/11312)

[^2]: [Tauri v2 - Windows Installer: NSIS `installMode` defaults to per-user, no elevation required](https://v2.tauri.app/distribute/windows-installer/)
