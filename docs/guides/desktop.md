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

The Desktop chat UI launches `claude -p --output-format stream-json` inside the container and renders the response as it streams. See [ADR-006](../adr/ADR-006-chat-ui-via-stream-json.md) for the architectural decision.

### Session stats bar

The bar at the bottom of the chat shows the current state of the session, mirroring the container statusline layout:

```
claude-opus-4-7 │ CTX ██░░░ 2% │ 116k/1M │ Limit ░░░░░ 30% reset 16:42 │ $0.1409 │ In: 3 CR: 22,560 CW: 75 Out: 825
```

| Element      | Source                                     | Meaning                                                                                                                                                                 |
| ------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`      | `system.init.model`                        | Model id (e.g. `claude-opus-4-7`, `llama3.3`).                                                                                                                          |
| `CTX N%`     | `resolveContextWindow` (see below)         | Percentage of the context window used by the current turn (`input_tokens + cache_read + cache_creation`) ÷ window. Bar turns amber at 50%, red at 76%, bold red at 90%. |
| `used / max` | `formatContextLabel` (`models/llm.ts`)     | Short-form ratio (`116k/1M`, `42k/200k`). The label is `1M` for ≥ 1_000_000, `Xk` for ≥ 1_000.                                                                          |
| `Limit N%`   | `rate_limit_event.rate_limit_info`         | 5-hour subscription quota utilisation (Pro/Max only — absent for API-key users).                                                                                        |
| `$N.NNNN`    | `result.total_cost_usd`                    | Estimated API cost for the session (what it would cost at API pricing — shown even on subscriptions).                                                                   |
| `In: N`      | `result.usage.input_tokens`                | New input tokens for the last turn (tokens not served from cache).                                                                                                      |
| `CR: N`      | `result.usage.cache_read_input_tokens`     | Tokens loaded from prompt cache (system prompt, conversation history).                                                                                                  |
| `CW: N`      | `result.usage.cache_creation_input_tokens` | Tokens written to prompt cache during the last turn.                                                                                                                    |
| `Out: N`     | Cumulative `result.usage.output_tokens`    | Total tokens generated across all turns in the session.                                                                                                                 |

**Per-step vs. cumulative.** Claude Code's result message contains two usage sources: `result.usage` (flat — per-step, resets each API call) and `result.modelUsage` (cumulative — grows over the session). The CTX % uses the flat per-step value so it reflects actual context window consumption; the total cost uses `total_cost_usd` (cumulative) because cost accumulates.

**Context window resolution.** `ChatStateService.resolveContextWindow` walks a five-step fallback chain so the footer always has a concrete value:

1. Live stream value — `modelUsage.<model>.contextWindow` from the latest Result chunk.
2. Anthropic SSOT — `AnthropicModelsService.contextTokensFor(model)` (backed by the `list_anthropic_models` Tauri command, sourced from `defaults::ANTHROPIC_MODELS`).
3. Persisted `claude.llm.context_tokens` — populated by Settings save (Anthropic SSOT lookup or local discovery probe).
4. Previous in-memory `_contextWindowSize` — what the footer showed before the current turn.
5. `DEFAULT_CONTEXT_TOKENS` (200_000) — last resort, exported from `models/llm.ts`.

Settings invalidates the persisted layer by calling `ChatStateService.refreshLlmConfigCache()` after `update_llm_config` settles, so the footer reflects the new model's window immediately rather than waiting for the next session start.

### Stopping a conversation

While Claude is responding, press **Esc** or click the red **Stop** button next to the message input to interrupt the current turn. The partial response is preserved in the conversation history, in-flight tools are stopped, and the input is immediately re-enabled so you can send the next message. **Esc is ignored while an "ask user" question is visible** — answer or dismiss that prompt first; the Stop button still works in that case and will drop the question.

## System Tray

<!-- Content to be written: macOS/Windows click-toggle, Linux menu-only, libappindicator requirement -->

## Logs & system health

The `/logs` route hosts a single page that combines container logs, host-side service logs, and a compact system-health status bar. It replaced the previous Settings → Diagnostics block and the standalone System Health view.

**Status bar.** A horizontal strip at the top reports overall, VM, containers, IDE Bridge, and `mcp-os` health. Each cell expands on click to show the underlying details (container list with health, detected IDE list, etc.). The bar is computed from the `get_system_health` Tauri command and refreshes every 5 s.

**IDE Bridge connect link.** The IDE Bridge cell renders `connect →` when the daemon is running but no IDE is selected (`selected_ide` is `null`). The link deep-jumps to `/integrations#ide-bridge` (anchor scrolling is enabled in the Angular router for this) so the user can pick a target IDE without scrolling.

**Always-on trace logging.** On view init the page invokes `set_log_level` with `trace` so any diagnostics export carries the most verbose level regardless of any prior runtime setting. Failures are logged at `console.debug` and ignored — the log stream renders without the level upgrade.

**Diagnostics export.** A button bundles the runtime log directory plus a compact summary into a ZIP. The path is shown in a modal with a copy-to-clipboard control; the file is opened in the host's file manager rather than auto-attached anywhere, so the user controls who sees it.

**Log timestamps.** `nerdctl compose logs` and `wsl compose logs` now run with `--timestamps`, so every container log line carries an ISO date. The renderer also accepts the bracketed `[HH:MM:SS]` format emitted by some application loggers and prefixes it with the host's current date — note the day prefix is a hint when the container clock or timezone diverges from the host.

## See Also

- [ADR-005: Two Interfaces — CLI and Desktop](../adr/ADR-005-two-interfaces-cli-and-desktop.md)
- [ADR-006: Chat UI via claude -p --stream-json](../adr/ADR-006-chat-ui-via-stream-json.md)
