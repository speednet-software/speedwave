# ADR-003: Bundled nerdctl-full on Linux

> **Status:** Accepted (replaces "Podman Instead of nerdctl on Linux")

---

## Context

The previous Linux strategy (ADR-003 v1) declared Podman as a `.deb` package dependency. This approach had three fundamental problems:

1. **Prevented single-file distribution.** `.deb` is the standard Linux packaging format that declares system dependencies and integrates with package managers.[^1] Packaging as `.deb` means separate release artifacts, and requires packaging Speedwave into the distro's repository or using a custom package source — significant ongoing maintenance burden.

2. **Limited update options.** Tauri's built-in updater supports only AppImage on Linux (now superseded — see ADR-025).[^2] It does not support `.deb` — that format delegates updates to the system package manager (`apt`). Users on `.deb` installs would need to manually download each release or set up a custom repository.

3. **Inconsistent container runtime across platforms.** macOS uses nerdctl (via Lima). Windows uses nerdctl (via WSL2). Linux using Podman meant a different CLI, different compose behavior (`podman-compose` vs `nerdctl compose`), and two separate `ContainerRuntime` implementations to maintain and test. This violates DRY and increases the risk of platform-specific bugs.

## Decision

Bundle **nerdctl-full** (rootless containerd) inside the .deb package instead of declaring Podman as a system package dependency.

### Distribution Format

The Linux release artifact is **.deb** (Debian/Ubuntu). See [ADR-025](ADR-025-linux-deb-packaging.md) for the migration from AppImage.

### Bundled Contents

nerdctl-full is bundled at `/usr/lib/Speedwave/nerdctl-full/`.[^3] The tarball includes:

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

Auto-update on Linux is handled via version check + download link to GitHub Releases (see ADR-025). The Tauri updater does not support .deb.[^2]

## System Requirements

The following must be present on the host system and are **not bundled** (they are declared as package dependencies in .deb — see ADR-025):

| Requirement                                    | Purpose                                   | Notes                                                                       |
| ---------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| `uidmap` package (`newuidmap` / `newgidmap`)   | Rootless user namespace mapping[^5]       | `apt install uidmap` / `dnf install shadow-utils`                           |
| `systemd --user`                               | containerd service unit[^4]               | Required; excludes Alpine, Void, OpenRC-based distros                       |
| `/etc/subuid` + `/etc/subgid` entries for user | UID/GID range for rootless containers[^6] | Configured automatically by `containerd-rootless-setuptool.sh` if missing   |
| `dbus-user-session`                            | D-Bus user session bus[^3]                | Required for rootless containers; declared as .deb dependency (see ADR-025) |

Speedwave's Setup Wizard checks the three active requirements on first launch and guides the user through any missing steps with clear error messages.

## Consequences

### Positive

- **Dependencies declared.** .deb packages declare required system packages (uidmap, dbus-user-session).
- **Offline install.** Everything needed to run containers is bundled. Users in air-gapped environments or with restricted internet access can install from a USB drive without any network calls.
- **Standard package format.** .deb works on Debian/Ubuntu/derivatives — covering the majority of desktop Linux users.
- **Unified container runtime.** All three platforms (macOS, Linux, Windows) use `nerdctl compose`. The `ContainerRuntime` trait needs only two implementations: `LimaRuntime` (wraps nerdctl-in-VM) and `NerdctlRuntime` / `WslRuntime` (call nerdctl directly). No Podman code path to maintain.
- **Rootless by default.** nerdctl with rootless containerd runs without root privileges and without a setuid daemon — matching the security posture of Podman.

### Negative / Trade-offs

- **Package size ~300 MB.** The nerdctl-full tarball (containerd + nerdctl + BuildKit + CNI plugins) is approximately 250–300 MB compressed.[^3] This is larger than a minimal `.deb` that declares Podman as a dependency, but comparable to other developer tools distributed as packages (e.g., VS Code, Docker Desktop).
- **systemd required.** Distributions using OpenRC, runit, s6, or other init systems are not supported. This excludes Alpine Linux, Void Linux, Artix Linux, and similar. These distros are rare in desktop use and represent a negligible share of the target user base.
- **No in-app auto-update on Linux.** Users must download new `.deb` from GitHub Releases manually. The app detects new versions and shows a download link (see ADR-025).
- **One-time extraction on first launch.** The user sees a brief "Setting up Speedwave..." screen on first launch while the tarball is extracted and containerd is registered as a systemd service. This is a one-time cost.

## Rejected Alternatives

### 1. Podman as .deb package dependency

The previous approach. Rejected because:

- Adds external runtime dependency. Requires maintaining a separate container runtime implementation.
- Requires maintaining a separate `PodmanRuntime` implementation alongside `NerdctlRuntime`, increasing the maintenance surface.
- Requires either separate packaging per distro family or a custom package repository — significant ongoing maintenance burden.

### 2. Lima + QEMU on Linux

Lima also supports Linux (using QEMU instead of Apple Virtualization Framework).[^8] Rejected because:

- QEMU is an additional ~200 MB system dependency that cannot be easily bundled.
- Running a VM on Linux to run containers adds unnecessary overhead when Linux can run rootless containerd natively without a VM layer.
- The user still has to install QEMU or Speedwave must bundle it — neither is better than bundling nerdctl-full directly.

### 3. Docker Engine (dockerd)

Rejected because Docker requires a root-owned daemon (`dockerd`) running as a system service, which requires `sudo` or membership in the `docker` group (equivalent to root access).[^9] This violates the security principle of minimal privilege. Podman and nerdctl both support rootless operation without a privileged daemon.

### 4. Flatpak instead of .deb

Rejected because Flatpak's Bubblewrap sandbox restricts access to Linux namespaces, cgroups, and `/run/user/<uid>/` — all of which rootless containerd requires.[^10] Running containers inside a Flatpak sandbox is not supported without disabling the sandbox entirely, which defeats its purpose. See also [ADR-025](ADR-025-linux-deb-packaging.md).

### 5. Snap

Rejected for similar reasons to Flatpak. Snap's confinement model blocks the kernel interfaces needed for rootless container management.[^11] Additionally, Snap requires the `snapd` daemon, which is not present by default on all Linux distributions.

---

[^1]: [Debian package management — .deb format](https://www.debian.org/doc/debian-policy/ch-relationships.html)

[^2]: [Tauri Updater — AppImage support on Linux](https://tauri.app/plugin/updater/)

[^3]: [nerdctl-full releases — containerd + nerdctl + CNI + BuildKit](https://github.com/containerd/nerdctl/releases)

[^4]: [nerdctl rootless mode — containerd-rootless-setuptool.sh](https://github.com/containerd/nerdctl/blob/main/docs/rootless.md)

[^5]: [rootless containers — uidmap / newuidmap requirement](https://rootlesscontaine.rs/getting-started/common/uidmap/)

[^6]: [/etc/subuid and /etc/subgid — subordinate UID/GID ranges](https://man7.org/linux/man-pages/man5/subuid.5.html)

[^8]: [Lima vmType: vz vs qemu](https://lima-vm.io/docs/config/vmtype/)

[^9]: [Docker security — docker group is equivalent to root](https://docs.docker.com/engine/security/#docker-daemon-attack-surface)

[^10]: [Flatpak sandbox permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html)

[^11]: [Snap confinement — strict, classic, devmode](https://snapcraft.io/docs/snap-confinement)
