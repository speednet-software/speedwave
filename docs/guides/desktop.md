# Desktop App

The Speedwave Desktop app provides a chat UI, project management, and system integrations via a Tauri-based application.

## Overview

The desktop shell is a Tauri backend with an Angular frontend. It owns the setup wizard, project list, tray integration, auto-update checks, and the startup reconcile that keeps bundled resources, container images, and restored projects aligned with the installed app version.

## CLI Integration

The Desktop app bundles the `speedwave` CLI binary in its resources. On every startup (and during initial setup), the app copies the bundled CLI to the user's PATH:

- **macOS:** `~/.local/bin/speedwave`
- **Windows:** `%USERPROFILE%\.speedwave\bin\speedwave.exe`

This ensures the CLI and Desktop versions always stay in sync — a Desktop update automatically distributes the matching CLI. If the CLI binary is missing, the "Open Terminal" button in Settings shows an error banner instructing the user to restart the app.

## App Update Flow

The desktop app now uses a single backend flow for update installation:

1. The frontend calls `install_update_and_reconcile(expectedVersion)`.
2. The backend records `pending_running_projects` in `~/.speedwave/bundle-state.json`.
3. Running project containers are stopped before the app update is installed.
4. The app installs the approved version and restarts immediately.

After restart, the desktop backend compares the installed bundle against `~/.speedwave/bundle-state.json`. If the reconcile id (`bundle_id`) changed, it runs a startup reconcile:

1. Sync bundled `claude-resources` into `~/.speedwave/claude-resources`
2. Build only the images whose per-image build-input hash tag is missing ([ADR-072](../adr/ADR-072-per-image-build-input-hash-tags.md)) — a release with no container changes builds zero images
3. Recreate only the projects that were running before the update
4. Emit `bundle_reconcile_status` so the UI can show progress or retry

If the reconcile id is unchanged but projects were stopped by a no-op update (e.g. a same-version reinstall), the reconcile restores them instead of stranding them stopped. The same startup reconcile also runs after a manual app upgrade outside the desktop UI.

## Bundle Identity

Desktop builds generate `build-context/bundle-manifest.json` with:

- `app_version`
- `bundle_id` — the reconcile id (app_version + per-image hashes + resources hash)
- `image_hashes` — per-image build-input hash map (image name → 16-char hex)
- `claude_resources_hash`

The runtime uses `bundle_id` as the reconcile trigger (resources sync + project restore) and `image_hashes` to tag and rebuild images. Built-in images are rendered as `speedwave-*:<per-image-hash>`, so an update rebuilds only the images whose own build inputs changed (see [ADR-072](../adr/ADR-072-per-image-build-input-hash-tags.md)).

## Bundle Asset Validation

Desktop packaging now fails before release if the staged app bundle is missing required runtime assets. The gate covers bundled `mcp-os`, container build-context, the bundled `speedwave` CLI, platform container helpers, and on macOS also the four native integration binaries (`reminders-cli`, `calendar-cli`, `mail-cli`, `notes-cli`).

## Chat UI

The Desktop chat UI launches `claude -p --output-format stream-json` inside the container and renders the response as it streams. See [ADR-006](../adr/ADR-006-chat-ui-via-stream-json.md) for the architectural decision.

### Session stats bar

The bar at the bottom of the chat shows the current state of the session, mirroring the container statusline layout:

```
claude-opus-4-8 │ CTX ██░░░ 2% │ 116k/1M │ Limit ░░░░░ 30% reset 16:42 │ $0.1409 │ In: 3 CR: 22,560 CW: 75 Out: 825
```

