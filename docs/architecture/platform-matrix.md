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
- **Nested virtualization:** WSL2 uses Hyper-V, which requires hardware virtualization. Running WSL2 inside a VM (VMware, VirtualBox, QEMU/KVM) is nested virtualization and may degrade I/O performance during container image builds. Speedwave detects this via `Get-CimInstance Win32_ComputerSystem` and shows a non-blocking warning in `speedwave check` and Desktop logs. The `Containerfile.claude` uses `--force-unsafe-io` and `Acquire::Retries=3` to mitigate build failures in these environments. See [ADR-032](../adr/ADR-032-nested-virtualization-resilience.md).

## See Also

- [ADR-002: Lima as VM Manager on macOS](../adr/ADR-002-lima-as-vm-manager-on-macos.md)
- [ADR-003: Bundled nerdctl-full on Linux](../adr/ADR-003-bundled-nerdctl-full-on-linux.md)
- [ADR-004: WSL2 + nerdctl on Windows](../adr/ADR-004-wsl2-and-nerdctl-on-windows.md)
- [ADR-021: Bundled Dependencies and Zero-Install Strategy](../adr/ADR-021-bundled-dependencies-and-zero-install-strategy.md)
