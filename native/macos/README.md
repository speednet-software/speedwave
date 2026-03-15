# native/macos — macOS Native OS CLI Binaries

Four Swift CLI binaries providing macOS-specific OS integration via EventKit and AppleScript:

| Directory    | Binary          | Framework   | Purpose                   |
| ------------ | --------------- | ----------- | ------------------------- |
| `reminders/` | `reminders-cli` | EventKit    | Reminders CRUD            |
| `calendar/`  | `calendar-cli`  | EventKit    | Calendar events CRUD      |
| `mail/`      | `mail-cli`      | AppleScript | Apple Mail / Outlook read |
| `notes/`     | `notes-cli`     | AppleScript | Apple Notes CRUD          |

Each directory is a standalone Swift Package (`Package.swift`). Build all with:

```bash
make build-native-macos
```

For production desktop bundles, these binaries are copied into `desktop/src-tauri/` as top-level resources via `scripts/build-native-macos.sh` and `scripts/bundle-native-assets.sh`. The desktop build now fails if any of the four binaries is missing from the staged bundle or from `tauri.macos.conf.json`.

Per [ADR-010](../../docs/adr/ADR-010-mcp-os-as-host-process-per-platform.md), these are called by the `mcp-os` host process at runtime.

See [ADR-027](../../docs/adr/ADR-027-native-directory-structure.md) for the directory structure rationale.
