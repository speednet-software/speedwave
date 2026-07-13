# ADR-002: Lima as VM Manager on macOS

> **Status:** Accepted
> **Context:** macOS needs a kernel-level isolation VM (containerd runs inside it) without requiring Docker Desktop. Windows uses WSL2 instead (ADR-059 dropped Linux as a host platform).

## Decision

On macOS, Lima manages the containerd VM using Apple Virtualization Framework (`vmType: vz`)[^1], with Rosetta enabled for x86 emulation on Apple Silicon[^2]. The VM is provisioned by the Desktop setup wizard from an auto-generated Lima YAML config. Windows has its own runtime (`WslRuntime`); both sit behind the `LockedRuntime` façade (ADR-066).

## Why

- Lima is purpose-built as a Docker Desktop alternative on macOS and is open source[^3].
- Apple VZ gives full native-ARM performance on Apple Silicon and is the same hypervisor Docker Desktop adopted in version 4.15[^4].
- Bundling Lima means a single installable app — no separate `brew install lima` step.
- An isolated `LIMA_HOME` keeps Speedwave's VM completely independent from any user-installed Lima.

## Where it lives in code

- VM config (`vmType: vz`, Rosetta, vzNAT network, virtiofs mounts, boot-time netplan provision script) — `lima_config()` in `desktop/src-tauri/src/setup_wizard.rs`. The `vmType` is written directly into the YAML string; there is no `cfg!(target_os = ...)` branch selecting it.
- Home mount — the config mounts the entire host home directory (`location: "~"`, `writable: true`), not a narrower `~/.speedwave` subtree.
- Networking — `networks: - vzNAT: true`[^5]; the VM inherits the host routing table (and VPN tunnels). There is no Lima port-forwarding / `guestPortRange` configuration. Container-to-host reach uses the static vzNAT host IP `consts::LIMA_VZ_HOST_IP` (`192.168.5.2`).
- Isolated `LIMA_HOME` (`~/.speedwave/lima`) — `binary::lima_home()` in `crates/speedwave-runtime/src/binary.rs`, set as an env var on every `limactl` invocation by `binary::command()`.
- VM instance name — `consts::lima_vm_name()` in `crates/speedwave-runtime/src/consts.rs`, derived from the data-dir basename (production `~/.speedwave` → `speedwave`).
- `limactl` binary resolution — `binary::resolve_binary()` in `crates/speedwave-runtime/src/binary.rs`: looks under `SPEEDWAVE_RESOURCES_DIR` (set in production from `current_exe()` by `desktop/src-tauri/src/main.rs`) for `lima/bin/limactl`, then falls back to system PATH for local development.
- Bundling — `limactl` and `lima/share/` are listed as bundle resources in `desktop/src-tauri/tauri.macos.conf.json`; see ADR-021 for the zero-install bundling strategy.

## Rejected alternatives

- Docker Desktop — heavyweight install, licensing constraints[^6], and not bundleable into a single app.
- QEMU as the macOS hypervisor — slower than Apple VZ on Apple Silicon (unverified); VZ is the native, hardware-accelerated path.

[^1]: [Lima docs: VZ vmType](https://lima-vm.io/docs/config/vmtype/vz/) - `vz` uses macOS's native Virtualization.framework and has been the default driver for macOS hosts since Lima v1.0; requires Lima >= 0.14 and macOS >= 13.0.

[^2]: [Lima docs: VZ vmType - Rosetta](https://lima-vm.io/docs/config/vmtype/vz/) - macOS 13 Ventura's Virtualization framework support for running amd64 binaries via Rosetta inside arm64 Linux VMs.

[^3]: [lima-vm/lima on GitHub](https://github.com/lima-vm/lima) - Apache-2.0 licensed, open source.

[^4]: [Docker Desktop 4.15: Improved Usability and Performance](https://www.docker.com/blog/docker-desktop-4-15-improved-usability-and-performance/) - Docker Desktop 4.15.0 adopted VirtioFS and Apple's Virtualization Framework.

[^5]: [Lima docs: Network](https://lima-vm.io/docs/config/network/) - `vzNAT` is configured via `networks: - vzNAT: true` and requires Lima >= 0.14, macOS >= 13.0.

[^6]: [Docker Desktop license agreement](https://docs.docker.com/subscription/desktop-license/) - a paid subscription is required for organizations with more than 250 employees or more than $10 million in annual revenue.
