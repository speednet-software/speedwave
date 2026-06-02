# ADR-001: Eliminate Docker Desktop

> **Status:** Accepted
> **Context:** Speedwave needs container isolation on macOS and Windows without shipping Docker Desktop.

## Decision

Speedwave does not require Docker Desktop. Each supported platform uses a native hypervisor that hosts a Linux VM running containerd + nerdctl: Lima (on Apple's Virtualization Framework) on macOS, WSL2 (on Hyper-V) on Windows.

## Why

- Docker Desktop needs a paid commercial license for larger companies (over 250 employees or over $10M revenue), per the [Docker Subscription Service Agreement](https://www.docker.com/legal/docker-subscription-service-agreement/).
- It is heavyweight on macOS, running a full LinuxKit VM (see [Docker Desktop for Mac architecture](https://docs.docker.com/desktop/mac/apple-silicon/)).
- The native alternatives are free, faster to start, and better integrated with the OS.
- macOS: [Lima](https://lima-vm.io/) is open-source and runs on Apple's Virtualization Framework (the native macOS hypervisor) via Lima's vzNAT networking.
- Windows: WSL2 is built into Windows 10/11 and runs on the native Hyper-V layer (see the [WSL version comparison](https://learn.microsoft.com/en-us/windows/wsl/compare-versions)).

## Where it lives in code

- macOS runtime (Lima, vzNAT host gateway, Lima 0.11.0+ requirement) — `crates/speedwave-runtime/src/runtime/lima.rs`
- Windows runtime (WSL2 distro management, containerd/buildkit inside the distro) — `crates/speedwave-runtime/src/runtime/wsl.rs`
- Lima vzNAT static host IP (192.168.5.2) — `crates/speedwave-runtime/src/consts.rs` (`LIMA_VZ_HOST_IP`)
- Public runtime façade selecting the per-platform implementation — `crates/speedwave-runtime/src/runtime/locked.rs` (see [ADR-066](ADR-066-locked-runtime-per-project-compose-lock.md))

## Rejected alternatives

- **Rancher Desktop** — required KVM on Linux, an extra dependency for the Linux host path that was later dropped entirely (see [ADR-059](ADR-059-drop-linux-support.md)).
- **Podman Desktop on macOS** — used QEMU instead of Apple's Virtualization Framework, which is slower (see [Lima vmType: vz vs qemu](https://lima-vm.io/docs/config/vmtype/)).
