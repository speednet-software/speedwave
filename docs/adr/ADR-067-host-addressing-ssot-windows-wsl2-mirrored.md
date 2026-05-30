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

## Two firewall layers, and the runtime fallback (perUser-install elevation gap)

Windows has **two independent firewall engines**, and Speedwave needs a rule in **each** under WSL2 mirrored networking:[^2]

1. **Hyper-V firewall** (`New-NetFirewallHyperVRule`, scoped to the WSL `VMCreatorId`) governs traffic crossing the WSL VM boundary — it makes the host-bound worker reachable from containers inside the VM. Necessary, but it does **not** govern host processes.
2. **Host Windows Defender Firewall (WDF / MpsSvc)** governs a host process's own `listen()` on a host interface. The bundled `node.exe` workers and `speedwave-desktop.exe` bind the WSL vEthernet adapter IP (172.x.x.1) — which WDF classifies as a real (Public-profile) interface — so WDF raises the per-binary "allow an app to access the network" consent prompt. The **only** way to suppress it is a host WDF application allow rule (`New-NetFirewallRule -Program <exe>`), created before first listen.[^3]

The original design created only the Hyper-V rule, so the WDF prompt for `node.exe` still fired (confirmed live: prompt appeared while the Hyper-V rule existed). `firewall.ps1` now creates **both**: the Hyper-V rule (VM-boundary reachability) **and** per-program WDF allow rules for the resolved host-listener paths (prompt suppression). It also removes stale WDF Block rules first, since an explicit Block beats an Allow.

Both require administrator privileges to create. Tauri v2 defaults the NSIS installer to **perUser** (`installMode` unset), which runs **without elevation**.[^4] So `NSIS_HOOK_POSTINSTALL` invokes `firewall.ps1 -Mode install` un-elevated, the privileged cmdlets fail, and the script's fail-open `exit 0` swallows it — leaving no rules and surfacing the WDF prompt on first use. The MSI path is unaffected (WiX CustomAction runs as LocalSystem via `Impersonate="no"`).

**Program paths are resolved at runtime** (`firewall::host_listener_programs` from `current_exe()` + the bundled `nodejs/node.exe`), not hardcoded — they differ between perUser and per-machine installs, and WDF application rules require exact paths (no wildcards). They are passed to `firewall.ps1` as a single `;`-separated `-Programs` string (PowerShell `-File` cannot bind a multi-element array).

**Decision: defense-in-depth across three call sites, one shared `firewall.ps1`** (mirroring the `sweep.ps1` 3-place pattern):

1. **NSIS install** — `-Mode install`, never self-elevates (relies on whatever elevation the installer has). Fail-open.
2. **MSI install** — `-Mode install` as LocalSystem (admin); creates the rule directly. Unchanged.
3. **Desktop runtime** — `desktop/src-tauri/src/firewall.rs::ensure_firewall_rule`, invoked as the first statement of every host-listener starter (`ensure_ide_bridge_running` / `ensure_mcp_os_running` / `ensure_host_exec_running` / `ensure_oauth_running`) and guarded by a process-wide `Once`, so the rule is ensured **before any WSL-adapter-IP bind** regardless of fresh-install vs restart. This is the load-bearing guarantee, since perUser installs cannot create the rule at install time.

**Why the starters, not the install-time block or the bind chokepoint:** on a fresh install `setup_started` is `false`, so the post-setup startup block never runs during the wizard — but the wizard's `start_containers` already starts listeners. The bind chokepoint (`bind_with_retry`) covers only the IDE/plugin bridges; `mcp-os`/`host_exec`/`oauth` are Node children that `.listen()` on `MCP_LISTEN_HOST` directly. The four `ensure_*` starters are the only common point upstream of every bind.

**Exit-code contract.** `ensure`: `0` present/created, `3` missing+needs-admin, `2` caught failure. `install-elevated` (internal, invoked by the Rust self-elevation): `0`/`2`. `install`/`uninstall`: always `0` (fail-open). The Rust caller does a non-admin existence check first (no UAC), and only on `3` self-elevates once via UAC.

**Re-prompt policy.** No decline state is persisted. Rule _presence_ is the only source of truth (re-checked each session via `-Mode ensure`), and the process-wide `Once` caps the prompt at one per app launch. So an accidental "No" on the UAC dialog is not a permanent lock-out — the next time the user opens Speedwave they get one more chance, and the rule self-heals if it was deleted externally. The trade-off: a user permanently without admin sees one UAC each time they start the app (bounded to one per session by `Once`); this was chosen over a persisted "declined" flag because a misclick must not silently suppress the rule forever. Non-interactive/headless sessions skip elevation entirely (no `-Verb RunAs` hang under silent install / SCCM — gated on `SESSIONNAME`). Users without admin: fail-open — the app works, WDF prompts remain, no worse than before.

## SSOT alignment

Recorded in CLAUDE.md under the `HOST_GATEWAY_ALIAS`, `host_addressing`, `MCP_LISTEN_HOST`, and `firewall.ps1` SSOT-alignment rows.

The `windows/sweep.ps1` + WiX CustomAction pair (added alongside this work — see [ADR-048 §"MSI parity (resolved)"](ADR-048-windows-uninstall-cleanup.md#msi-parity-resolved)) ensures stale CLI processes do not block binary overwrite on either installer format.

---

[^1]: WSL2 mirrored-mode loopback bug — `microsoft/WSL#11312` <https://github.com/microsoft/WSL/issues/11312>. Tracked across `#11600`, `#12399`, `#14063`. No fix shipped as of Windows 11 24H2.

[^2]: Hyper-V firewall (`New-NetFirewallHyperVRule`, VMCreatorId-scoped) filters "inbound and outbound traffic to/from containers hosted by Windows, including WSL" — a separate engine from the host Windows Defender Firewall — Microsoft Learn, Hyper-V Firewall <https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/hyper-v-firewall>. Managing rules in either engine requires an elevated (administrator) session — NetSecurity cmdlet reference <https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallhypervrule>.

[^3]: The host WDF "allow an app" consent dialog fires when a program first issues a listen call and "there's no active application or administrator-defined allow rule(s)"; "explicitly defined allow rules take precedence over the default block setting," and staging the rule "before the user first launches the application helps ensure a seamless experience." Application rules are scoped by full program path (wildcards unsupported) — Microsoft Learn, Windows Firewall Rules <https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules> and `New-NetFirewallRule` <https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule>.

[^4]: Tauri v2 Windows installer — NSIS install mode defaults to `currentUser` (perUser), which installs to `%LOCALAPPDATA%` and does **not** require administrator privileges <https://v2.tauri.app/distribute/windows-installer/#install-modes>.