| Element      | Source                                     | Meaning                                                                                                                                                                 |
| ------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`      | `system.init.model`                        | Model id (e.g. `claude-opus-4-8`, `llama3.3`).                                                                                                                          |
| `CTX N%`     | `resolveContextWindow` (see below)         | Percentage of the context window used by the current turn (`input_tokens + cache_read + cache_creation`) ÷ window. Bar turns amber at 50%, red at 76%, bold red at 90%. |
| `used / max` | `formatContextLabel` (`models/llm.ts`)     | Short-form ratio (`116k/1M`, `42k/200k`). The label is `1M` for ≥ 1_000_000, `Xk` for ≥ 1_000.                                                                          |
| `Limit N%`   | `rate_limit_event.rate_limit_info`         | 5-hour subscription quota utilisation (Pro/Max only — absent for API-key users).                                                                                        |
| `$N.NNNN`    | `result.total_cost_usd`                    | Estimated API cost for the session (what it would cost at API pricing — shown even on subscriptions).                                                                   |
| `In: N`      | `result.usage.input_tokens`                | New input tokens for the last turn (tokens not served from cache).                                                                                                      |
| `CR: N`      | `result.usage.cache_read_input_tokens`     | Tokens loaded from prompt cache (system prompt, conversation history).                                                                                                  |
| `CW: N`      | `result.usage.cache_creation_input_tokens` | Tokens written to prompt cache during the last turn.                                                                                                                    |
| `Out: N`     | Cumulative `result.usage.output_tokens`    | Total tokens generated across all turns in the session.                                                                                                                 |

**Latest-turn vs. cumulative.** Claude Code's result message contains two usage sources: `result.usage` (flat — the latest turn's full-prompt usage, _not_ summed across turns) and `result.modelUsage` (cumulative — grows over the session). The CTX % uses the flat value (`input_tokens + cache_read + cache_creation`) because each turn re-sends the whole conversation, so the latest turn already reflects total context occupancy — summing across turns would double-count the re-sent history. The total cost uses `total_cost_usd` (cumulative) because cost accumulates. In the Desktop footer, `in:` shows `input_tokens` only (the new uncached input) so a short chat doesn't read as the full context size; the CTX gauge keeps the additive total.

**Context window resolution.** `ChatStateService.resolveContextWindow` walks a five-step fallback chain so the footer always has a concrete value:

1. Live stream value — `modelUsage.<model>.contextWindow` from the latest Result chunk.
2. Anthropic SSOT — `AnthropicModelsService.contextTokensFor(model)` (backed by the `list_anthropic_models` Tauri command, sourced from `defaults::ANTHROPIC_MODELS`).
3. Persisted `claude.llm.context_tokens` — populated by Settings save (Anthropic SSOT lookup or local discovery probe).
4. Previous in-memory `_contextWindowSize` — what the footer showed before the current turn.
5. `DEFAULT_CONTEXT_TOKENS` (200_000) — last resort, exported from `models/llm.ts`.

Settings invalidates the persisted layer by calling `ChatStateService.refreshLlmConfigCache()` after `update_llm_config` settles, so the footer reflects the new model's window immediately rather than waiting for the next session start.

### Conversation history sidebar

Opens with the **History** button in the chat header (or ⌘B). Lists past sessions for the active project, grouped by today / yesterday / older, with a search filter. Clicking a row resumes that session in live chat. The trash icon next to each row (visible on hover) deletes the underlying JSONL transcript file — a one-tap inline confirm asks **Sure?** before the file is removed. Deletion is irreversible; deleting the currently active session resets the chat to a fresh conversation.

### Stopping a conversation

While Claude is responding, press **Esc** or click the red **Stop** button next to the message input to interrupt the current turn. The partial response is preserved in the conversation history, in-flight tools are stopped, and the input is immediately re-enabled so you can send the next message. **Esc is ignored while an "ask user" question is visible** — answer or dismiss that prompt first; the Stop button still works in that case and will drop the question.

### Image attachments

The chat composer accepts image attachments two ways: **paste** (Cmd/Ctrl+V with an image in the clipboard — typed text in the same paste still drops into the textarea) and **drag-and-drop** from Finder/Explorer onto the composer. Multi-drop is supported (drop a Finder selection of several files at once).

Accepted formats: **JPEG, PNG, GIF, WebP**. Other types (PDF, SVG, plain text drops) are silently ignored.

Per-image cap: **3 MB binary** after preprocessing (Anthropic accepts up to 5 MB, but Claude Code's stream-json parser buffers the whole message before send and payloads near the API ceiling have been observed to OOM-kill the in-container process). Per-request cap: **32 MB JSON payload** (base64 expands the binary by 4/3). Above 20 images per request Anthropic drops the dimension cap from 8000×8000 to 2000×2000.

Speedwave preprocesses with [pica](https://github.com/nodeca/pica) before send:

- **PNG** stays PNG (transparency preserved).
- **JPEG / WebP** resamples to JPEG q=0.92 (text OCR remains comfortable).
- **GIF** passes through (Anthropic processes only the first frame; the file on disk keeps the animation).
- Tiny PNGs below the model's native long edge (2576 px for Opus, 1568 px for Sonnet/Haiku) and below 2 MB skip pica entirely.

There is no client-side gate on the active model — every provider gets a chance to accept the attachment. If the active model can't handle images (text-only Anthropic snapshot, local model loaded without vision, BYOK provider that ignores image blocks), the chat shows the provider's API error as a regular error block. See [ADR-065](../adr/ADR-065-image-attachments-structured-input.md) for the rationale (no client-side capability matrix to keep stale).

**Queue + attachments**: image attachments are mutually exclusive with the one-slot queued message (ADR-045). While a turn is streaming, **Send is disabled** for any input that carries attachments; text-only submits still queue normally. The composer surfaces "Poczekaj na zakończenie odpowiedzi przed wysłaniem obrazka" when this gate fires.

**Known limitation — no persistence**: attachment bytes live in the composer for the live session only. After a Desktop reload the chat history shows an `🖼 (filename)` placeholder pill instead of the thumbnail — the bytes themselves are not stored to disk (Claude Code's session JSONL is read-only per ADR-046, and a dedicated image store is future work).

The CLI (bare `speedwave`, which launches Claude Code's TUI in the container) does **not** yet support image paste — the TUI's native paste reads the host clipboard, which the container cannot see. A host-side clipboard watcher is planned in a separate spike + PR.

## Project switcher

The project pill in the top-right of every view opens the project switcher dropdown — the single entry point for selecting, adding, and removing projects.

- **Switch:** click any inactive row. The active row is rendered disabled (no `current` pill — color and disabled state are the only signals) so it never reads as a clickable target.
- **Add:** the `+ add project…` footer opens the shared create-project modal.
- **Remove:** the trash icon appears on inactive rows on hover or keyboard focus. Clicking it swaps the row into an inline **Sure?** confirm with `delete` / `cancel` (same pattern as the conversation-history sidebar). Removing a project unregisters it from `~/.speedwave/config.json`, stops its containers, and deletes every per-project subdirectory under `~/.speedwave/` (tokens, compose, context, claude-home, secrets, snapshots, oauth). **The user's project files on the host are not touched** — only Speedwave-managed state is removed.
- The active project cannot be removed; switch to a different one first. The runtime layer enforces this regardless of caller, and the trash icon is hidden on the active row in the UI.
- If a backend error reaches the UI (compose-down failure, runtime guard), it surfaces inline under the row as a red `role="alert"` message — the config wipe is aborted so the user can retry.

## System Tray

Speedwave runs a system tray icon on both platforms (ADR-058). macOS renders a black template glyph that the system inverts for the active appearance; Windows uses a white glyph for the notification area's typically-dark background.

**Left-click** the icon toggles the main window's visibility (show if hidden, hide if visible). Rapid clicks within 500 ms are debounced to avoid a double-toggle.

**Right-click** opens the context menu. Its items are built from the current state:

- **Open Speedwave** — brings the main window to the foreground.
- **Check for Updates** — runs the updater on demand.
- **Install Update v{version}** — appears only when the updater has found a newer version.
- **Beta features** — a checkbox that toggles beta features in the user config. Hidden until setup completes, so the switch can't race the wizard's data-dir creation.
- **Quit** — exits the app.

## Logs & system health

The `/logs` route hosts a single page that combines container logs, host-side service logs, and a compact system-health status bar. It replaced the previous Settings → Diagnostics block and the standalone System Health view.

**Status bar.** A horizontal strip at the top reports overall, VM, containers, IDE Bridge, and `mcp-os` health. Each cell expands on click to show the underlying details (container list with health, detected IDE list, etc.). The bar is computed from the `get_health` Tauri command and refreshes every 5 s.

**IDE Bridge connect link.** The IDE Bridge cell renders `connect →` when the daemon is running but no IDE is selected (`selected_ide` is `null`). The link deep-jumps to `/integrations#ide-bridge` (anchor scrolling is enabled in the Angular router for this) so the user can pick a target IDE without scrolling.

