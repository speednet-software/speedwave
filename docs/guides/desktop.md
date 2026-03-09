# Desktop App

The Speedwave Desktop app provides a chat UI, project management, and system integrations via a Tauri-based application.

## Overview

<!-- Content to be written: app structure (Tauri + Angular), setup wizard, project switcher -->

## CLI Integration

The Desktop app bundles the `speedwave` CLI binary in its resources. On every startup (and during initial setup), the app copies the bundled CLI to the user's PATH:

- **macOS / Linux:** `~/.local/bin/speedwave`
- **Windows:** `%USERPROFILE%\.speedwave\bin\speedwave.exe`

This ensures the CLI and Desktop versions always stay in sync — a Desktop update automatically distributes the matching CLI. If the CLI binary is missing, the "Open Terminal" button in Settings shows an error banner instructing the user to restart the app.

## Chat UI

<!-- Content to be written: claude -p subprocess, stream-json output, conversation flow -->

## System Tray

<!-- Content to be written: macOS/Windows click-toggle, Linux menu-only, libappindicator requirement -->

## See Also

- [ADR-005: Two Interfaces — CLI and Desktop](../adr/ADR-005-two-interfaces-cli-and-desktop.md)
- [ADR-006: Chat UI via claude -p --stream-json](../adr/ADR-006-chat-ui-via-stream-json.md)
