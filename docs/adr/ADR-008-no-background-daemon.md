# ADR-008: No Background Daemon — Desktop App Is Sufficient

## Status

**Rejected** — a system-level daemon was considered but rejected in favour of the simpler Desktop app approach.

## Context

The IDE Bridge must be running for Claude (inside a container) to communicate with the IDE on the host. One option was a background daemon registered via launchd (macOS), systemd user service (Linux), or Windows Service — similar to Dropbox, 1Password, or Docker Desktop.

## Decision

**We do not install a system service.** The IDE Bridge starts and stops together with the Speedwave Desktop app (`Speedwave.app` / `speedwave.exe`). When the Desktop app is not running, IDE Bridge is not available.

## Rationale

1. **KISS** — a system service adds installation complexity (platform-specific registration, uninstall cleanup, privilege escalation) with marginal benefit. Most users launch the Desktop app before starting a coding session anyway.
2. **TCC permissions on macOS** — a bundled `.app` inherits macOS permissions (Reminders, Calendar, Mail) declared in `Info.plist`. A standalone daemon would require separate TCC entitlements and a more complex permission flow[^22].
3. **No orphan processes** — tying the IDE Bridge lifecycle to the Desktop app guarantees clean shutdown. A system daemon risks becoming an orphan after a failed update or uninstall.
4. **CLI does not need IDE Bridge** — `speedwave` in a terminal runs containers and attaches to Claude directly. IDE integration is a Desktop-only feature, so a daemon offers no benefit to CLI users.

## Trade-offs

- If the user closes the Desktop app window while the system tray is available (macOS/Windows, Linux with libappindicator), the window hides to tray and all host-side processes continue running (IDE Bridge, mcp-os). The app fully exits only when the user clicks "Quit" in the tray menu, or when the tray is unavailable (e.g. some Linux environments without libappindicator). In the latter case, closing the window exits the app and all host-side processes stop until the app is reopened.
  - When the user clicks "Quit" from the tray menu, containers are stopped: on Linux via per-project `compose_down`; on Windows via per-project `compose_down` (WSL2 distro is system-managed — Speedwave does not own its lifecycle); on macOS by letting `limactl stop --force` hard-power the Lima VM off, reaping every container in one shot. mcp-os is killed, IDE Bridge is shut down. This matches the Docker Desktop model — closing the app stops all managed containers.
  - This is an acceptable trade-off given the simplicity gained.
- If a future requirement demands "always-on" host services (e.g., headless server usage), this decision can be revisited by adding an optional system service.

## Lima VM Lifecycle on Exit (macOS)

On macOS, the Lima VM is stopped when the Desktop app exits (`limactl stop --force`). This frees the ~9–32 GiB of RAM that QEMU/VZ reserves for the VM (hypervisors do not support memory ballooning, so the RAM is not returned to the system while the VM is running)[^23].

- **Trade-off:** Next startup is slower due to VM cold boot (Lima VM typically takes several seconds to restart on first use after a stop). `ensure_ready()` starts the stopped VM automatically — the user sees no manual intervention required.
- **Linux and Windows are unaffected:** Linux runs containerd directly (no VM layer); WSL2 on Windows has its own memory management at the hypervisor level, and stopping the WSL2 distro would affect all workloads in it — not just Speedwave.
- **Signal handlers (SIGTERM/SIGINT):** Cleanup runs on process signals as well as graceful close. A `CLEANUP_ONCE` guard ensures the cleanup body runs exactly once across all three call sites: the signal handler, `WindowEvent::Destroyed` (window closed without tray), and `RunEvent::ExitRequested` (tray Quit, Cmd+Q, or SIGTERM via the Tauri runtime — paths where the main window is hidden rather than destroyed).
- **Non-blocking:** All cleanup (container stop, VM stop, IDE Bridge, mcp-os) runs in a spawned background thread. The Tauri event loop is not blocked.
- **`stop_vm()` errors are non-fatal:** Callers log warnings and continue. Exit cleanup must never block app termination. If the VM is left in a `"Stopping"` state, `ensure_ready()` on next launch detects this and polls until the VM finishes stopping, then starts it.

## Platform-specific exit cleanup strategy

The decision to skip `compose_down` on macOS while running it on Linux and Windows is driven by where container lifetime is owned:

- **macOS (Lima):** `LimaRuntime::stop_vm` issues `limactl stop --force`, which hard-powers the Apple Virtualization Framework VM off[^24]. Every container inside the VM dies with it. Running `compose_down` per project before stopping the VM is redundant and costs ~10 s per project (nerdctl's hard-coded graceful-stop timeout, see [^25]).
- **Linux (native containerd):** there is no VM. Containerd runs as a user process. Only `compose_down` actually stops containers; stopping the runtime process would orphan them.
- **Windows (WSL2):** `WslRuntime::stop_vm` is a no-op[^26] because the `Speedwave` WSL2 distro is managed by the Windows host, not by Speedwave. Running `wsl --terminate Speedwave` would affect workloads unrelated to Speedwave. `compose_down` is therefore the only mechanism that stops Speedwave's containers at app exit.

---

[^22]: [macOS TCC — Transparency Consent and Control](https://developer.apple.com/documentation/bundleresources/information-property-list/nscalendarsusagedescription)

[^23]: [QEMU does not support memory ballooning with Apple Hypervisor](https://github.com/lima-vm/lima/discussions/1534)

[^24]: [Lima `limactl stop --force` uses Apple Virtualization Framework](https://github.com/lima-vm/lima/blob/v2.0.2/pkg/instance/stop.go) — `--force` skips the guest-side graceful shutdown.

[^25]: [nerdctl hard-coded 10 s graceful-stop timeout](https://github.com/containerd/nerdctl/blob/v2.0.0/pkg/cmd/container/stop.go) — see `defaultStopTimeout`.

[^26]: `ContainerRuntime::stop_vm` default no-op + no `WslRuntime` override: `crates/speedwave-runtime/src/runtime/mod.rs:142-149` and `crates/speedwave-runtime/src/runtime/wsl.rs`.
