# Installation

Platform-specific installation instructions for Speedwave.

## System Requirements

|      | Minimum     | Recommended |
| ---- | ----------- | ----------- |
| RAM  | 16 GiB      | 32 GiB      |
| Disk | 10 GiB free | 20 GiB free |

Speedwave warns at startup if the host has less than 16 GiB RAM. At 16 GiB the
Lima VM is sized to 8 GiB (`host_ram / 2`), which fits the always-on containers
(Claude's 6 GiB cap + the hub) without overcommit; a smaller host would size the
VM below Claude's cap and risk an OOM (ADR-068).

> **Upgrading on a 16 GiB host?** The Lima VM is sized at `host_ram / 2`
> (8 GiB on a 16 GiB host), freeing host RAM for the browser and other apps.
> The Claude container has a fixed 6 GiB cap independent of VM size (ADR-068).
> The migration runs automatically on each launch; there is no persistent override.

## macOS

Speedwave ships as a signed and notarized `.dmg` (Apple Silicon and Intel).

1. Download `Speedwave_<version>_aarch64.dmg` (Apple Silicon) or `Speedwave_<version>_x64.dmg` (Intel) from [GitHub Releases](https://github.com/speednet-software/speedwave/releases).
2. Open the `.dmg` and drag **Speedwave** into `/Applications`.
3. Launch Speedwave once from Launchpad. Gatekeeper verifies the signature on first run.
4. The setup wizard creates a Lima VM named `speedwave` under `~/.speedwave/lima/`. The VM uses Apple's native Virtualization Framework (`vmType: vz`); QEMU is not required.

The Lima binary and nerdctl-full are bundled inside the app — there is nothing to install separately. Speedwave never touches an existing system Lima/Docker installation.

## Windows

Speedwave ships as an NSIS installer (`.exe`); an MSI is also published for managed deployments. Windows 10 21H2 (Build 19044) or later is required.

1. Download `Speedwave_<version>_x64-setup.exe` (or the `.msi`) from [GitHub Releases](https://github.com/speednet-software/speedwave/releases).
2. Run the installer. It writes to `%LOCALAPPDATA%\Speedwave\` (per-user, no admin needed at runtime).
3. Launch Speedwave from the Start menu. If WSL2 is missing, the setup wizard runs `wsl --install --no-distribution` for you (you will see a UAC prompt). After WSL2 finishes installing, reboot and start Speedwave again. The wizard then imports a dedicated WSL2 distribution named **Speedwave** (`wsl --list --quiet` will show it) and starts the bundled nerdctl-full stack inside it.

Speedwave does not modify your default WSL distro and does not require Docker Desktop. The `Speedwave` distro is dedicated to Speedwave. When you uninstall Speedwave via Add/Remove Programs, the uninstaller will offer an opt-in prompt to also remove the `Speedwave` WSL distro and user data (`%USERPROFILE%\.speedwave`). If you already have a phantom `Speedwave` distro from an earlier uninstall (v0.10.0 or before), remove it manually with `wsl --unregister Speedwave` before reinstalling.

The v0.11+ installer automatically releases the bundled `node.exe` (host MCP workers) before overwriting it, so upgrading while Speedwave is running no longer fails with "Error opening file for writing". This is enforced by two layers: a Windows Job Object that ties every worker's lifetime to `Speedwave.exe` (so a crash kills the workers automatically), plus a NSIS PRE-INSTALL sweep that catches any orphan that survived. If you are still on v0.10.x and hit that error, close Speedwave from the system tray, end any leftover `Node.js JavaScript Runtime` processes in Task Manager, and re-run the installer — once you are on v0.11+ this is handled automatically.

Under WSL2 mirrored networking, Speedwave's host workers (`node.exe`, the desktop app) bind the WSL adapter IP (not loopback) so containers can reach them. This needs two firewall rules — a Hyper-V rule for the WSL VM boundary, and host Windows Defender Firewall allow rules for the binaries (so Windows does not show the per-app "allow access to the network" prompt). Both require administrator rights. The MSI creates them at install time (no prompt). The per-user `.exe` installer runs without admin, so Speedwave creates them on first launch instead — you will see **one** UAC elevation prompt per app launch until the rules exist. Accept it once and no further prompts appear (the rules persist). If you decline, the app still works but Windows shows its own per-app firewall prompts for `node.exe`; Speedwave does not remember the decline, so it offers the UAC prompt again the next time you start the app (at most once per launch — never repeatedly within a session). Removing Speedwave deletes the rules.

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

`speedwave check` runs OS prerequisite checks (Windows: `wsl.exe --status`; no host-level prerequisites on macOS) and validates the rendered compose file against the security policy: `cap_drop: ALL` and `no-new-privileges` on every container, `read_only: true` on `claude` and `mcp-hub`, and `tmpfs: /tmp:noexec,nosuid` where applicable. It is diagnostic-only — it does not start containers, does not modify file permissions, and does not auto-fix anything. Container start paths (`speedwave` and `speedwave update`) call `ensure_data_dir_permissions` before running the same security checks.

If a check fails, the command prints the failing rule and a remediation hint, then exits non-zero. Re-run after applying the fix.

The Desktop app surfaces the same checks plus per-container health and IDE-bridge status, refreshed every 5 s.

## WSL-native workflow

Speedwave on Windows runs inside its own dedicated WSL2 distribution named **Speedwave**. The hardened container runtime (cap_drop ALL, read_only filesystem, token isolation per worker — see [Container architecture](../architecture/containers.md)) lives in that distro and **cannot access files inside other WSL distributions** at native speed. This is the same architectural choice every isolated container runtime makes on Windows (Docker Desktop, Rancher Desktop, Podman Desktop) — each ships its own dedicated WSL distro rather than installing into the user's distro.

> **Note on Docker Desktop comparison**: Docker Desktop offers "WSL Integration" that injects the `docker` CLI into the user's distros via `/mnt/wsl/docker-desktop/`. Speedwave does not do this — Speedwave is operated through the Desktop UI or the bundled `speedwave` CLI on Windows, so there is no use case for "run the Speedwave CLI from inside my Ubuntu distro". The two products solve different problems.

### Where to keep your projects

Three workflows work well; choose based on where your code already lives:

1. **Recommended for new projects** — keep them inside Speedwave's distro at `\\wsl.localhost\Speedwave\projects\<name>\`. Native ext4 performance, accessible from Windows Explorer and natively visible to Speedwave's container. Create the folder once from PowerShell:

   ```powershell
   New-Item -Path '\\wsl.localhost\Speedwave\projects\my-project' -ItemType Directory
   ```

2. **Migrating an existing project from your own WSL distro** — copy it once into Speedwave's distro:

   ```powershell
   Copy-Item -Recurse '\\wsl.localhost\Ubuntu\home\<you>\<project>' '\\wsl.localhost\Speedwave\projects\<project>'
   ```

   The copy lives independently from the original; edits in your Ubuntu distro will not propagate to the Speedwave copy and vice versa.

3. **Cross-distro accessibility** — keep the project on a Windows drive like `C:\projects\<name>\`. Visible to your Ubuntu distro as `/mnt/c/projects/<name>` and to Speedwave's container as `/workspace`. File I/O is slower (NTFS via 9P from both sides) — Microsoft explicitly [recommends against this for intensive I/O](https://learn.microsoft.com/en-us/windows/wsl/filesystems#file-storage-and-performance-across-file-systems) — but it works from any WSL distro.

### What does not work and why

- **In-place use of `\\wsl.localhost\<other-distro>\...`** — Speedwave's container runs in an isolated distro and cannot see other WSL distros' rootfs natively. Selecting such a path in "Create new project" surfaces a helpful error with the options above. (Docker Desktop solves this differently — it built an API proxy plus a cross-distro VHD binding mechanism over several years to give containers transparent access to user-distro files. Speedwave does not have this; the workflow above is the supported path.)
- **Installing Speedwave into your own WSL distro** — not supported. The security model (hardened isolation, token isolation per worker, separate containerd) depends on the dedicated distro boundary.

See [ADR-064: Bypass `canonicalize()` for WSL UNC project paths](../adr/ADR-064-canonicalize-bypass-for-wsl-unc.md) for the architectural rationale behind how WSL UNC project paths are validated and translated.

## Logging in to Anthropic

After the setup wizard finishes, log in to your Claude account so Claude Code can run inside the container without prompting on every start. Two equivalent paths:

- **From the Desktop app** — open Settings → Authentication and click **Open terminal and log in**. Speedwave opens a system terminal running `speedwave login --project <name>`, which starts the Anthropic sign-in automatically. Follow the OAuth flow. Claude Code saves your credentials inside the container automatically when the flow completes.
- **From the CLI** — run:

  ```bash
  speedwave login
  ```

  This logs in for the active project (the one selected in the Desktop project switcher). Pass `--project <name>` to log in for a different registered project from any directory. The Anthropic sign-in starts automatically.

Credentials are stored by Claude Code at `~/.speedwave/claude-home/<project>/.claude/.credentials.json` (the per-project CLAUDE_HOME bind-mount) and are available on every subsequent `speedwave` start. To log out, run `speedwave logout` (or `speedwave logout --project <name>`). Credentials are per-project — logging in for one project does not authenticate another. See [ADR-052](../adr/ADR-052-anthropic-oauth-login-flow.md) for the full rationale.

If you prefer using a Console API key instead of OAuth, set it from Settings → Authentication → API key.

### Terminal compatibility for "press c to copy URL"

When Claude Code shows the OAuth URL, pressing `c` asks the terminal to copy it via [OSC 52](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Operating-System-Commands). Whether this works depends on your terminal:

| Terminal                                                                                          | OSC 52     |
| ------------------------------------------------------------------------------------------------- | ---------- |
| iTerm2 (with Settings → General → Selection → "Applications in terminal may access clipboard" ON) | ✅         |
| Alacritty, WezTerm, Ghostty, kitty                                                                | ✅ default |
| Windows Terminal                                                                                  | ✅ default |
| VS Code integrated terminal                                                                       | ✅ default |
| Apple Terminal.app                                                                                | ❌         |
| Bare `cmd.exe`                                                                                    | ❌         |

If your terminal does not support OSC 52, the URL still appears on screen — select it with your mouse, or paste the auth code Claude Code prompts for. The login flow itself works on every terminal.

**macOS:** when you click "Open terminal and log in" in Settings, Speedwave prefers iTerm2 if installed (in `/Applications/` or `~/Applications/`) and falls back to Apple Terminal.app. Install iTerm2 to get `c`-to-copy out of the box.

## See Also

- [ADR-002: Lima as VM Manager on macOS](../adr/ADR-002-lima-as-vm-manager-on-macos.md)
- [ADR-004: WSL2 + nerdctl on Windows](../adr/ADR-004-wsl2-and-nerdctl-on-windows.md)
- [ADR-059: Drop Linux support](../adr/ADR-059-drop-linux-support.md)
- [ADR-021: Bundled Dependencies and Zero-Install Strategy](../adr/ADR-021-bundled-dependencies-and-zero-install-strategy.md)
- [ADR-052: Anthropic OAuth Login Flow](../adr/ADR-052-anthropic-oauth-login-flow.md)
