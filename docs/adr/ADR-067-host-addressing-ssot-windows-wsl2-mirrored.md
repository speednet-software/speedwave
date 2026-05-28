# ADR-067: HostAddressing SSOT — host-side bind / container-side gateway under WSL2 mirrored networking

## Status

Accepted.

## Context

Windows users running Speedwave under WSL2 in **mirrored networking mode** (enabled by `setup_wizard::ensure_wslconfig_vpn_compat` for VPN compatibility) hit a known kernel bug: **TCP loopback (`127.0.0.1`) from a container to a host process is broken** (`microsoft/WSL#11312`[^1], `#11600`, `#12399`, `#14063`). Every host-side bridge that Tauri Desktop binds — the IDE bridge, plugin host bridges, the `mcp-os` / `host_exec` / `oauth` host MCP workers — was unreachable from containers in the `Speedwave-dev` / `Speedwave` distro, breaking `claude /ide` and the entire host-MCP surface on Windows.

Empirically, from inside the distro:

| Target                                        | Result                                            |
| --------------------------------------------- | ------------------------------------------------- |
| `127.0.0.1:<port>`                            | FAIL (mirrored-mode bug)                          |
| `172.x.x.1:<port>` (WSL vEthernet adapter IP) | OK — visible to host + WSL VM, invisible from LAN |
| `192.168.x.x:<port>` (Windows LAN IP)         | OK — but exposed to LAN, **security regression**  |

