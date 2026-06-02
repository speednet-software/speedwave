# ADR-003: Bundled nerdctl-full on Linux

> **Status:** Superseded by [ADR-059](ADR-059-drop-linux-support.md) (Linux was dropped as a host platform — only macOS/Lima and Windows/WSL2 remain). Distribution details superseded/extended by [ADR-025](ADR-025-linux-deb-packaging.md). Originally Accepted (it replaced an earlier "Podman instead of nerdctl on Linux" decision).
> **Context:** Historical record of how Speedwave once intended to ship a container runtime on Linux.

This ADR describes a past decision. Linux is no longer supported, so nothing here reflects the current product — it is preserved for the rationale.

## Decision

At the time, Speedwave bundled **nerdctl-full** (rootless containerd) inside the Linux `.deb` package rather than declaring Podman as a system package dependency. On first launch it extracted the tarball to `~/.speedwave/nerdctl-full/` and registered containerd as a per-user systemd service via the bundled `containerd-rootless-setuptool.sh`. Auto-update was a version check plus a GitHub Releases download link (the Tauri updater never supported `.deb`).

## Why

- **Single-file, offline install.** Bundling the whole runtime (containerd, nerdctl, runc, BuildKit, CNI plugins) meant containers could run with no network calls and no external runtime package to fetch.
- **One runtime CLI across platforms (as planned then).** macOS and Windows already used nerdctl (in a VM); making Linux use nerdctl too avoided a separate Podman/`podman-compose` code path. (In practice Linux was later dropped entirely — see Note below.)
- **Rootless by default.** Rootless containerd ran without root and without a setuid daemon, matching Podman's security posture.

## Note on what actually shipped

The "unified runtime across all three platforms" goal in the original Positive consequences never materialised. Linux was dropped before a Linux runtime impl shipped (ADR-059). The codebase today carries exactly two implementations of the internal `ContainerRuntime` trait — `LimaRuntime` (macOS) and `WslRuntime` (Windows) — and no `NerdctlRuntime` or `PodmanRuntime`. The trait is `pub(crate)` behind the `LockedRuntime` façade (ADR-066).

## Where it lives in code (current)

- Runtime trait + factory — `crates/speedwave-runtime/src/runtime/mod.rs`
- macOS impl — `crates/speedwave-runtime/src/runtime/lima.rs` (`LimaRuntime`)
- Windows impl — `crates/speedwave-runtime/src/runtime/wsl.rs` (`WslRuntime`)
- Public façade / per-project compose lock — `crates/speedwave-runtime/src/runtime/locked.rs` (ADR-066)

## Original system requirements (Linux, no longer relevant)

The `.deb` plan relied on host facilities that were **not** bundled: the `uidmap` package (`newuidmap`/`newgidmap`) for rootless UID/GID mapping, a `systemd --user` session for the containerd unit, `/etc/subuid` + `/etc/subgid` ranges for the user, and `dbus-user-session`. The Setup Wizard checked these on first launch. The `systemd --user` requirement excluded OpenRC/runit/s6 distros (Alpine, Void, Artix).

## Rejected alternatives (preserved rationale)

- **Podman as a `.deb` dependency** (the prior decision) — added an external runtime dependency and a second `PodmanRuntime` to maintain, plus either per-distro packaging or a custom repository.
- **Lima + QEMU on Linux** — QEMU is a ~200 MB dependency that cannot be easily bundled, and running a VM to run containers is needless overhead when Linux can run rootless containerd natively.
- **Docker Engine** — `dockerd` requires a root-owned daemon and `docker`-group membership (root-equivalent), violating minimal-privilege.
- **Flatpak** — its Bubblewrap sandbox restricts the namespaces, cgroups, and `/run/user/<uid>/` access that rootless containerd needs.
- **Snap** — same confinement problem as Flatpak, plus it requires the `snapd` daemon, absent by default on many distros.

---

## References

- [Debian package management — .deb format](https://www.debian.org/doc/debian-policy/ch-relationships.html)
- [Tauri Updater](https://tauri.app/plugin/updater/)
- [nerdctl releases — containerd + nerdctl + CNI + BuildKit](https://github.com/containerd/nerdctl/releases)
- [nerdctl rootless mode](https://github.com/containerd/nerdctl/blob/main/docs/rootless.md)
- [Rootless containers — subuid/subgid](https://rootlesscontaine.rs/getting-started/common/subuid/)
- [subuid(5) man page](https://man7.org/linux/man-pages/man5/subuid.5.html)
