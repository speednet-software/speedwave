# ADR-001: Eliminate Docker Desktop

## Decision

Speedwave does not require Docker Desktop. Native hypervisors are used per platform.

## Rationale

Docker Desktop requires a commercial license for companies with more than 250 employees or over $10M in revenue.[^1] It is also heavyweight — it runs a full LinuxKit VM on macOS under the hood.[^2]

Native alternatives are free, faster, and better integrated with the OS:

| Platform | Solution                              | Rationale                                                                                              |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| macOS    | Lima + Apple Virtualization Framework | Lima is open-source; Apple VZ is the native macOS hypervisor also used by UTM and Parallels[^3]        |
| Linux    | nerdctl-full bundled in .deb          | nerdctl-full (containerd + nerdctl + CNI + BuildKit) is bundled; rootless containerd, no VM needed[^4] |
| Windows  | WSL2 + Hyper-V                        | Built into Windows 10/11 Pro, free, uses native Hyper-V[^5]                                            |

## Rejected Alternatives

- **Rancher Desktop** — requires KVM on Linux, extra dependency[^6]
- **Podman Desktop on macOS** — uses QEMU instead of Apple VZ, slower[^7]
- **Podman as .deb dependency** — adds package dependency that restricts distribution flexibility (see ADR-003, ADR-025)

---

[^1]: [Docker Desktop Subscription Service Agreement](https://www.docker.com/legal/docker-subscription-service-agreement/)

[^2]: [Docker Desktop for Mac architecture](https://docs.docker.com/desktop/mac/apple-silicon/)

[^3]: [Lima - Linux virtual machines on macOS](https://lima-vm.io/)

[^4]: [nerdctl-full releases — containerd + nerdctl + CNI + BuildKit](https://github.com/containerd/nerdctl/releases)

[^5]: [WSL2 architecture - Microsoft Docs](https://learn.microsoft.com/en-us/windows/wsl/compare-versions)

[^6]: [Rancher Desktop Installation - KVM requirement](https://docs.rancherdesktop.io/getting-started/installation/)

[^7]: [Lima vmType: vz vs qemu](https://lima-vm.io/docs/config/vmtype/)
