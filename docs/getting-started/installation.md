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
> Claude's working memory from 8 g to 4 g. This trade-off frees host RAM
> for the browser and other apps. There is currently no persistent override
> — the migration runs automatically on each launch.

## macOS

Speedwave ships as a signed and notarized `.dmg` (Apple Silicon and Intel).

1. Download `Speedwave_<version>_aarch64.dmg` (Apple Silicon) or `Speedwave_<version>_x64.dmg` (Intel) from [GitHub Releases](https://github.com/speednet-software/speedwave/releases).
2. Open the `.dmg` and drag **Speedwave** into `/Applications`.
3. Launch Speedwave once from Launchpad. Gatekeeper verifies the signature on first run.
4. The setup wizard creates a Lima VM named `speedwave` under `~/.speedwave/lima/`. The VM uses Apple's native Virtualization Framework (`vmType: vz`); QEMU is not required.

The Lima binary and nerdctl-full are bundled inside the app — there is nothing to install separately. Speedwave never touches an existing system Lima/Docker installation.

## Linux

Speedwave ships as a `.deb` package. Tested on Debian 12+ and Ubuntu 22.04+.

1. Download `speedwave_<version>_amd64.deb` from [GitHub Releases](https://github.com/speednet-software/speedwave/releases).
2. Install:
   ```bash
   sudo dpkg -i speedwave_<version>_amd64.deb
   ```
3. Install the one OS-level prerequisite (rootless containers need `newuidmap`):
   ```bash
   # Debian / Ubuntu
   sudo apt-get install -y uidmap
   # Fedora / RHEL
   sudo dnf install -y shadow-utils
   # openSUSE
   sudo zypper install -y shadow
   ```
4. Confirm `/etc/subuid` and `/etc/subgid` contain an entry for your user (the `uidmap` package adds one automatically on first install). If not, add 65536 IDs:
   ```bash
   sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$USER"
   ```
5. Launch Speedwave from your application menu, or run `speedwave` from a terminal. The first launch unpacks the bundled nerdctl-full into `~/.speedwave/nerdctl-full/` and starts containerd + buildkit as systemd `--user` units.

Speedwave runs containers rootless under your UID — no Docker daemon, no `sudo`, no system-wide containerd. The bundled nerdctl is independent of any nerdctl/Docker you may already have on the host.

## Windows

Speedwave ships as an NSIS installer (`.exe`); an MSI is also published for managed deployments. Windows 10 21H2 (Build 19044) or later is required.

1. Download `Speedwave_<version>_x64-setup.exe` (or the `.msi`) from [GitHub Releases](https://github.com/speednet-software/speedwave/releases).
2. Run the installer. It writes to `%LOCALAPPDATA%\Programs\Speedwave\` (per-user, no admin needed at runtime).
3. Launch Speedwave from the Start menu. If WSL2 is missing, the setup wizard runs `wsl --install --no-distribution` for you (you will see a UAC prompt). After WSL2 finishes installing, reboot and start Speedwave again. The wizard then imports a dedicated WSL2 distribution named **Speedwave** (`wsl --list --quiet` will show it) and starts the same rootless nerdctl stack as on Linux inside it.

Speedwave does not modify your default WSL distro and does not require Docker Desktop. The `Speedwave` distro is dedicated to Speedwave and can be removed with `wsl --unregister Speedwave`.

If the auto-install fails (locked-down corporate machine, Group Policy, etc.), enable WSL2 manually from an elevated PowerShell and retry:

```powershell
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
wsl --update
```

## Verifying Installation

After the setup wizard finishes, verify the install from a terminal:

```bash
speedwave check
```

Expected output on a healthy system:

```
speedwave check OK -- all system checks passed
```

`speedwave check` runs OS prerequisite checks (Linux: `newuidmap`; Windows: `wsl.exe --status`) and validates the rendered compose file against the security policy: `cap_drop: ALL` and `no-new-privileges` on every container, `read_only: true` on `claude` and `mcp-hub`, and `tmpfs: /tmp:noexec,nosuid` where applicable. It is diagnostic-only — it does not start containers, does not modify file permissions, and does not auto-fix anything. Container start paths (`speedwave` and `speedwave update`) call `ensure_data_dir_permissions` before running the same security checks.

If a check fails, the command prints the failing rule and a remediation hint, then exits non-zero. Re-run after applying the fix.

The Desktop app surfaces the same checks plus per-container health and IDE-bridge status, refreshed every 5 s.

## See Also

- [ADR-002: Lima as VM Manager on macOS](../adr/ADR-002-lima-as-vm-manager-on-macos.md)
- [ADR-003: Bundled nerdctl-full on Linux](../adr/ADR-003-bundled-nerdctl-full-on-linux.md)
- [ADR-004: WSL2 + nerdctl on Windows](../adr/ADR-004-wsl2-and-nerdctl-on-windows.md)
- [ADR-021: Bundled Dependencies and Zero-Install Strategy](../adr/ADR-021-bundled-dependencies-and-zero-install-strategy.md)
