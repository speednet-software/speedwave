# ADR-025: Linux .deb Packaging (Replaces AppImage)

> **Status:** Accepted
> **Supersedes:** [ADR-023](ADR-023-appimage-static-runtime-for-fuse-independence.md)

---

## Context

Speedwave shipped on Linux as an AppImage (ADR-003, ADR-023). While AppImage provided distribution-agnostic single-file packaging, five fundamental problems made it unsuitable for Speedwave's container-management use case:

1. **Mount path changes on every launch.** AppImage mounts its SquashFS to `/tmp/.mount_XXXXXX/` with a random suffix.[^1] Systemd user units for containerd reference the old mount path in their `ExecStart` directive. After relaunch, systemd fails because the path no longer exists.

2. **Cannot install AppArmor profiles.** Ubuntu 24.04+ restricts unprivileged user namespaces via AppArmor.[^2] The AppArmor profile must be installed to `/etc/apparmor.d/` (root-owned). AppImage has no post-install hooks — the app must use `pkexec` at runtime, which requires a polkit agent (not available in headless/SSH sessions).

3. **Cannot declare system dependencies.** Speedwave requires `uidmap` and `dbus-user-session` for rootless containers. AppImage cannot express package dependencies — users discover missing packages only at runtime via cryptic error messages.

4. **linuxdeploy corrupts ELF binaries.** The AppImage build toolchain (`linuxdeploy`) patches `rpath` in all ELF binaries found in `usr/bin/`.[^3] This breaks the bundled nerdctl-full binaries (containerd, buildkit, CNI plugins), requiring manual exclusion or post-build repair.

5. **No systemd integration.** AppImage cannot install systemd user service units. The containerd setup script must create them at runtime, leading to stale units on every relaunch (see problem 1).

### Precedents

Other Tauri-based and container-management desktop apps chose `.deb` over AppImage:

- **Docker Desktop** — `.deb` packages with systemd integration[^4]
- **Rancher Desktop** — `.deb` packages[^5]
- **Firezone** (Tauri) — `.deb` packages for Linux[^6]

## Decision

Replace AppImage with **.deb** as the only Linux distribution format.

### Packaging

- **`.deb`**: Declares `uidmap` and `dbus-user-session` as dependencies. Installs the AppArmor profile to `/etc/apparmor.d/speedwave.rootlesskit` via dpkg.
- **AppArmor profile**: Pre-installed by the `.deb` package. The runtime `ensure_apparmor_profile()` function remains as a fallback for manual upgrades.

### Auto-Update Trade-off

Tauri's built-in updater supports only AppImage on Linux.[^7] With `.deb`, in-place auto-update is not possible. The mitigation:

- `check_for_update()` continues to work — it compares versions via the GitHub Releases endpoint
- The UI shows a "Download" button (instead of "Restart") on Linux, linking to GitHub Releases
- Desktop app installation remains manual on Linux `.deb`; the desktop UI directs the user to GitHub Releases, and startup reconcile applies the new bundle on the next launch

### Binary Paths

`.deb` installs to standard FHS paths:

| File             | Path                                    |
| ---------------- | --------------------------------------- |
| Desktop binary   | `/usr/bin/speedwave-desktop`            |
| Resources        | `/usr/lib/Speedwave/`                   |
| AppArmor profile | `/etc/apparmor.d/speedwave.rootlesskit` |

## Consequences

### Positive

- **Stable binary paths.** No more random mount points — systemd units survive app restarts
- **AppArmor profile pre-installed.** No `pkexec` prompt on first launch (`.deb` installs it automatically)
- **Dependencies declared.** `apt install ./speedwave.deb` pulls in `uidmap` and `dbus-user-session` automatically
- **No ELF corruption.** Standard dpkg packaging does not modify binary `rpath`
- **Systemd-friendly.** Standard package management integrates naturally with systemd

### Negative

- **No in-app auto-update on Linux.** Users must download new `.deb` from GitHub Releases manually. The app detects new versions and shows a download link.
- **Not distribution-agnostic.** Arch Linux, Void Linux, Fedora, and other non-deb distros are not directly supported. These represent a small fraction of the desktop Linux market.[^8]

## Rejected Alternatives

### 1. Fix AppImage issues individually

Each of the five problems has a workaround, but the combination creates unsustainable complexity. The mount-path issue alone requires cleanup logic that runs on every launch, and the ELF corruption requires post-build scripting. `.deb` eliminates all five problems at once.

### 2. Flatpak

Flatpak's Bubblewrap sandbox restricts access to Linux namespaces, cgroups, and `/run/user/<uid>/` — all required by rootless containerd.[^9] Running containers inside a Flatpak sandbox is not supported.

### 3. Snap

Snap's confinement model has similar restrictions to Flatpak for container management. Additionally, Snap requires `snapd`, which is not available on all distributions.[^10]

---

[^1]: [AppImage Type 2 runtime — SquashFS mount behavior](https://docs.appimage.org/reference/architecture.html)

[^2]: [Ubuntu 23.10+ restricts unprivileged user namespaces](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces)

[^3]: [linuxdeploy — ELF binary patching](https://github.com/linuxdeploy/linuxdeploy)

[^4]: [Docker Desktop for Linux — .deb packages](https://docs.docker.com/desktop/install/linux/)

[^5]: [Rancher Desktop releases — .deb packages](https://github.com/rancher-sandbox/rancher-desktop/releases)

[^6]: [Firezone Linux packages](https://www.firezone.dev/kb/deploy/linux)

[^7]: [Tauri Updater — Linux support limited to AppImage](https://tauri.app/plugin/updater/)

[^8]: [DistroWatch — distribution popularity](https://distrowatch.com/dwres.php?resource=popularity)

[^9]: [Flatpak sandbox limitations for container tools](https://docs.flatpak.org/en/latest/sandbox-permissions.html)

[^10]: [Snap confinement model](https://snapcraft.io/docs/snap-confinement)
