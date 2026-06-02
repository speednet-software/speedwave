# ADR-025: Linux .deb Packaging (Replaced AppImage)

> **Status:** Superseded by [ADR-059](ADR-059-drop-linux-support.md) — Linux was dropped as a host platform entirely, so neither `.deb` nor AppImage is built anymore. This ADR is historical. It superseded [ADR-023](ADR-023-appimage-static-runtime-for-fuse-independence.md).
> **Context:** While Linux was still supported, AppImage packaging proved unsuitable for a container-management app and was replaced by `.deb`.

## Decision

Replaced AppImage with `.deb` as the only Linux distribution format. The `.deb` declared `uidmap` and `dbus-user-session` as system dependencies and pre-installed an AppArmor profile to `/etc/apparmor.d/speedwave.rootlesskit` via dpkg; the runtime `ensure_apparmor_profile()` helper remained as a fallback for manual upgrades. (All of this is moot today — see ADR-059.)

## Why

AppImage created five problems that `.deb` solved at once:

- **Mount path changed on every launch.** AppImage mounted its SquashFS to a random `/tmp/.mount_XXXXXX/`,[^1] so systemd user units for containerd pointed at a path that disappeared on relaunch.
- **Could not install AppArmor profiles.** Ubuntu 24.04+ restricted unprivileged user namespaces via AppArmor;[^2] the profile must live in root-owned `/etc/apparmor.d/`, but AppImage had no post-install hooks (forcing a `pkexec`/polkit prompt unavailable in headless/SSH sessions).
- **Could not declare system dependencies.** Rootless containers needed `uidmap` and `dbus-user-session`; AppImage could not express package deps, so users hit cryptic runtime errors.
- **`linuxdeploy` corrupted ELF binaries.** The AppImage toolchain patched `rpath` in ELF binaries,[^3] breaking the bundled nerdctl-full binaries (containerd, buildkit, CNI plugins).
- **No systemd integration.** AppImage could not install systemd user service units, so they had to be created at runtime — leading back to the stale-mount-path problem.

Other Tauri / container-management desktop apps reached the same conclusion: Docker Desktop,[^4] Rancher Desktop,[^5] and Firezone[^6] all shipped `.deb` over AppImage.

The trade-off accepted: Tauri's updater supported only AppImage on Linux,[^7] so `.deb` had no in-app auto-update. The mitigation was a version check against GitHub Releases plus a "Download" button (instead of "Restart") that directed users to the release page; the new bundle was reconciled on next launch. `.deb` also was not distribution-agnostic (no Arch, Void, Fedora, etc.[^8]).

## Where it lives in code

This decision left no live code — ADR-059 removed Linux as a host platform. There is no `.deb` packaging, AppArmor profile, or `ensure_apparmor_profile()` in the current tree; supported hosts are macOS (Lima) and Windows (WSL2) only. See `crates/speedwave-runtime/src/runtime/` and `docs/adr/ADR-059-drop-linux-support.md`.

## Rejected alternatives

- **Fix AppImage issues individually.** Each of the five problems had a workaround, but their combination (per-launch mount cleanup, post-build ELF repair) was unsustainable. `.deb` eliminated all five at once.
- **Flatpak.** Its Bubblewrap sandbox restricts Linux namespaces, cgroups, and `/run/user/<uid>/` — all required by rootless containerd.[^9]
- **Snap.** Similar confinement restrictions to Flatpak, plus a hard `snapd` dependency not present on every distribution.[^10]

[^1]: [AppImage Type 2 runtime — SquashFS mount behavior](https://docs.appimage.org/reference/architecture.html)

[^2]: [Ubuntu 23.10+ restricts unprivileged user namespaces](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces)

[^3]: [linuxdeploy — ELF binary patching](https://github.com/linuxdeploy/linuxdeploy)

[^4]: [Docker Desktop for Linux — .deb packages](https://docs.docker.com/desktop/install/linux/)

[^5]: [Rancher Desktop releases — .deb packages](https://github.com/rancher-sandbox/rancher-desktop/releases)

[^6]: [Firezone Linux GUI Client — .deb via APT](https://www.firezone.dev/kb/client-apps/linux-gui-client)

[^7]: [Tauri Updater — Linux support limited to AppImage](https://tauri.app/plugin/updater/)

[^8]: [DistroWatch — distribution popularity](https://distrowatch.com/dwres.php?resource=popularity)

[^9]: [Flatpak sandbox limitations for container tools](https://docs.flatpak.org/en/latest/sandbox-permissions.html)

[^10]: [Snap confinement model](https://snapcraft.io/docs/snap-confinement)
