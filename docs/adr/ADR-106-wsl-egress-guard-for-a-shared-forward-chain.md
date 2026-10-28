# ADR-106: WSL egress guard for a shared FORWARD chain

> **Status:** Accepted
> **Date:** 2026-10-28
> **Context:** SPEED-902. On Windows, Speedwave containers lose network access when Docker runs in another WSL2 distribution. Sign-in then fails with an empty `Login failed:`. This ADR records the fix: Speedwave keeps its own ACCEPT rules in the legacy `FORWARD` chain and checks container egress after a start. Isolating container networking from the shared firewall is a separate spike (SPEED-907).

## Context

- All WSL2 distributions share one network namespace[^1]. A firewall change made in one distribution applies to packets forwarded from Speedwave's CNI bridges in another.
- With its iptables firewall backend, dockerd sets the `filter` table's `FORWARD` policy to `DROP` when it enables `net.ipv4.ip_forward` itself, unless `ip-forward-no-drop` is set[^2][^3]. A Docker restart keeps that policy[^4].
- iptables-legacy and iptables-nft register separate base chains on the same netfilter hook. An accept verdict in one chain does not skip a later chain on the same hook, while a drop ends traversal[^5][^6]. The CNI rules Speedwave's nerdctl writes go through the distribution's `iptables`, which is the nft backend in the Speedwave distro (observed on a tester's machine, 2026-10-28), so the nft `CNI-FORWARD` accept does not override a legacy `DROP`.
- On the tester's machine, `iptables-legacy -I FORWARD -s <subnet> -j ACCEPT` and `-d <subnet>` restored egress, with `networkingMode=mirrored` and NAT alike.
- Docker loads `br_netfilter`, so traffic between containers on one bridge can traverse `FORWARD` too; a project on a local model is then broken as well. This is inferred, not yet measured.
- The same pattern of keeping one's own ACCEPT rules in `FORWARD` and re-applying them periodically is what flannel ships against Docker's `DROP` policy[^7], and what the CNI `firewall` plugin does per container[^8].

## Decision

1. **A guest-side guard in the Speedwave distro** (Windows only), installed by `provision.rs` from `ensure_windows_invariants` as a systemd service, with a detached fallback when systemd is unavailable. Every 10 seconds it reconciles the legacy `filter` `FORWARD` chain:
   - It acts only when the legacy `filter` table is already loaded, so it never creates legacy tables on a machine that has none.
   - For every nerdctl network with a gateway (CNI bridge plugin `isGateway: true`) it keeps two rules: `-i <bridge> -j ACCEPT` and `-o <bridge> -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`. Egress-less (`--internal`) networks get none. Inbound connections to containers are not opened.
   - Every rule carries the comment `speedwave-egress:<instance>`. Rules of a bridge that no longer exists are removed by the same pass. Dev instances are separate distributions in the same namespace, so each guard touches only rules with its own instance tag.
2. **Detection, never a blocked start.**
   - `speedwave login` (which Desktop's sign-in also runs) checks that the claude container reaches `platform.claude.com` before `claude auth login`, and stops with a message naming the likely cause when it does not.
   - After a full start, a background probe from the claude container contacts only the host of the project's active provider (`api.anthropic.com` for Anthropic kinds, `openrouter.ai`, or a configured remote `base_url`; nothing for a provider on the container host alias or an unconfigured project) and logs a warning on failure. No connectivity is required to start: local models and offline work stay valid.
3. **Not done:** switching the distro to iptables-legacy (it helps only against tools that also write legacy tables), a `.wslconfig` kernel `ip_forward` parameter (unverified on WSL and needs `wsl --shutdown`), and changing the user's Docker configuration (`ip-forward-no-drop` is the user's choice; the warning may point to it).

## Consequences

- The reported case, Docker with iptables-legacy in another distribution, works without user action, also after a Docker restart, and within about 10 seconds after anything flushes `FORWARD`.
- Not covered: a tool that installs its own nftables table with a `forward` hook and a drop policy (for example firewalld on nftables). The sign-in check and the start probe report it; SPEED-907 evaluates moving container egress off the shared firewall.
- Legacy iptables has no atomic update, and its lock file is per distribution, so a concurrent writer in another distribution can lose an update. The 10-second reconcile repairs a lost rule.
- The probe sends one HTTPS request per full start to a host the project already uses; it never contacts Anthropic for a project on another provider.

[^1]: Microsoft, "What is WSL 2?": "Linux distributions running via WSL 2 will share the same network namespace", https://learn.microsoft.com/en-us/windows/wsl/about

[^2]: moby `daemon/libnetwork/drivers/bridge/setup_ip_forwarding.go` (tag `docker-v29.9.2`), https://github.com/moby/moby/blob/docker-v29.9.2/daemon/libnetwork/drivers/bridge/setup_ip_forwarding.go

[^3]: Docker docs, "Packet filtering and firewalls", https://docs.docker.com/engine/network/packet-filtering-firewalls/

[^4]: moby issue #50566, "nftables: IP forwarding, and filter-FORWARD policy", https://github.com/moby/moby/issues/50566

[^5]: nftables wiki, "Configuring chains", base chain priority, https://wiki.nftables.org/wiki-nftables/index.php/Configuring_chains

[^6]: Docker docs, "Docker with nftables", FORWARD policy in iptables, https://docs.docker.com/engine/network/firewall-nftables/

[^7]: flannel PR #872, https://github.com/flannel-io/flannel/pull/872

[^8]: CNI `firewall` plugin, https://www.cni.dev/plugins/current/meta/firewall/
