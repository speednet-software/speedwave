# Installation

Platform-specific installation instructions for Speedwave.

## System Requirements

|      | Minimum     | Recommended |
| ---- | ----------- | ----------- |
| RAM  | 8 GiB       | 16 GiB      |
| Disk | 10 GiB free | 20 GiB free |

Speedwave warns at startup if the host has less than 8 GiB RAM.

> **Upgrading from ≤ 0.6.0 on a 16 GiB host?** The new adaptive formula
> (`host_ram / 2`) reduces the Lima VM from 12 GiB to 8 GiB, which lowers
> Claude's working memory from 8 g to 4 g. To restore the previous allocation,
> edit `memory: "12GiB"` in `~/.speedwave/lima.yaml` and restart Speedwave.

## macOS

<!-- Content to be written: .dmg installation, Lima VM setup, system requirements -->

## Linux

<!-- Content to be written: .deb installation, nerdctl-full extraction, system requirements (uidmap, systemd --user, /etc/subuid + /etc/subgid) -->

## Windows

<!-- Content to be written: .exe installer, WSL2 setup, system requirements -->

## Verifying Installation

<!-- Content to be written: health check commands, expected output -->

## See Also

- [ADR-002: Lima as VM Manager on macOS](../adr/ADR-002-lima-as-vm-manager-on-macos.md)
- [ADR-003: Bundled nerdctl-full on Linux](../adr/ADR-003-bundled-nerdctl-full-on-linux.md)
- [ADR-004: WSL2 + nerdctl on Windows](../adr/ADR-004-wsl2-and-nerdctl-on-windows.md)
- [ADR-021: Bundled Dependencies and Zero-Install Strategy](../adr/ADR-021-bundled-dependencies-and-zero-install-strategy.md)
