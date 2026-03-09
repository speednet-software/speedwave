# ADR-003: Bundled nerdctl-full on Linux

> **Status:** Accepted (replaces "Podman Instead of nerdctl on Linux")

---

## Context

The previous Linux strategy (ADR-003 v1) declared Podman as a `.deb`/`.rpm` package dependency. This approach had three fundamental problems:

1. **Prevented AppImage distribution.** AppImage is a single-file, distribution-agnostic format that works on any Linux distro without installation.[^1] Packaging as `.deb`/`.rpm` means separate release artifacts per distro family, and requires packaging Speedwave into each distro's repository or using a custom package source — significant ongoing maintenance burden.

2. **Prevented auto-update via Tauri updater.** Tauri's built-in updater supports AppImage on Linux.[^2] It does not support `.deb`/`.rpm` — those formats delegate updates to the system package manager (`apt`, `dnf`). Users on `.deb`/`.rpm` installs would need to manually download each release or set up a custom repository. AppImage is the only format that enables seamless in-app updates on Linux matching the macOS `.dmg` experience.

3. **Inconsistent container runtime across platforms.** macOS uses nerdctl (via Lima). Windows uses nerdctl (via WSL2). Linux using Podman meant a different CLI, different compose behavior (`podman-compose` vs `nerdctl compose`), and two separate `ContainerRuntime` implementations to maintain and test. This violates DRY and increases the risk of platform-specific bugs.

## Decision

Bundle **nerdctl-full** (rootless containerd) inside the AppImage instead of declaring Podman as a system package dependency.

### Distribution Format

The Linux release artifact is an **AppImage** (not `.deb` or `.rpm`). A single `Speedwave-x86_64.AppImage` or `Speedwave-aarch64.AppImage` file works on any systemd-based Linux distribution without requiring FUSE. See [ADR-023](ADR-023-appimage-static-runtime-for-fuse-independence.md).

### Bundled Contents

nerdctl-full is bundled at `<AppImage>/usr/share/speedwave/nerdctl-full/`.[^3] The tarball includes:

- `containerd` + `containerd-shim-runc-v2`
- `nerdctl` (CLI and compose)
- `runc` (OCI runtime)
- `BuildKit` (`buildkitd` + `buildctl`)
- CNI plugins (`bridge`, `firewall`, `host-local`, `loopback`, `portmap`)
- `containerd-rootless-setuptool.sh` + `containerd-rootless.sh`

### First-Launch Extraction

On first launch, Speedwave extracts the bundled nerdctl-full tarball to `~/.speedwave/nerdctl-full/` and runs:

```bash
~/.speedwave/nerdctl-full/bin/containerd-rootless-setuptool.sh install
```

This registers `containerd` as a `systemd --user` service (`containerd.service`) for the current user.[^4] Subsequent launches check whether the service is active before starting containers.

### Binary Resolution Order

1. `SPEEDWAVE_RESOURCES_DIR` environment variable — used in development and testing
2. `~/.speedwave/nerdctl-full/bin/` — production path, extracted from the bundled tarball on first launch
3. System PATH fallback — development mode only

### Auto-Update

AppImage supports the Tauri updater protocol.[^2] When a new Speedwave version is released on GitHub Releases, the app detects the update, downloads the new AppImage in the background, and prompts the user to restart. No system package manager or root privileges are needed.

## System Requirements

The following must be present on the host system and are **not bundled** (they are OS-level primitives that cannot be shipped inside an AppImage):

| Requirement                                    | Purpose                                   | Notes                                                                                                               |
| ---------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `uidmap` package (`newuidmap` / `newgidmap`)   | Rootless user namespace mapping[^5]       | `apt install uidmap` / `dnf install shadow-utils`                                                                   |
| `systemd --user`                               | containerd service unit[^4]               | Required; excludes Alpine, Void, OpenRC-based distros                                                               |
| `/etc/subuid` + `/etc/subgid` entries for user | UID/GID range for rootless containers[^6] | Configured automatically by `containerd-rootless-setuptool.sh` if missing                                           |
| ~~FUSE / `libfuse2`~~                          | ~~AppImage mounting~~                     | No longer required — static type2-runtime since [ADR-023](ADR-023-appimage-static-runtime-for-fuse-independence.md) |

Speedwave's Setup Wizard checks the three active requirements on first launch and guides the user through any missing steps with clear error messages.

## Consequences

### Positive

