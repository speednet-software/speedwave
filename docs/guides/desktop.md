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

After restart, the desktop backend compares the installed bundle against `~/.speedwave/bundle-state.json`. If the `bundle_id` changed, it runs a startup reconcile:

1. Sync bundled `claude-resources` into `~/.speedwave/claude-resources`
2. Rebuild images tagged for the current `bundle_id`
3. Recreate only the projects that were running before the update
4. Emit `bundle_reconcile_status` so the UI can show progress or retry

The same startup reconcile also runs after a manual app upgrade outside the desktop UI.

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
- Tiny PNGs below the model's native long edge (2576 px for Opus 4.7, 1568 px for Sonnet/Haiku) and below 2 MB skip pica entirely.

There is no client-side gate on the active model — every provider gets a chance to accept the attachment. If the active model can't handle images (text-only Anthropic snapshot, local model loaded without vision, BYOK provider that ignores image blocks), the chat shows the provider's API error as a regular error block. See [ADR-065](../adr/ADR-065-image-attachments-structured-input.md) for the rationale (no client-side capability matrix to keep stale).

**Queue + attachments**: image attachments are mutually exclusive with the one-slot queued message (ADR-045). While a turn is streaming, **Send is disabled** for any input that carries attachments; text-only submits still queue normally. The composer surfaces "Poczekaj na zakończenie odpowiedzi przed wysłaniem obrazka" when this gate fires.