**Always-on trace logging.** Desktop emits every log line at `trace` level — no UI toggle, no config field. The level cap is hard-coded in `main.rs` setup; diagnostics exports therefore always carry the most verbose context.

**Diagnostics export.** A button bundles the runtime log directory plus a compact summary into a ZIP. The path is shown in a modal with a copy-to-clipboard control; the file is opened in the host's file manager rather than auto-attached anywhere, so the user controls who sees it.

**Log timestamps.** Every Speedwave-emitted log line carries one ISO-8601 timestamp in **local time with a colon offset** (`2026-05-12T14:34:02.814+02:00`) — Rust loggers via `speedwave-runtime`'s `log_ts::log_timestamp()`, MCP workers / the hub / plugins via `@speedwave/mcp-shared`'s `ts()` (which reads the container's `TZ`, propagated from the host by `tz::detect_host_timezone`). The `/logs` view **renders every timestamp in the host's local zone** regardless of how the source wrote it — so a worker's `+02:00` stamp and nerdctl's UTC `Z` stamp (compose-container lines additionally carry nerdctl's RFC-3339 prefix; `nerdctl compose logs` / `wsl compose logs` run with `--timestamps`) for the same instant appear identically; the raw value is in the `[title]` tooltip. A bare bracketed `[HH:MM:SS]` from external tooling is dated with the host's current day.

## Meeting transcription

A Desktop integration that records system audio + microphone on the host and transcribes it locally with whisper.cpp. Lives on its own tab (⌘4), behind the beta-features gate. The output is a clean timestamped transcript with no speaker attribution; if you need "who said what", let Claude infer it when it summarizes the transcript (see [ADR-075](../adr/ADR-075-remove-speaker-diarization.md)).

**Getting set up.** Enable beta features (Settings → Beta features) to reveal the tab, then download the speech model in Settings → Meeting transcription (a single download — see **Model** below). A checked-in repository `.speedwave.json` cannot turn host-audio recording on (privacy invariant from ADR-056). There is no separate per-feature toggle — recording does nothing until you press **Start**.

**What runs locally vs. over the network.** Audio inference (Whisper transcription) runs locally — no audio leaves the machine for inference. The one-time model download uses the network (≈1.6–3.1 GiB depending on hardware). "Send to Claude" uploads the rendered transcript text to your configured LLM provider. The UI states this on every relevant surface.

**Workflow.** Pick a language (Polish or English — never auto-detect; forced beats auto on Whisper), an audio source, and (for mic/mixed sources) a specific microphone → **Start recording**. The source picker offers three options and defaults to **"Whole meeting (system audio + your microphone)"** — system loopback (what you hear: the other participants) and your mic, mixed into one stream; this is the headphones-on-a-call case. The other two are system-wide audio only, or just a microphone. The live transcript fills in as you speak. **Stop** triggers a higher-quality offline pass: it loads the recorded WAV, re-transcribes the whole recording (better cross-utterance context), and swaps the result in. Then **Send to Claude** drops the transcript markdown into the active chat (a confirm dialog runs first — the markdown leaves the machine).

**Model.** One model, auto-selected for your hardware and downloaded from Settings → Meeting transcription: `large-v3` on builds with a GPU backend (the GPU keeps the live window real-time at full quality), `large-v3-turbo` on CPU-only builds. It is SHA-256-verified and stored under `~/.speedwave/models/whisper/`. Settings shows the detected acceleration, the model's download state, and a single download / remove control — no model list, no quality/speed trade-off to reason about.

**Recordings & retention.** Each session stores `audio.wav` + `transcript.json` under `~/.speedwave/transcripts/<id>/` (0600). There is no auto-cleanup — the session list offers a single **delete** per recording that removes the whole directory (audio + transcript).

**Permissions (macOS).** The first time you record, macOS prompts for **Microphone** access (via the public `AVCaptureDevice` API) and — when the source includes system audio — for **System Audio Recording** access. The system-audio prompt has no public trigger, so `audio-capture-cli` requests it via the private `TCCAccessRequest(kTCCServiceAudioCapture)` API (the same approach AudioCap / AudioTee use; it works on a notarized `.dmg`) — see ADR-056 decision 3. The bundled CLI carries `NSMicrophoneUsageDescription` / `NSAudioCaptureUsageDescription` for the prompt text. If you denied either, open System Settings → Privacy & Security → Microphone / System Audio Recording and re-enable Speedwave; to reset the prompts entirely run `tccutil reset Microphone pl.speedwave.desktop.audio-capture` (and `tccutil reset AudioCapture pl.speedwave.desktop.audio-capture`). If the system-audio recording is silent while audio is clearly playing, the permission is most likely off — the UI surfaces this and links to the Settings pane.

**Per-OS requirements.** macOS 14.4+ (CoreAudio process taps). Windows uses WASAPI system-wide loopback.

**Language support & limits.** The promise is "local best-effort live transcription + a higher-quality offline pass" — not perfect Polish. On GPU builds the live and offline passes share `large-v3`, which is as good as Whisper gets; CPU-only builds use `large-v3-turbo` to keep the live window real-time.

**Acceleration.** v1 ships CPU + Metal backends (the recording controls show "Acceleration: Metal" or "Acceleration: CPU only"). CUDA / Vulkan are explicitly out of scope for v1 — they need a separate CI toolchain and bundling strategy, tracked as follow-up.

See [ADR-056](../adr/ADR-056-host-side-audio-transcription.md) for the full design and trade-offs.

## LLM usage

A per-project dashboard on its own tab (⌘5, route `/usage`) that aggregates every LLM request the project has made through the embedded speedwave-proxy forwarder ([ADR-073](../adr/ADR-073-embedded-per-project-litellm-proxy.md)). It shows:

- **Totals cards** — requests, prompt/completion tokens, estimated cost, prompt-cache hit rate, throughput (tok/s), and failures (with failure rate). If any lines could not be parsed, a small `(N records skipped)` note appears rather than silently under-counting.
- **Daily tokens chart** — a stacked bar per day (prompt vs. completion tokens) over the most recent month, built from plain CSS — no chart library.
- **Weekday × hour heatmap** — request volume by local hour, so you can see when the project is busiest.
- **Per-(day, model) table** — the breakdown the cards roll up.

**Source of truth.** This dashboard reads **only** the proxy's usage log — the forwarder's per-request JSONL line at `~/.speedwave/usage/<project>/speedwave-proxy/usage.jsonl`, aggregated host-side by `speedwave_runtime::usage` and surfaced through the `get_llm_usage` command. It is deliberately **separate** from the chat footer's [Session stats bar](#session-stats-bar): the footer reflects the live Claude Code result stream for the current session, while this dashboard is the cross-session record. The two are never summed — the same request would otherwise be counted twice (ADR-073 §usage, invariant 6 of `.claude/rules/local-llm.md`).

Numbers reflect what the proxy could measure: cost currently reads `$0` across the board — the MVP forwarder records tokens only, and cost enrichment is a separate follow-up (ADR-073 §usage). A record with no usable timestamp still counts toward totals but is omitted from the day/hour charts.

## Appearance

Settings → Appearance controls two independent choices:

- **Mode** — `light`, `dark`, or `auto`. `auto` follows the operating system's `prefers-color-scheme` and switches live when the system theme changes. The choice persists locally (browser `localStorage`, key `speedwave-theme-mode`); on first run the app defaults to `dark`. An inline script in `index.html` applies the persisted mode before the app boots, so the first paint never flashes the wrong scheme.
- **Accent color** — one of six accent palettes (crimson, mint, amber, iris, cyan, sand) used for buttons, links, active-state indicators, and syntax highlighting. Persisted under `speedwave-theme`.

The two axes are orthogonal: any accent works in either mode. Accent colors are tuned per mode so text and icons meet WCAG AA contrast against the active background. The native window titlebar stays system-native and is not themed by the app. Both axes are managed by `ThemeService`; accent values live in `desktop/src/src/styles.css` as CSS custom properties (the single source of truth — components read `var(--accent)` etc., never hard-coded hex).

WCAG contrast waivers, if any, are recorded in [accessibility/contrast-report.md](../accessibility/contrast-report.md).

## See Also

- [ADR-005: Two Interfaces — CLI and Desktop](../adr/ADR-005-two-interfaces-cli-and-desktop.md)
- [ADR-006: Chat UI via claude -p --stream-json](../adr/ADR-006-chat-ui-via-stream-json.md)
- [ADR-056: Host-Side Audio Capture and Local Meeting Transcription](../adr/ADR-056-host-side-audio-transcription.md)
