# ADR-059: Drop Linux Support — Windows and macOS Only

**Status:** Accepted

**Date:** 2026-05-15

## Context

Speedwave previously shipped on three host platforms: macOS (via Lima), Windows (via WSL2), and Linux (via rootless nerdctl on the host). Each platform required a distinct container-runtime implementation behind `Box<dyn ContainerRuntime>`: `LimaRuntime`, `WslRuntime`, and `NerdctlRuntime`. The Linux path additionally carried:

- A 937-line `NerdctlRuntime` that installed and supervised user-level containerd + buildkit via `systemd --user`,[^1] parsed `nerdctl info`[^2] for rootless-mode enforcement, and managed an AppArmor profile for rootlesskit.[^3]
- A platform-specific UID mapping (`CONTAINER_USER = "0:0"`) and the slirp4netns[^4] host-gateway address (`10.0.2.2`), threaded through `compose.template.yml` (see superseded ADR-026).
- A `.deb` bundle target with `uidmap`[^5] / `dbus-user-session` package dependencies, a bundled `nerdctl-full`[^6] distribution (~80 MB of containerd/runc/CNI/rootlesskit binaries shipped inside the Debian package, per superseded ADR-003), and an AppArmor profile installed to `/etc/apparmor.d/speedwave.rootlesskit`.
- A Linux-specific audio-capture backend (`audio_linux.rs`, 902 lines) for the host-side transcription feature.
- An `ubuntu-22.04` matrix entry in three GitHub Actions workflows, plus `make _e2e-linux` and `scripts/e2e-vm*.sh` SSH-driven end-to-end provisioning of a fresh Ubuntu host.
- A non-trivial slice of the desktop frontend (setup wizard step copy, update notification UI, settings panel) that branched on `platform === 'linux'` because Linux has no in-app updater (Tauri's `NSIS`/`squirrel`-equivalent flow is unavailable; users download the new `.deb` manually).

The maintenance cost of the Linux path is not proportional to its user base. Rootless nerdctl in particular is fragile: each new containerd or buildkit release shifts the `nerdctl info` output we parse, distros disagree on whether `newuidmap` ships in `uidmap` or `shadow-utils`, and the AppArmor profile breaks on every Ubuntu LTS that tightens its abstractions. The team has decided to focus on macOS and Windows, where the Lima- and WSL2-based VM isolation gives a stronger and more uniform security boundary, and where the container runtime is the same upstream nerdctl binary running under the same kernel inside the same kind of lightweight Hyper-V/QEMU VM.

## Decision

Drop Linux as a supported host platform. The application targets macOS (Lima) and Windows (WSL2) only.

### Removed from the codebase

- `crates/speedwave-runtime/src/runtime/nerdctl.rs` (the `NerdctlRuntime` impl)
- `crates/speedwave-runtime/src/transcription/audio_linux.rs`
- `desktop/src-tauri/tauri.linux.conf.json`
- `desktop/src-tauri/packaging/linux/` (AppArmor profile)
- All `#[cfg(target_os = "linux")]` blocks across the runtime crate and the desktop Tauri crate
- Linux branches in `containers/compose.template.yml`, `containers/entrypoint.sh`, the `Makefile`, and `scripts/e2e-vm*.sh`
- `ubuntu-22.04` / `ubuntu-latest` matrix entries from `.github/workflows/desktop-build.yml`, `desktop-release.yml`, and `test.yml`
- `.deb` from `release-please-config.json` and the Tauri bundle target list

### Simplified

- `compose::container_user()` is kept (the `${CONTAINER_USER}` placeholder still appears in `compose.template.yml` and is still substituted by `render_compose`), but the function now unconditionally returns `"1000:1000"`. No platform branch, no rootless `"0:0"` fallback. Call sites are unchanged for minimal churn.
- `detect_runtime()` returns a `LockedRuntime` wrapping `LimaRuntime` on macOS and `WslRuntime` on Windows; any other `target_os` is a compile error. (`LockedRuntime` is the public façade introduced by the per-project compose-transaction lock — see ADR-066. The wrapped trait `ContainerRuntime` is `pub(crate)` and cannot be named from outside the crate.)
- The platform-detection enum in the Angular setup wizard collapses from `'darwin' | 'win32' | 'linux'` to `'darwin' | 'win32'`.

### Preserved as historical record

ADR-003 (bundled nerdctl-full on Linux), ADR-025 (Linux `.deb` packaging), and ADR-026 (rootless container user) are marked `Status: Superseded by ADR-059` and otherwise left intact. They remain the canonical explanation of why the Linux path looked the way it did, for anyone reading the git history.

## Consequences

- **Positive — surface area:** ~3 000 lines of Linux-specific Rust, ~500 lines of TS/Angular branching, three CI matrix legs, one packaging format, and one ADR cluster (003/025/026) leave the active maintenance set. Future runtime changes no longer have to be triple-implemented or triple-tested.
- **Positive — security model uniformity:** every supported deployment now runs the container under a lightweight VM (Lima on macOS, WSL2 on Windows). The "rootless on the host" defense-in-depth gap that ADR-026 had to work around no longer exists; the VM boundary is the same on both platforms.
- **Positive — release artefacts shrink:** no `.deb` is built or published. Release pipelines run on `macos-14` and `windows-2022` only.
- **Negative — Linux users lose support:** anyone running Speedwave on a Debian/Ubuntu/Fedora host must either move to macOS or Windows, or pin the last release that included `linux-rm`'s parent commit. There is no migration path; the design assumed a VM-mediated container runtime that does not exist on the Linux host path.
- **Negative — lost prior art:** the rootless-on-host work documented in ADR-026 demonstrated that running with `cap_drop: ALL` + `no-new-privileges` + `read_only: true` under a user namespace is a workable security posture even without a VM. We are not deleting the ADR — the design remains a reference if Speedwave ever revisits a non-VM Linux path.
- **Neutral — plugin contract unchanged:** plugin workers are container images, not host binaries. The plugin manifest, signing scheme (ADR-051), and compose injection (`apply_plugins`) are identical on both remaining platforms. Plugin authors do not have to do anything.

[^1]: containerd-rootless setuptool installs containerd and buildkit as systemd `--user` services — see `containerd/nerdctl` rootless mode docs: https://github.com/containerd/nerdctl/blob/main/docs/rootless.md

[^2]: `nerdctl info` command reference: https://github.com/containerd/nerdctl/blob/main/docs/command-reference.md#nerdctl-info

[^3]: rootlesskit AppArmor profile background (Ubuntu 24.04+ unprivileged user-namespace restrictions): https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces

[^4]: slirp4netns provides user-mode networking for unprivileged network namespaces; the default host-gateway address is `10.0.2.2`. See: https://github.com/rootless-containers/slirp4netns

[^5]: `uidmap` Debian package ships `newuidmap`/`newgidmap` setuid binaries required for user-namespace remapping: https://packages.debian.org/bookworm/uidmap

[^6]: `nerdctl-full` release artefacts bundle containerd, runc, BuildKit, CNI plugins, and rootlesskit: https://github.com/containerd/nerdctl/releases
