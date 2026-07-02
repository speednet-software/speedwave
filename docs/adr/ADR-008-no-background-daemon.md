# ADR-008: No Background Daemon — Desktop App Is Sufficient

> **Status:** Accepted — a system-level daemon was considered and rejected in favour of tying host services to the Desktop app.
> **Context:** The IDE Bridge must run on the host for Claude (inside a container) to reach the IDE. One option was a launchd / Windows Service daemon, like Dropbox or Docker Desktop.

## Decision

Speedwave installs no system service. The IDE Bridge (and the other host-side services: mcp-os, host_exec, oauth) start and stop together with the Desktop app. When the Desktop app is not running, the IDE Bridge is not available. The CLI runs containers and attaches to Claude directly and never needs the IDE Bridge.

## Why

- **KISS** — a system service adds platform-specific registration, uninstall cleanup, and privilege escalation with marginal benefit. Most users open the Desktop app before a coding session anyway.
- **macOS TCC permissions** — a bundled `.app` inherits the Reminders / Calendar / Mail permissions declared in its `Info.plist`. A standalone daemon would need separate TCC entitlements and a more complex consent flow.
- **No orphan processes** — tying host services to the Desktop app guarantees clean shutdown. A daemon risks being orphaned after a failed update or uninstall.
- **CLI does not benefit** — IDE integration is Desktop-only, so a daemon offers nothing to terminal users.

## Lifecycle behaviour

- Closing the window hides the app to the system tray when a tray icon is available; host services keep running. If no tray icon is available, the close proceeds to a real exit. When hidden, the app fully exits only on tray "Quit" (or Cmd+Q / SIGTERM / SIGINT).
- On exit, containers are stopped per platform (see below), mcp-os is killed, and the IDE Bridge is shut down — matching the Docker Desktop model.
- A `CLEANUP_ONCE` guard runs the cleanup body exactly once across the signal handler, `WindowEvent::Destroyed`, and `RunEvent::ExitRequested`. Cleanup runs on a background thread so the Tauri event loop is never blocked, and `stop_vm()` errors are logged but never block termination.

## Platform-specific exit cleanup

The choice of whether to run per-project `compose_down` at exit follows who owns container lifetime:

- **macOS (Lima):** `LimaRuntime::stop_vm` issues `limactl stop --force`, hard-powering the Apple Virtualization Framework VM off and reaping every container at once. Running `compose_down` first would be redundant and slow (nerdctl's graceful-stop timeout). Stopping the VM also frees the RAM the hypervisor reserves; the next launch pays a cold-boot cost, which `ensure_ready()` handles automatically.
- **Windows (WSL2):** `stop_vm()` is a no-op for `WslRuntime` (it does not override the default; only `LimaRuntime` does), because the WSL2 distro is managed by the Windows host, not by Speedwave — terminating it would hit unrelated workloads. Per-project `compose_down` is therefore the only mechanism that stops Speedwave's containers at exit.

## Rejected alternative

- **launchd / Windows Service daemon** — rejected for the four reasons above. If an "always-on" headless-server requirement ever emerges, this decision can be revisited by adding an optional service.

## Where it lives in code

- `stop_vm()` default no-op (inherited by `WslRuntime`) — `crates/speedwave-runtime/src/runtime/mod.rs` (the `ContainerRuntime` trait default).
- `LimaRuntime::stop_vm` (the `limactl stop --force` override) — `crates/speedwave-runtime/src/runtime/lima.rs`.
- `WslRuntime` (no `stop_vm` override) — `crates/speedwave-runtime/src/runtime/wsl.rs`.
- Exit cleanup, `CLEANUP_ONCE`, and the tray-Quit / window-destroyed / exit-requested handling — `desktop/src-tauri/src/main.rs`.
- VM network rationale for why host-side probes run inside the VM — `docs/architecture/platform-matrix.md`.

## References

- [macOS TCC — Transparency, Consent, and Control](https://developer.apple.com/documentation/bundleresources/information-property-list/nscalendarsusagedescription)
