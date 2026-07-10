# ADR-079: Container↔host relay for WSL2 mirrored networking

> **Status:** Accepted — verified end-to-end on live Windows/WSL2 mirrored (2026-07-09).
>
> **Key correction from the first draft:** WSL2 mirrored networking **shares the host↔guest port
> space**, so a guest `socat` cannot reuse the bridge's loopback port (`bind: Address already in use`
> while the host holds `127.0.0.1:<port>`). The relay therefore listens on a **distinct deterministic
> port** `compose::mirror_relay_port(bind_port) = bind_port ^ 0x4000` (bijective; relay ≠ bind; stable
> across restarts so a once-rendered compose stays valid). The **same SSOT** is called by the compose
> injector (`compose/plugins.rs` — the container's `ws://…:<relayport>` URL) and the relay supervisor
> (`mirror_relay.rs` — the `socat` listen port), so they agree with no runtime threading. `socat` runs
> as a transient **systemd unit** (`systemd-run`, keyed by bind port) so it survives the launching
> `wsl.exe` call. Verified: figma worker container → `10.200.0.1:43739` → `127.0.0.1:60123` bridge,
> both roles paired.
> **Supersedes:** the "both halves mandatorily equal / bind the WSL adapter IP" decision in [ADR-067](ADR-067-host-addressing-ssot-windows-wsl2-mirrored.md) for the mirrored case.
> **Context:** Speedwave forces WSL2 mirrored networking for VPN compatibility[^1] (`provision::ensure_wslconfig_vpn_compat`). ADR-067 assumed the host could bind, and containers could reach, the WSL default-route gateway. That holds under NAT networking[^2] but is false under mirrored networking, so every host-side bridge (IDE bridge, plugin bridges, mcp-os, oauth) becomes unreachable — the user-visible symptom is `plugin bridge '<slug>' not running` while the plugin container itself is healthy.

## Measured behavior under mirrored networking (Windows 11, WSL2)

| channel | result | reason |
| --- | --- | --- |
| host binds default-route gateway (LAN router, e.g. `192.168.68.1`) | `EADDRNOTAVAIL` | not an address on any host interface |
| host binds the guest adapter IP (e.g. `192.168.68.132`) | binds, but unreachable | that IP is the guest's own (`ip route get` → `local … dev lo`); container/guest traffic to it never leaves the guest |
| guest → host `127.0.0.1` | reachable | mirrored mode forwards guest loopback to the host via a `loopback0` device[^1] |
| container → host, any address | no route | the container is in a separate netns with no `loopback0`; loopback to the host is broken[^3] |

Conclusion: under mirrored mode there is **no single address the host can bind that a container can also reach**. macOS (Lima) is unaffected — vzNAT splits gateway `192.168.5.2` / bind `127.0.0.1`, both working.

## Decision

Under mirrored mode, split the addressing pair and bridge the two halves with a guest-side relay:

- **Host bind:** `127.0.0.1` — private, never on the LAN.
- **Container gateway (`host.docker.internal`):** a fixed guest-local address `consts::MIRROR_RELAY_GATEWAY_IP` (`10.200.0.1`), added to the distro's `lo`. Containers reach it via their bridge gateway; it is invisible to the LAN.
- **Relay:** per host-listener bind port, a detached `socat`[^4] in the distro forwards `10.200.0.1:mirror_relay_port(port)` → `127.0.0.1:port` — the listen port is the XOR'd `mirror_relay_port`, NOT the bind port (the shared host↔guest port space forbids reusing it). The guest→host loopback hop rides the mirrored `loopback0` forwarder.

Mode is discriminated at runtime, not by reading `.wslconfig` (which can be stale until `wsl --shutdown`): `WslDetector` bind-probes the default-route gateway. Bindable → NAT (gateway used for both halves, unchanged). Not bindable → mirrored (loopback bind + relay gateway).

End-to-end validated on a live mirrored distro: a container on the project network reached a host loopback listener through the `socat` relay.

## Where it lives in code

- Addressing split + bind-probe — `crates/speedwave-runtime/src/compose/addressing.rs` (`WslDetector::compute`, `addressing_from`, `host_can_bind`).
- Relay address SSOT — `crates/speedwave-runtime/src/consts.rs::MIRROR_RELAY_GATEWAY_IP`.
- Relay lifecycle — `desktop/src-tauri/src/mirror_relay.rs` (`ensure_relay_for_port` after every host-listener bind, next to the firewall rule; `remove_relay_for_port` on stop). Callers: `bridges/host_bridge.rs` (IDE + all plugin bridges) and `main.rs::ensure_mcp_os_running`. The relay lives inside the distro and is wiped by a WSL restart (e.g. laptop sleep/Modern-Standby) while the host process survives, so it is **re-ensured every ~30 s** by the `HostBridge` watchdog and the mcp-os watchdog (idempotent) and torn down symmetrically on stop (`HostBridge::stop`, mcp-os exit cleanup).
- `socat` provisioning — `crates/speedwave-runtime/src/provision.rs` (installed alongside `iptables`).

## Known limitations

- `mirror_relay_port(bind) = bind ^ 0x4000` is an involution, so relay ports pair up. If two host listeners happen to bind an XOR-paired ephemeral pair, one bridge's relay listen port can equal the other's live bind port → `socat` bind failure + `Restart=on-failure` retries. Low probability (listeners take independent ephemeral ports) and not observed in practice. The single degenerate result `16384 → 0` (an invalid port) is remapped to a valid, distinct port.

## Security

The host listener stays on `127.0.0.1`; the relay address lives on `lo` and is routable only from the guest's own container networks, so no host worker is exposed to the LAN — preserving ADR-067's security goal without binding the LAN IP.

## Alternatives rejected

- **Default to NAT networking.** Simplest (NAT gateway is bindable and container-reachable) but NAT breaks WSL2 internet under a VPN[^1] — the exact case mirrored was adopted for.
- **Bind the guest LAN IP (`192.168.68.132`).** Bindable but (a) exposes workers to the LAN and (b) is guest-local under mirroring, so containers still can't reach it.
- **Rely on mirrored loopback for containers.** Only the guest netns gets `loopback0`; containers do not[^3].

[^1]: WSL networking (mirrored mode, VPN/loopback behavior): <https://learn.microsoft.com/en-us/windows/wsl/networking>
[^2]: WSL2 default (NAT) networking creates a `vEthernet (WSL)` host adapter as the guest gateway: <https://learn.microsoft.com/en-us/windows/wsl/networking>
[^3]: WSL mirrored-mode container↔host loopback limitation: <https://github.com/microsoft/WSL/issues/11312>
[^4]: `socat` multipurpose relay: <http://www.dest-unreach.org/socat/doc/socat.html>