**Known limitation — no persistence**: attachment bytes live in the composer for the live session only. After a Desktop reload the chat history shows an `🖼 (filename)` placeholder pill instead of the thumbnail — the bytes themselves are not stored to disk (Claude Code's session JSONL is read-only per ADR-046, and a dedicated image store is future work).

The CLI (`speedwave run`, which launches Claude Code's TUI in the container) does **not** yet support image paste — the TUI's native paste reads the host clipboard, which the container cannot see. A host-side clipboard watcher is planned in a separate spike + PR.

## Project switcher

The project pill in the top-right of every view opens the project switcher dropdown — the single entry point for selecting, adding, and removing projects.

- **Switch:** click any inactive row. The active row is rendered disabled (no `current` pill — color and disabled state are the only signals) so it never reads as a clickable target.
- **Add:** the `+ add project…` footer opens the shared create-project modal.
- **Remove:** the trash icon appears on inactive rows on hover or keyboard focus. Clicking it swaps the row into an inline **Sure?** confirm with `delete` / `cancel` (same pattern as the conversation-history sidebar). Removing a project unregisters it from `~/.speedwave/config.json`, stops its containers, tears down its host-exec drain, and deletes every per-project subdirectory under `~/.speedwave/` (tokens, compose, context, claude-home, secrets, snapshots, oauth, host-exec). **The user's project files on the host are not touched** — only Speedwave-managed state is removed.
- The active project cannot be removed; switch to a different one first. The runtime layer enforces this regardless of caller, and the trash icon is hidden on the active row in the UI.
- If a backend error reaches the UI (compose-down failure, runtime guard), it surfaces inline under the row as a red `role="alert"` message — the config wipe is aborted so the user can retry.

## System Tray

## Logs & system health

The `/logs` route hosts a single page that combines container logs, host-side service logs, and a compact system-health status bar. It replaced the previous Settings → Diagnostics block and the standalone System Health view.

**Status bar.** A horizontal strip at the top reports overall, VM, containers, IDE Bridge, and `mcp-os` health. Each cell expands on click to show the underlying details (container list with health, detected IDE list, etc.). The bar is computed from the `get_system_health` Tauri command and refreshes every 5 s.

**IDE Bridge connect link.** The IDE Bridge cell renders `connect →` when the daemon is running but no IDE is selected (`selected_ide` is `null`). The link deep-jumps to `/integrations#ide-bridge` (anchor scrolling is enabled in the Angular router for this) so the user can pick a target IDE without scrolling.

**Always-on trace logging.** Desktop emits every log line at `trace` level — no UI toggle, no config field. The level cap is hard-coded in `main.rs` setup; diagnostics exports therefore always carry the most verbose context.

**Diagnostics export.** A button bundles the runtime log directory plus a compact summary into a ZIP. The path is shown in a modal with a copy-to-clipboard control; the file is opened in the host's file manager rather than auto-attached anywhere, so the user controls who sees it.

**Log timestamps.** Every Speedwave-emitted log line carries one ISO-8601 timestamp in **local time with a colon offset** (`2026-05-12T14:34:02.814+02:00`) — Rust loggers via `speedwave-runtime`'s `log_ts::log_timestamp()`, MCP workers / the hub / plugins via `@speedwave/mcp-shared`'s `ts()` (which reads the container's `TZ`, propagated from the host by `tz::detect_host_timezone`). The `/logs` view **renders every timestamp in the host's local zone** regardless of how the source wrote it — so a worker's `+02:00` stamp and nerdctl's UTC `Z` stamp (compose-container lines additionally carry nerdctl's RFC-3339 prefix; `nerdctl compose logs` / `wsl compose logs` run with `--timestamps`) for the same instant appear identically; the raw value is in the `[title]` tooltip. A bare bracketed `[HH:MM:SS]` from external tooling is dated with the host's current day.

## Meeting transcription

A separate, **opt-in** Desktop integration that records system audio + microphone on the host, transcribes it locally with whisper.cpp, and assigns provisional speaker labels with sherpa-onnx. Lives on its own tab (⌘4) and is off by default.

**Enabling.** Settings → Meeting transcription → toggle on. The toggle is a user-level preference (`~/.speedwave/config.json`) — repository `.speedwave.json` cannot enable it (privacy invariant from ADR-056). With the toggle off, the tab shows an empty-state that links back to Settings.

**What runs locally vs. over the network.** Audio inference (Whisper transcription, sherpa diarization) runs locally — no audio leaves the machine for inference. Model downloads use the network (≈75 MiB for `small`, up to ≈2.9 GiB for `large-v3`, plus a few hundred MiB of diarization models). "Send to Claude" uploads the rendered transcript text to your configured LLM provider. The UI states this on every relevant surface.

**Workflow.** Pick a language (Polish or English — never auto-detect; forced beats auto on Whisper) and an audio source → **Start recording**. The source picker defaults to **"Whole meeting (system audio + your microphone)"** — system loopback (what you hear: the other participants) and your mic, mixed into one stream; this is the headphones-on-a-call case. The other options are system-wide audio only, a specific app's audio (where the OS supports per-app capture), or just a microphone. The live transcript fills in with provisional `[Speaker N]` chips. **Stop** triggers a higher-quality offline pass: it loads the recorded WAV, re-transcribes the whole recording with `large-v3` (better cross-utterance context), re-diarizes the full audio, and swaps the result in — the speaker clusters may shift, so a chip you renamed is re-matched by temporal overlap. Then **Send to Claude** drops the transcript markdown into the active chat (a confirm dialog runs first — the markdown leaves the machine).

**Models.** Downloaded on demand, SHA-256-verified, stored under `~/.speedwave/models/whisper/` and `~/.speedwave/models/diarization/`. The model manager shows which are present, how much disk they use, download progress, and lets you delete any. The live pass needs only `small` (CPU) or `large-v3-turbo` (Metal); `large-v3` is fetched lazily for the offline pass — if you only have `small`, the UI offers to download it or skip the offline pass and keep the live transcript.

**Recordings & retention.** Each session stores `audio.wav` + `transcript.json` under `~/.speedwave/transcripts/<id>/` (0600). There is no auto-cleanup in v1 — the session list shows each recording's audio size and offers "discard audio" (keeps the transcript, frees disk, makes re-transcription impossible) and "delete transcript" (removes the whole directory). If audio was discarded, the offline pass can't run.

**Permissions (macOS).** The first time you record, macOS prompts for **Microphone** access (via the public `AVCaptureDevice` API) and — when the source includes system audio — for **System Audio Recording** access. The system-audio prompt has no public trigger, so `audio-capture-cli` requests it via the private `TCCAccessRequest(kTCCServiceAudioCapture)` API (the same approach AudioCap / AudioTee use; it works on a notarized `.dmg`) — see ADR-056 decision 3. The bundled CLI carries `NSMicrophoneUsageDescription` / `NSAudioCaptureUsageDescription` for the prompt text. If you denied either, open System Settings → Privacy & Security → Microphone / System Audio Recording and re-enable Speedwave; to reset the prompts entirely run `tccutil reset Microphone pl.speedwave.desktop.audio-capture` (and `tccutil reset AudioCapture pl.speedwave.desktop.audio-capture`). If the system-audio recording is silent while audio is clearly playing, the permission is most likely off — the UI surfaces this and links to the Settings pane.

**Per-OS requirements.** macOS 14.4+ (CoreAudio process taps). Windows 10 build 20348+ for per-app capture — older Windows 10 falls back to system-wide audio only (the source picker hides per-app options and a tooltip explains why).

**Language support & limits.** The promise is "local best-effort live transcription + a higher-quality offline pass" — not perfect Polish. Public Polish WER benchmarks for `large-v3-turbo` are sparse, so the catalogue keeps `medium` as a middle ground; the offline pass with `large-v3` is as good as Whisper gets. Diarization is provisional, not a reliable speaker ID — live labels lag, crosstalk confuses them, and the offline pass can re-cluster.

**Acceleration.** v1 ships CPU + Metal backends (the recording controls show "Acceleration: Metal" or "Acceleration: CPU only"). CUDA / Vulkan are explicitly out of scope for v1 — they need a separate CI toolchain and bundling strategy, tracked as follow-up.

See [ADR-056](../adr/ADR-056-host-side-audio-transcription.md) for the full design and trade-offs.

## See Also

- [ADR-005: Two Interfaces — CLI and Desktop](../adr/ADR-005-two-interfaces-cli-and-desktop.md)
- [ADR-006: Chat UI via claude -p --stream-json](../adr/ADR-006-chat-ui-via-stream-json.md)
- [ADR-056: Host-Side Audio Capture and Local Meeting Transcription](../adr/ADR-056-host-side-audio-transcription.md)
