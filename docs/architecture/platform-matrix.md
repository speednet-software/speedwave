# Platform Matrix

Speedwave supports macOS, Linux, and Windows with platform-specific VM, container, and OS integration strategies.

## Overview

| OS      | VM              | Containers              | mcp-os                    | Installer |
| ------- | --------------- | ----------------------- | ------------------------- | --------- |
| macOS   | Lima + Apple VZ | nerdctl                 | AppleScript / EventKit    | .dmg      |
| Linux   | none (native)   | nerdctl (rootless)      | CalDAV (EDS via zbus)     | .deb      |
| Windows | WSL2 + Hyper-V  | nerdctl (wsl.exe proxy) | WinRT + mapi-rs (Outlook) | .exe      |

## macOS

- Lima manages the VM using Apple Virtualization Framework (same hypervisor as Docker Desktop 4.15+)
- Lima is bundled inside `.app/Contents/Resources/lima/` with `LIMA_HOME=~/.speedwave/lima` for isolation (see [ADR-021](../adr/ADR-021-bundled-dependencies-and-zero-install-strategy.md))
- IDE lock file: `~/.claude/ide/<port>.lock`
- **CloudStorage TCC:** Project directories under `~/Library/CloudStorage/` (OneDrive, Dropbox, Google Drive) and top-level home folders like `~/OneDrive…` are gated by the macOS Files-and-Folders Transparency Consent and Control (TCC) permission. When permission is missing, `read_dir` returns EPERM and Speedwave surfaces a dedicated `CloudStorageModal` (with a deep-link to System Settings → Privacy & Security → Files and Folders, plus a one-click Retry). Detection runs at all four project-mutation entry points (`add_project`, `start_containers`, `recreate_project_containers`, `restart_integration_containers`) plus defense-in-depth in `render_and_save_compose`. SSOT: `crates/speedwave-runtime/src/cloudstorage.rs`.

## Linux

- nerdctl-full (rootless) is bundled inside the .deb package — no additional system package dependencies for the container runtime
- On first launch, nerdctl-full is extracted to `~/.speedwave/nerdctl-full/` and containerd starts as a systemd --user service
- System requirements: uidmap, systemd --user, /etc/subuid + /etc/subgid
- Optional: `libappindicator3-1` or `libayatana-appindicator3-1` for system tray icon support (app works without it — falls back to a regular visible window)
- mcp-os: no EventKit equivalent; CalDAV (RFC 4791) is the cross-DE standard; `zbus` crate for GNOME EDS access
- IDE lock file: `~/.claude/ide/<port>.lock`

## Windows

- `wsl.exe -d Speedwave -- nerdctl ...` called from Tauri/Rust
- `windows-rs` (Microsoft-maintained) for WinRT API access
- `mapi-rs` (Microsoft-maintained) for Outlook mail/calendar
- Setup Wizard auto-installs WSL2, imports Ubuntu rootfs, and sets up nerdctl-full
- IDE lock file: `%USERPROFILE%\.claude\ide\<port>.lock`
- **Nested virtualization:** WSL2 uses Hyper-V, which requires hardware virtualization. Running WSL2 inside a VM (VMware, VirtualBox, QEMU/KVM) is nested virtualization and may degrade I/O performance during container image builds. Speedwave applies a four-layer resilience strategy (see [ADR-032](../adr/ADR-032-nested-virtualization-resilience.md)): (1) `Containerfile.claude` uses `--force-unsafe-io` and `Acquire::Retries=3` to harden apt installs; (2) transient I/O errors trigger an automatic retry without a prune; (3) Speedwave detects the VM environment via `Get-CimInstance Win32_ComputerSystem` and shows a non-blocking warning in `speedwave check` and Desktop logs; (4) a bounded parallel worker pool limits I/O amplification during concurrent image builds.
- **Line endings:** `actions/checkout` on `windows-latest` defaults to `core.autocrlf=true`, which corrupts shell-script shebangs in the NSIS bundle (issue #603). `.gitattributes` forces LF repo-wide; `scripts/bundle-build-context.{sh,ps1}` strip residual CR from `*.sh` before the bundle is packed. The `runtime-windows` CI job re-clones with `core.autocrlf=true` and asserts no CRLF survives, so a missing/regressed `.gitattributes` fails CI before reaching the release pipeline.

## Cross-platform Rust gating

`speedwave-desktop` compiles for all three platforms above. The local `make check-desktop-clippy` only exercises the host target, so Windows-only compile errors (typically `cfg(unix)`-gated imports referenced by cross-platform function signatures) must be caught by the `desktop-windows-check` job in `.github/workflows/test.yml`. See [contributing/development-setup.md → Cross-platform Rust gating](../contributing/development-setup.md#cross-platform-rust-gating) for the rules every PR touching gated code must follow.

## See Also

- [ADR-002: Lima as VM Manager on macOS](../adr/ADR-002-lima-as-vm-manager-on-macos.md)
- [ADR-003: Bundled nerdctl-full on Linux](../adr/ADR-003-bundled-nerdctl-full-on-linux.md)
- [ADR-004: WSL2 + nerdctl on Windows](../adr/ADR-004-wsl2-and-nerdctl-on-windows.md)
- [ADR-021: Bundled Dependencies and Zero-Install Strategy](../adr/ADR-021-bundled-dependencies-and-zero-install-strategy.md)
