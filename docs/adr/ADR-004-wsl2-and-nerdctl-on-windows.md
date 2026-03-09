# ADR-004: WSL2 + nerdctl on Windows

## Decision

On Windows, Speedwave uses WSL2 (Hyper-V) with nerdctl inside the Linux distribution.

## Rationale

WSL2[^5] is built into Windows 10/11 and uses Hyper-V — the same hypervisor Docker Desktop for Windows uses. Tauri (Rust) can manage WSL2 via `wsl.exe`:

```rust
Command::new("wsl.exe")
    .args(["-d", "Speedwave", "--", "nerdctl", "compose", "up", "-d"])
    .output()
```

The public WSL API (`wslapi.h`)[^12] allows distribution registration and process execution. For mcp-os:

- `windows-rs` (Microsoft-maintained)[^13] for WinRT API access
- `mapi-rs` (Microsoft-maintained)[^14] for Outlook mail and calendar

IDE lock file on Windows: `%USERPROFILE%\.claude\ide\<port>.lock`[^15]

## Auto-Installation

The Setup Wizard detects whether WSL2 is available and provisions it automatically (see ADR-021):

1. **Detection**: Run `wsl --status` to check if WSL2 is installed and operational
2. **Installation**: If WSL2 is missing, run `wsl --install --no-distribution` with UAC elevation[^16]. The `--no-distribution` flag installs only the WSL2 kernel without a default Linux distribution — Speedwave provides its own.
3. **Reboot**: Prompt the user to reboot (required for WSL2 kernel installation on first setup)
4. **Distribution import**: After reboot, run `wsl --import Speedwave <install-dir> <rootfs.tar.gz>` to create an isolated named distribution[^17]

This ensures the user never needs to manually enable Windows features or install WSL2 from the command line.

## Distribution Import

Speedwave creates a dedicated WSL2 distribution named `Speedwave` using `wsl --import`. This isolates Speedwave's Linux environment from any user-configured WSL distributions (e.g., Ubuntu, Debian). The distribution is stored in `%USERPROFILE%\.speedwave\wsl\Speedwave\`.

## System Requirements

- Windows 10 version 21H2 (Build 19044) or later[^18]
- Hyper-V capable hardware (virtualization enabled in BIOS/UEFI)
- Administrator privileges for initial WSL2 installation (UAC prompt)

---

[^5]: [WSL2 architecture - Microsoft Docs](https://learn.microsoft.com/en-us/windows/wsl/compare-versions)

[^12]: [WslRegisterDistribution - wslapi.h - Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/wslapi/nf-wslapi-wslregisterdistribution)

[^13]: [microsoft/windows-rs - Rust for Windows](https://github.com/microsoft/windows-rs)

[^14]: [microsoft/mapi-rs - Rust bindings for Outlook MAPI](https://github.com/microsoft/mapi-rs)

[^15]: [Claude Code Issue #16434 - Windows IDE lockfile path](https://github.com/anthropics/claude-code/issues/16434)

[^16]: [Install WSL - Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/install)

[^17]: [Import a Linux distribution - wsl --import](https://learn.microsoft.com/en-us/windows/wsl/use-custom-distro)

[^18]: [WSL2 requirements - Windows 10 version 21H2](https://learn.microsoft.com/en-us/windows/wsl/install-manual#step-2---check-requirements-for-running-wsl-2)
