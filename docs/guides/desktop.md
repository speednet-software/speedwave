# Desktop App

The Speedwave Desktop app provides a chat UI, project management, and system integrations via a Tauri-based application.

## Overview

The desktop shell is a Tauri backend with an Angular frontend. It owns the setup wizard, project list, tray integration, auto-update checks, and the startup reconcile that keeps bundled resources, container images, and restored projects aligned with the installed app version.

## CLI Integration

The Desktop app bundles the `speedwave` CLI binary in its resources. On every startup (and during initial setup), the app copies the bundled CLI to the user's PATH:

- **macOS / Linux:** `~/.local/bin/speedwave`
- **Windows:** `%USERPROFILE%\.speedwave\bin\speedwave.exe`

This ensures the CLI and Desktop versions always stay in sync — a Desktop update automatically distributes the matching CLI. If the CLI binary is missing, the "Open Terminal" button in Settings shows an error banner instructing the user to restart the app.

## App Update Flow

The desktop app now uses a single backend flow for update installation:

1. The frontend calls `install_update_and_reconcile(expectedVersion)`.
2. The backend records `pending_running_projects` in `~/.speedwave/bundle-state.json`.
3. Running project containers are stopped before the app update is installed.
4. The app installs the approved version and restarts immediately.

After restart, the desktop backend compares the installed bundle against `~/.speedwave/bundle-state.json`. If the `bundle_id` changed, it runs a startup reconcile:

1. Sync bundled `claude-resources` into `~/.speedwave/claude-resources`
2. Rebuild images tagged for the current `bundle_id`
3. Recreate only the projects that were running before the update
4. Emit `bundle_reconcile_status` so the UI can show progress or retry

The same startup reconcile also runs after a manual app upgrade outside the desktop UI. On Linux `.deb`, the app update itself is still manual, but the next app launch still applies the new bundle to resources and containers automatically.

## Bundle Identity

Desktop builds generate `build-context/bundle-manifest.json` with:

- `app_version`
- `bundle_id`
- `build_context_hash`
- `claude_resources_hash`

The runtime uses `bundle_id` as the compatibility contract between the installed app bundle and local images. Built-in images are no longer addressed as `speedwave-*:latest`; they are rendered as `speedwave-*:<bundle_id>`.

## Bundle Asset Validation

Desktop packaging now fails before release if the staged app bundle is missing required runtime assets. The gate covers bundled `mcp-os`, container build-context, the bundled `speedwave` CLI, platform container helpers, and on macOS also the four native integration binaries (`reminders-cli`, `calendar-cli`, `mail-cli`, `notes-cli`).

## Chat UI

<!-- Content to be written: claude -p subprocess, stream-json output, conversation flow -->

## System Tray

<!-- Content to be written: macOS/Windows click-toggle, Linux menu-only, libappindicator requirement -->

## See Also

- [ADR-005: Two Interfaces — CLI and Desktop](../adr/ADR-005-two-interfaces-cli-and-desktop.md)
- [ADR-006: Chat UI via claude -p --stream-json](../adr/ADR-006-chat-ui-via-stream-json.md)