The fix is to bind host processes on the WSL adapter IP (`172.x.x.1`, the gateway of the WSL VM's default route) instead of `127.0.0.1`, and to expose the same IP to containers via Compose `extra_hosts: host.docker.internal:<ip>`. macOS Lima is unaffected — vzNAT translates `host.docker.internal → 192.168.5.2` to host `127.0.0.1` correctly, so host binds stay on loopback there.

The previous compile-time constant `WSL_HOST_IP = "192.168.65.1"` was a placeholder from a different WSL build and broke as soon as Microsoft's networking changed. There is no stable IP — it must be detected at runtime.

## Decision

A single SSOT, `compose::HostAddressing`, owns **both halves** of the pair (`gateway_ip`, `bind_address`) and serves them through two thin wrappers. Every production TCP listener bind, every Compose `extra_hosts` substitution, and every Node-side MCP worker default goes through these wrappers — never through a hard-coded literal.

### Shape

```rust
pub struct HostAddressing {
    pub gateway_ip: String,    // compose extra_hosts target (container side)
    pub bind_address: String,  // TcpListener::bind() (host side)
}

pub trait HostAddressingComputer: Send + Sync {
    fn compute(&self) -> anyhow::Result<HostAddressing>;
}

static HOST_ADDRESSING: RwLock<Option<HostAddressing>> = RwLock::new(None);
static COMPUTER: RwLock<Option<Arc<dyn HostAddressingComputer>>> = RwLock::new(None);

pub fn host_addressing() -> anyhow::Result<HostAddressing>;
pub fn host_gateway_ip() -> anyhow::Result<String>;
pub fn host_bind_address() -> anyhow::Result<String>;
pub fn invalidate_host_addressing_cache();
```

Production computers are crate-private (`LimaStatic` on macOS, `WslDetector` on Windows). Tests inject fixtures via `set_host_addressing_computer_for_test`. The cache is invalidated proactively by `render_compose` on Windows (before substituting `${HOST_GATEWAY}`) and reactively by `bind_with_retry` on `EADDRNOTAVAIL`.

### Per-platform divergence

| Platform                | `gateway_ip`                              | `bind_address`           | Source                                                                                             |
| ----------------------- | ----------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| macOS (Lima vzNAT)      | `192.168.5.2` (`consts::LIMA_VZ_HOST_IP`) | `127.0.0.1`              | Static                                                                                             |
| Windows (WSL2 mirrored) | WSL vEthernet adapter IP                  | **same as `gateway_ip`** | `wsl.exe -d <distro> -- sh -c 'ip -4 route show default'`, parsed by `parse_default_route_gateway` |

On Windows the two halves are mandatorily equal — the container's `host.docker.internal` resolves to the same IP the host process must bind on, because mirrored-mode breaks the alternative (loopback). On macOS they split because vzNAT translates.

### Distribution to consumers

- **Host bind sites** call `compose::host_bind_address()`:
  - `desktop/src-tauri/src/bridges/host_bridge.rs::bind_with_retry` (IDE bridge + every plugin bridge)
  - `crates/speedwave-runtime/src/host_mcp_process/process.rs::spawn_with_spec` injects `MCP_LISTEN_HOST` into Node, mirrored at `mcp-servers/shared/src/server.ts::createMCPServer` (default `process.env.MCP_LISTEN_HOST ?? '127.0.0.1'`)
- **Compose render** substitutes `${HOST_GATEWAY}` with `host_gateway_ip()?` in the template, including `extra_hosts` for the `claude` and `mcp-playwright` containers and for every plugin / OAuth-consumer container via `compose::ensure_host_gateway_extra_host`.
- **Drift detector** at `crates/speedwave-runtime/tests/no_hardcoded_loopback_bind.rs` walks production source for new hardcoded loopback bind/connect literals (`TcpListener::bind("127.0.0.1`, `[127, 0, 0, 1]`, `Ipv4Addr::LOCALHOST`, etc.) and fails the build on unknown occurrences. Legitimate host-internal sites (UI URLs, health endpoints, URL validators) are allowlisted with `// SSOT-allow: <reason>`.

### Hard-fail on detection failure

Detection failure on Windows (`wsl.exe` missing, distro not registered, parser cannot find a default route) returns `Err`. The runtime never falls back to `0.0.0.0` (security regression) or to a stale const (silent breakage). The error surfaces to the caller — `HostBridge::new` fails with an actionable message, `render_compose` aborts before producing a broken YAML.

## Consequences

### Positive

- Container-side `host.docker.internal` and host-side `TcpListener::bind` are guaranteed to point at the same socket on both platforms. A test (`host_gateway_ip_and_bind_address_split_correctly`) asserts the macOS split and the Windows equality contract.
- Adding a new host-side TCP listener costs one call to `host_bind_address()` — the SSOT contract is enforced by the drift detector, so new code cannot silently regress.
- The runtime survives `wsl --shutdown` mid-session: the next compose op (always through `LockedRuntime::transaction → ensure_ready → render_compose`) invalidates the cache and re-detects the new adapter IP. `bind_with_retry` covers the case where the IP changed between cache fill and bind attempt.
- macOS behaviour is unchanged — `LimaStatic` returns the same `(192.168.5.2, 127.0.0.1)` pair the code used to hard-code.

### Negative / accepted

- `wsl.exe` probe on cache miss costs ~100–300 ms warm. Render compose is rare (compose up / start project), so the cost is amortised. Cold start is hidden by the existing setup wizard `init_vm_windows` phase.
- Detection failure is fatal. This is intentional — silent fallback to `0.0.0.0` would expose host MCP workers to the LAN, and silent fallback to a stale const would silently break IDE bridge connectivity. The error message names the missing capability so the user can fix the environment (`wsl --set-version Speedwave 2`, `wsl --update`).
- `RwLock` is more code than `OnceLock`, but `OnceLock` would never recover from a stale IP after WSL restart. The trade-off is accepted.

### Test isolation

`set_host_addressing_computer_for_test` mutates a global slot. Tests that inject `FailingComputer` (e.g. `host_addressing_surfaces_computer_error`) are keyed `#[serial_test::serial(host_addressing)]` so they cannot interleave with `render_compose` tests that consume the production computer.

## SSOT alignment

Recorded in CLAUDE.md under the `HOST_GATEWAY_ALIAS`, `host_addressing`, and `MCP_LISTEN_HOST` SSOT-alignment rows.

The `windows/sweep.ps1` + WiX CustomAction pair (added alongside this work — see [ADR-048 §"MSI parity (resolved)"](ADR-048-windows-uninstall-cleanup.md#msi-parity-resolved)) ensures stale CLI processes do not block binary overwrite on either installer format.

---

[^1]: WSL2 mirrored-mode loopback bug — `microsoft/WSL#11312` <https://github.com/microsoft/WSL/issues/11312>. Tracked across `#11600`, `#12399`, `#14063`. No fix shipped as of Windows 11 24H2.
