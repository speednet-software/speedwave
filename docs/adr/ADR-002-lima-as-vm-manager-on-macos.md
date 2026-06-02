# ADR-002: Lima as VM Manager on macOS

> **Status:** Accepted
> **Context:** macOS needs a kernel-level isolation VM (containerd runs inside it) without requiring Docker Desktop. Windows uses WSL2 instead (ADR-059 dropped Linux as a host platform).

## Decision

On macOS, Lima manages the containerd VM using Apple Virtualization Framework (`vmType: vz`), with Rosetta enabled for x86 emulation on Apple Silicon. The VM is provisioned by the Desktop setup wizard from an auto-generated Lima YAML config. Windows has its own runtime (`WslRuntime`); both sit behind the `LockedRuntime` façade (ADR-066).

## Why

- Lima is purpose-built as a Docker Desktop alternative on macOS and is open source ([lima-vm/lima](https://github.com/lima-vm/lima)).
- Apple VZ gives full native-ARM performance on Apple Silicon and is the same hypervisor Docker Desktop adopted in [version 4.15](https://docs.docker.com/desktop/release-notes/#4150).
- Bundling Lima means a single installable app — no separate `brew install lima` step.
- An isolated `LIMA_HOME` keeps Speedwave's VM completely independent from any user-installed Lima.

## Where it lives in code

- VM config (`vmType: vz`, Rosetta, vzNAT network, virtiofs mounts, boot-time netplan provision script) — `lima_config()` in `desktop/src-tauri/src/setup_wizard.rs`. The `vmType` is written directly into the YAML string; there is no `cfg!(target_os = ...)` branch selecting it.
- Home mount — the config mounts the entire host home directory (`location: "~"`, `writable: true`), not a narrower `~/.speedwave` subtree.
- Networking — `networks: - vzNAT: true`; the VM inherits the host routing table (and VPN tunnels). There is no Lima port-forwarding / `guestPortRange` configuration. Container-to-host reach uses the static vzNAT host IP `consts::LIMA_VZ_HOST_IP` (`192.168.5.2`).
- Isolated `LIMA_HOME` (`~/.speedwave/lima`) — `binary::lima_home()` in `crates/speedwave-runtime/src/binary.rs`, set as an env var on every `limactl` invocation by `binary::command()`.
- VM instance name — `consts::lima_vm_name()` in `crates/speedwave-runtime/src/consts.rs`, derived from the data-dir basename (production `~/.speedwave` → `speedwave`).
- `limactl` binary resolution — `binary::resolve_binary()` in `crates/speedwave-runtime/src/binary.rs`: looks under `SPEEDWAVE_RESOURCES_DIR` (set in production from `current_exe()` by `desktop/src-tauri/src/main.rs`) for `lima/bin/limactl`, then falls back to system PATH for local development.
- Bundling — `limactl` and `lima/share/` are listed as bundle resources in `desktop/src-tauri/tauri.macos.conf.json`; see ADR-021 for the zero-install bundling strategy.

## Rejected alternatives

- Docker Desktop — heavyweight install, licensing constraints, and not bundleable into a single app.
- QEMU as the macOS hypervisor — slower than Apple VZ on Apple Silicon; VZ is the native, hardware-accelerated path.
