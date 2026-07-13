# ADR-004: WSL2 + nerdctl on Windows

> **Status:** Accepted
> **Context:** Speedwave needs container isolation on Windows without requiring Docker Desktop.

## Decision

On Windows, Speedwave runs containers via nerdctl inside a dedicated WSL2 (Hyper-V) Linux distribution named `Speedwave`, managed from the Rust runtime by shelling out to `wsl.exe`. Linux as a host platform was dropped (ADR-059); the two supported hosts are macOS (Lima) and Windows (WSL2).

## Why

- WSL2 ships with Windows 10/11 and uses Hyper-V — the same hypervisor Docker Desktop relies on — so no extra hypervisor install is needed.[^1]
- The Rust runtime can drive WSL2 entirely through `wsl.exe -d <distro> -- ...`, keeping the orchestration layer thin (KISS).
- A dedicated, Speedwave-owned distribution isolates the container environment from any user-configured WSL distros (Ubuntu, Debian, etc.) and lets Speedwave verify the distro's origin before trusting it.
- `windows-rs` (Microsoft-maintained) provides WinRT access;[^2] `mapi-rs` provides Outlook mail and calendar bindings for the host-side native helpers.[^3]

## Auto-Installation

The Setup Wizard provisions WSL2 automatically (see ADR-021):

1. Detection — prerequisite checks decide whether WSL2 is installed and operational.
2. Installation — if WSL2 is missing, the wizard runs `wsl --install --no-distribution` via elevated PowerShell (UAC). The `--no-distribution` flag installs only the WSL2 kernel; Speedwave imports its own distro.[^4]
3. Reboot — the user is prompted to restart (required after first-time kernel install).
4. Distribution import — the bundled Ubuntu rootfs (SHA256-verified) is imported with `wsl --import` into a dedicated named distribution.[^5]

Implemented in `desktop/src-tauri/src/setup_wizard.rs` (`attempt_wsl_install`, `import_wsl_distro`).

## Where it lives in code

- WSL container runtime (the `WslRuntime` impl behind the `LockedRuntime` façade, ADR-066) — `crates/speedwave-runtime/src/runtime/wsl.rs`
- WSL2 install + rootfs import + distro-origin verification — `desktop/src-tauri/src/setup_wizard.rs`
- Distro name SSOT, derived from the data-dir basename (`~/.speedwave` → `Speedwave`, `~/.speedwave-dev` → `Speedwave-dev`) — `crates/speedwave-runtime/src/consts.rs` (`wsl_distro_name`, `derive_wsl_distro_name_from`)
- WSL2 disk image lives at `<data_dir>/wsl/<distro>/ext4.vhdx` — `setup_wizard.rs` (`expected_wsl_vhdx_path_in`)
- IDE Bridge lock files are written by Speedwave on the host at `<data_dir>/ide-bridge/<port>.lock` (e.g. `~/.speedwave/ide-bridge/<port>.lock`), then mounted into the `claude` container as `/home/speedwave/.claude/ide/` — `desktop/src-tauri/src/bridges/host_bridge.rs` (`HostBridge::new_with_options`) and `crates/speedwave-runtime/src/compose.rs`. Note: `%USERPROFILE%\.claude\ide\<port>.lock` is the upstream Claude Code path inside the container, not where Speedwave persists the host-side lock.

## System Requirements

- Windows 10 version 21H2 (Build 19044) or later[^6]
- Hyper-V-capable hardware (virtualization enabled in BIOS/UEFI)[^7]
- Administrator privileges for the initial WSL2 install (one UAC prompt)[^7]

## Rejected alternatives

- Docker Desktop on Windows — extra licensing and install burden for end users; Speedwave aims to ship a single installable app with no Docker dependency.
- Reusing a user's existing WSL distro — would couple Speedwave's container environment to arbitrary user configuration and break the origin-verification security check; a dedicated imported distro keeps isolation clean.

---

[^1]: [Comparing WSL 1 and WSL 2 - Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/compare-versions) ("WSL 2 is running as a Hyper-V virtual machine.")

[^2]: [microsoft/windows-rs - Rust for Windows](https://github.com/microsoft/windows-rs)

[^3]: [microsoft/mapi-rs - Rust bindings for Outlook MAPI](https://github.com/microsoft/mapi-rs)

[^4]: [Basic commands for WSL - Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/basic-commands) ("`--no-distribution`: Do not install a distribution when installing WSL.")

[^5]: [Import a Linux distribution - wsl --import - Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/use-custom-distro)

[^6]: [Comparing WSL 1 and WSL 2 - Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/compare-versions) ("Beginning in Windows version 19044 or higher, running the `wsl.exe --install` command will install the WSL servicing update from the Microsoft Store."); build 19044 corresponds to Windows 10 version 21H2 per [Windows 10 release information - Microsoft Learn](https://learn.microsoft.com/en-us/windows/release-health/release-information).

[^7]: [Manual installation steps for older versions of WSL - Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/install-manual) (Step 3, "Your machine will require virtualization capabilities"; all install steps run "PowerShell as Administrator").
