# ADR-080: Container↔host relay for WSL2 mirrored networking

> **Status:** Accepted — verified end-to-end on live Windows/WSL2 mirrored (2026-07-09).
>
> **Key correction from the first draft:** WSL2 mirrored networking **shares the host↔guest port
> space** (measured locally — see the table below; no upstream documentation states it), so a guest
> `socat` cannot reuse the bridge's loopback port (`bind: Address already in use` while the host holds
> `127.0.0.1:<port>`). The relay therefore listens on a **distinct deterministic port**
> `compose::mirror_relay_port(bind_port)`: `bind_port ^ 0x4000`, except the 3-cycle
> `16384→49152→32768→16384` routing around 16384's invalid XOR image of `0` — a true bijection over
> `1..=65535`, relay ≠ bind, stable across restarts so a once-rendered compose stays valid. The **same SSOT** is called by
> the compose injector (`compose/plugins.rs` — the container's `ws://…:<relayport>` URL) and the relay
> supervisor (`mirror_relay.rs` — the `socat` listen port), so they agree with no runtime threading.
> `socat` runs as a transient **systemd unit** (`systemd-run`[^5], keyed by bind port) so it outlives
> the launching `wsl.exe` call. Verified: figma worker container → `10.200.0.1:43739` →
> `127.0.0.1:60123` bridge, both roles paired.
> **Supersedes:** the "both halves mandatorily equal / bind the WSL adapter IP" decision in [ADR-067](ADR-067-host-addressing-ssot-windows-wsl2-mirrored.md) for the mirrored case.
> **Context:** Speedwave forces WSL2 mirrored networking for VPN compatibility[^1] (`provision::ensure_wslconfig_vpn_compat`). ADR-067 assumed the host could bind, and containers could reach, the WSL default-route gateway. That holds under NAT networking[^2] but is false under mirrored networking, so every host-side bridge (IDE bridge, plugin bridges, mcp-os, oauth) becomes unreachable — the user-visible symptom is `plugin bridge '<slug>' not running` while the plugin container itself is healthy.

## Measured behavior under mirrored networking (Windows 11, WSL2)

| channel                                                            | result                 | reason                                                                                                               |
| ------------------------------------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| host binds default-route gateway (LAN router, e.g. `192.168.68.1`) | `EADDRNOTAVAIL`        | not an address on any host interface                                                                                 |
| host binds the guest adapter IP (e.g. `192.168.68.132`)            | binds, but unreachable | that IP is the guest's own (`ip route get` → `local … dev lo`); container/guest traffic to it never leaves the guest |
| guest → host `127.0.0.1`                                           | reachable              | mirrored mode forwards guest loopback to the host via a `loopback0` device[^1]                                       |
| container → host, any address                                      | no route               | the container is in a separate netns with no `loopback0`; loopback to the host is broken[^3]                         |

Conclusion: under mirrored mode there is **no single address the host can bind that a container can also reach**. macOS (Lima) is unaffected — vzNAT splits gateway `192.168.5.2` / bind `127.0.0.1`, both working.

## Decision

Under mirrored mode, split the addressing pair and bridge the two halves with a guest-side relay:

- **Host bind:** `127.0.0.1` — private, never on the LAN.
- **Container gateway (`host.docker.internal`):** a fixed guest-local address `consts::MIRROR_RELAY_GATEWAY_IP` (`10.200.0.1`), added to the distro's `lo`. Containers reach it via their bridge gateway; it is invisible to the LAN.
- **Relay:** per host-listener bind port, a detached `socat`[^4] in the distro forwards `10.200.0.1:mirror_relay_port(port)` → `127.0.0.1:port` — the listen port is the XOR'd `mirror_relay_port`, NOT the bind port (the shared host↔guest port space forbids reusing it). The guest→host loopback hop rides the mirrored `loopback0` forwarder.

Mode is discriminated at runtime, not by reading `.wslconfig` (which can be stale until `wsl --shutdown`): `WslDetector` bind-probes the default-route gateway. Bindable → NAT (gateway used for both halves, unchanged). Not bindable → mirrored (loopback bind + relay gateway).

End-to-end validated on a live mirrored distro: a container on the project network reached a host loopback listener through the `socat` relay.

## Where it lives in code

- Addressing split + bind-probe — `crates/speedwave-runtime/src/compose/addressing.rs` (`WslDetector::compute`, `addressing_from`, `host_can_bind`). The result carries an explicit `AddressingMode` (`Direct`/`MirroredRelay`); mirrored is never inferred from the gateway IP value (a user-pinned NAT subnet could equal the relay IP).
- Relay address SSOT — `crates/speedwave-runtime/src/consts.rs::MIRROR_RELAY_GATEWAY_IP`; port translation SSOT — `compose::mirror_relay_port` / `compose::container_facing_port`.
- Relay lifecycle — `desktop/src-tauri/src/mirror_relay.rs`. `ensure_relay_for_port` is async fire-and-forget (never blocks the UI thread), coalesced to one in-flight ensure per port (a wedged `wsl.exe` cannot stack threads), verifies `socat` is actually active before claiming success, and sweeps orphaned `spw-mirror-relay-*` units once per process before the first create (a Desktop crash leaves `Restart=on-failure` units forwarding to freed loopback ports). `remove_relay_for_port` is unconditional on Windows (skipping only when the distro is stopped — transient units die with it), so a mode flip or detection failure can't orphan a unit on graceful teardown.
- Ensure callers: `bridges/host_bridge.rs` (bind + watchdog re-ensure for the IDE and all plugin bridges; the IDE bridge additionally names its lock file with `container_facing_port` and the watchdog relocates it if the addressing mode flips mid-session), `main.rs::ensure_mcp_os_running`, the mcp-os spawn in Tauri `setup()`, the mcp-os watchdog, `main.rs::ensure_oauth_running` (fresh spawn, consumer-set respawn, and the no-change path), and the per-project oauth watchdog (live workers + respawns). Teardown callers: `HostBridge::stop`, the oauth respawn path, and the mcp-os/oauth exit cleanup in `reconcile.rs`. Watchdogs **re-ensure every ~30 s** (idempotent) because a WSL restart (e.g. laptop sleep/Modern-Standby) wipes the units while the host processes survive.
- `socat` provisioning — `crates/speedwave-runtime/src/provision.rs::ensure_relay_packages` (iptables failure is fatal — CNI-critical; socat failure only degrades the relay).

## Known limitations

- Relay ports pair up (the map is nearly an involution): if two host listeners bind a paired combination (`p` and `p ^ 0x4000`, or two members of the `16384→49152→32768` 3-cycle), one bridge's relay listen port equals the other's live bind port → `socat` bind failure, surfaced by the ensure path as a `relay unit started but socat is not active` warning. Low probability (listeners take independent ephemeral ports) and not observed in practice.
- Host-side **local LLM listeners are not relayed**: `compose/llm.rs::canonicalize_local_base_url`/`default_base_url` emit `host.docker.internal:<raw port>` for user-run Ollama/LM Studio/llama.cpp, and no Speedwave process supervises those ports — under mirrored mode the proxy cannot reach them. Binding the server to `0.0.0.0` does NOT help (per the measured table, no host address is container-reachable under mirroring). Workarounds: switch WSL to NAT networking (sacrifices the VPN case), run the LLM server inside the distro, or hand-run a `socat` unit on a spare port (`systemd-run --unit=my-llm-relay socat TCP-LISTEN:<spare>,bind=10.200.0.1,fork TCP:127.0.0.1:<llm port>` as root in the distro, with `base_url` pointing at `<spare>`; the shared port space forbids reusing the LLM's own port, and a WSL restart wipes the unit). A supervised relay for configured provider ports is future work.
- **Only Speedwave-supervised listeners are relayed.** Any other host port a container dials through `host.docker.internal` — a user's dev server reached by Playwright ([ADR-062](ADR-062-playwright-host-gateway-access.md)), a hand-run host MCP endpoint — is unreachable under mirrored mode, because the relay is created per supervised bind, not per alias lookup. The local-LLM bullet above is the common instance; the same `socat` workaround applies to any such port.
- An in-flight async ensure can race a concurrent stop and recreate a unit just torn down; the next start's orphan sweep (or the 30 s re-ensure cycle) clears the residue. The startup sweep runs only under mirrored mode — a mirrored→NAT flip needs a `wsl --shutdown` to take effect, which already kills every transient relay unit, so no NAT-side sweep is required.

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

[^5]: `systemd-run` transient units are managed by the service manager and are independent of the invoking process: <https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html>
