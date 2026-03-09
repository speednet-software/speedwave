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

- If the user closes the Desktop app window while the system tray is available (macOS/Windows, Linux with libappindicator), the window hides to tray and all host-side processes continue running (IDE Bridge, mcp-os). The app fully exits only when the user clicks "Quit" in the tray menu, or when the tray is unavailable (e.g. some Linux environments without libappindicator). In the latter case, closing the window exits the app and all host-side processes stop until the app is reopened. This is an acceptable trade-off given the simplicity gained.
- If a future requirement demands "always-on" host services (e.g., headless server usage), this decision can be revisited by adding an optional system service.

---

[^22]: [macOS TCC — Transparency Consent and Control](https://developer.apple.com/documentation/bundleresources/information-property-list/nscalendarsusagedescription)