- **Full auto-update support.** The Tauri updater works out of the box with AppImage — same experience as macOS.
- **Offline install.** Everything needed to run containers is bundled. Users in air-gapped environments or with restricted internet access can install from a USB drive without any network calls.
- **Distribution-agnostic.** One AppImage works on Ubuntu, Debian, Fedora, Arch, openSUSE, and any other systemd-based distro — no separate packaging per distro.
- **Unified container runtime.** All three platforms (macOS, Linux, Windows) use `nerdctl compose`. The `ContainerRuntime` trait needs only two implementations: `LimaRuntime` (wraps nerdctl-in-VM) and `NerdctlRuntime` / `WslRuntime` (call nerdctl directly). No Podman code path to maintain.
- **Rootless by default.** nerdctl with rootless containerd runs without root privileges and without a setuid daemon — matching the security posture of Podman.

### Negative / Trade-offs

- **AppImage size ~300 MB.** The nerdctl-full tarball (containerd + nerdctl + BuildKit + CNI plugins) is approximately 250–300 MB compressed.[^3] This is larger than a minimal `.deb` that declares Podman as a dependency, but comparable to other developer tools distributed as AppImages (e.g., JetBrains IDEs, VS Code).
- **systemd required.** Distributions using OpenRC, runit, s6, or other init systems are not supported. This excludes Alpine Linux, Void Linux, Artix Linux, and similar. These distros are rare in desktop use and represent a negligible share of the target user base.
- **~~FUSE required.~~** No longer applicable — the AppImage is repacked with a static type2-runtime that bundles libfuse. See [ADR-023](ADR-023-appimage-static-runtime-for-fuse-independence.md).
- **One-time extraction on first launch.** The user sees a brief "Setting up Speedwave..." screen on first launch while the tarball is extracted and containerd is registered as a systemd service. This is a one-time cost.

## Rejected Alternatives

### 1. Podman as .deb/.rpm package dependency

The previous approach. Rejected because:

- Prevents AppImage distribution → prevents auto-update and offline install.
- Requires maintaining a separate `PodmanRuntime` implementation alongside `NerdctlRuntime`, increasing the maintenance surface.
- `.deb`/`.rpm` require either separate packaging per distro family or a custom package repository — significant ongoing maintenance burden.

### 2. Lima + QEMU on Linux

Lima also supports Linux (using QEMU instead of Apple Virtualization Framework).[^8] Rejected because:

- QEMU is an additional ~200 MB system dependency that cannot be easily bundled.
- Running a VM on Linux to run containers adds unnecessary overhead when Linux can run rootless containerd natively without a VM layer.
- The user still has to install QEMU or Speedwave must bundle it — neither is better than bundling nerdctl-full directly.

### 3. Docker Engine (dockerd)

Rejected because Docker requires a root-owned daemon (`dockerd`) running as a system service, which requires `sudo` or membership in the `docker` group (equivalent to root access).[^9] This violates the security principle of minimal privilege. Podman and nerdctl both support rootless operation without a privileged daemon.

### 4. Flatpak instead of AppImage

Rejected because Flatpak's Bubblewrap sandbox restricts access to Linux namespaces, cgroups, and `/run/user/<uid>/` — all of which rootless containerd requires.[^10] Running containers inside a Flatpak sandbox is not supported without disabling the sandbox entirely, which defeats its purpose.

### 5. Snap

Rejected for similar reasons to Flatpak. Snap's confinement model blocks the kernel interfaces needed for rootless container management.[^11] Additionally, Snap requires the `snapd` daemon, which is not present by default on all Linux distributions.

---

[^1]: [AppImage — Linux apps that run anywhere](https://appimage.org/)

[^2]: [Tauri Updater — AppImage support on Linux](https://tauri.app/plugin/updater/)

[^3]: [nerdctl-full releases — containerd + nerdctl + CNI + BuildKit](https://github.com/containerd/nerdctl/releases)

[^4]: [nerdctl rootless mode — containerd-rootless-setuptool.sh](https://github.com/containerd/nerdctl/blob/main/docs/rootless.md)

[^5]: [rootless containers — uidmap / newuidmap requirement](https://rootlesscontaine.rs/getting-started/common/uidmap/)

[^6]: [/etc/subuid and /etc/subgid — subordinate UID/GID ranges](https://man7.org/linux/man-pages/man5/subuid.5.html)

[^8]: [Lima vmType: vz vs qemu](https://lima-vm.io/docs/config/vmtype/)

[^9]: [Docker security — docker group is equivalent to root](https://docs.docker.com/engine/security/#docker-daemon-attack-surface)

[^10]: [Flatpak sandbox permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html)

[^11]: [Snap confinement — strict, classic, devmode](https://snapcraft.io/docs/snap-confinement)
