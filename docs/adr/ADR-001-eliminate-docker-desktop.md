# ADR-001: Eliminate Docker Desktop

> **Status:** Accepted
> **Context:** Speedwave needs container isolation on macOS and Windows without shipping Docker Desktop.

## Decision

Speedwave does not require Docker Desktop. Each supported platform uses a native hypervisor that hosts a Linux VM running containerd + nerdctl: Lima (on Apple's Virtualization Framework) on macOS, WSL2 (on Hyper-V) on Windows.

## Why

- Docker Desktop needs a paid commercial license for larger companies (over 250 employees or over $10M revenue).[^1]
- It is heavyweight on macOS, running a full LinuxKit VM.[^2]
- The native alternatives are free, faster to start, and better integrated with the OS.
- macOS: [Lima](https://lima-vm.io/) is open-source[^3] and runs on Apple's Virtualization Framework (the native macOS hypervisor) via Lima's vzNAT networking.[^4]
- Windows: WSL2 is built into Windows 10/11 and runs on the native Hyper-V layer.[^5]

## Where it lives in code

- macOS runtime (Lima, vzNAT host gateway, Lima 0.11.0+ requirement) — `crates/speedwave-runtime/src/runtime/lima.rs`
- Windows runtime (WSL2 distro management, containerd/buildkit inside the distro) — `crates/speedwave-runtime/src/runtime/wsl.rs`
- Lima vzNAT static host IP (192.168.5.2) — `crates/speedwave-runtime/src/consts.rs` (`LIMA_VZ_HOST_IP`)
- Public runtime façade selecting the per-platform implementation — `crates/speedwave-runtime/src/runtime/locked.rs` (see [ADR-066](ADR-066-locked-runtime-per-project-compose-lock.md))

## Rejected alternatives

- **Rancher Desktop** — required KVM on Linux[^6], an extra dependency for the Linux host path that was later dropped entirely (see [ADR-059](ADR-059-drop-linux-support.md)).
- **Podman Desktop on macOS** — used QEMU instead of Apple's Virtualization Framework at the time of this decision.[^7]

[^1]: [Docker Subscription Service Agreement](https://www.docker.com/legal/docker-subscription-service-agreement/) - Section 4.2: standalone use without a paid subscription is restricted to non-commercial open source projects or commercial use "with fewer than 250 employees and less than US $10,000,000 ... in annual revenue".

[^2]: [The Magic Behind the Scenes of Docker Desktop](https://www.docker.com/blog/the-magic-behind-the-scenes-of-docker-desktop/) (Docker blog) - "At the heart of Docker Desktop we have a lightweight LinuxKit VM that Docker manages for you."

[^3]: [lima-vm/lima LICENSE](https://github.com/lima-vm/lima/blob/master/LICENSE) - Apache License 2.0.

[^4]: [Lima Network configuration](https://lima-vm.io/docs/config/network/) and [VMNet networks](https://lima-vm.io/docs/config/network/vmnet/) - document the `vzNAT` network mode available for `vz`-type (Apple Virtualization Framework) instances.

[^5]: [Comparing WSL Versions](https://learn.microsoft.com/en-us/windows/wsl/compare-versions) (Microsoft Learn) - "WSL 2 is running as a Hyper-V virtual machine"; WSL 2 requires Windows 11 or Windows 10 version 1903 build 18362+.

[^6]: [Rancher Desktop installation requirements](https://docs.rancherdesktop.io/getting-started/installation/) - Linux requires "An x86_64 processor with either AMD-V or VT-x. Read-write access on `/dev/kvm`."

[^7]: [How Podman runs on Macs and other container FAQs](https://www.redhat.com/en/blog/podman-mac-machine-architecture) (Red Hat blog) - describes the QEMU-plus-HVF machine provider historically used on macOS, before Podman's newer `applehv` provider.
