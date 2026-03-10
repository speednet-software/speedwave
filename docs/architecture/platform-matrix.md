# Platform Matrix

Speedwave supports macOS, Linux, and Windows with platform-specific VM, container, and OS integration strategies.

## Overview

| OS      | VM              | Containers              | mcp-os                    | Installer |
| ------- | --------------- | ----------------------- | ------------------------- | --------- |
| macOS   | Lima + Apple VZ | nerdctl                 | AppleScript / EventKit    | .dmg      |
| Linux   | none (native)   | nerdctl (rootless)      | CalDAV (EDS via zbus)     | .deb      |
| Windows | WSL2 + Hyper-V  | nerdctl (wsl.exe proxy) | WinRT + mapi-rs (Outlook) | .exe      |

## macOS

<!-- Content to be written: Lima + Apple Virtualization Framework, bundled Lima, LIMA_HOME isolation -->

## Linux

<!-- Content to be written: nerdctl-full bundled in .deb package, rootless containerd, systemd --user, system requirements -->

## Windows

<!-- Content to be written: WSL2 + nerdctl, wsl.exe proxy calls, setup wizard, windows-rs + mapi-rs -->

## See Also

- [ADR-002: Lima as VM Manager on macOS](../adr/ADR-002-lima-as-vm-manager-on-macos.md)
- [ADR-003: Bundled nerdctl-full on Linux](../adr/ADR-003-bundled-nerdctl-full-on-linux.md)
- [ADR-004: WSL2 + nerdctl on Windows](../adr/ADR-004-wsl2-and-nerdctl-on-windows.md)
- [ADR-021: Bundled Dependencies and Zero-Install Strategy](../adr/ADR-021-bundled-dependencies-and-zero-install-strategy.md)
