# ADR-065: Image attachments via file-mount + text references

> **Status:** Accepted (2026-05-23).
> **Context:** Claude Code runs inside an isolated container (Lima on macOS, WSL2 on Windows) with no access to the host clipboard or screen, so the user cannot paste a screenshot into the TUI through the normal path. We needed a way to get pasted/dropped images to Claude on both the Desktop chat and the CLI.

## Decision

Pasted and dropped images are **never inlined as base64 on the wire**. The composer (Desktop) and a host clipboard watcher (CLI) write the image bytes to a file under `<project>/.speedwave/pastes/`, then reference it as an `@/workspace/...` text token inside an ordinary user-text message. The chat-input pipeline carries a single text-only wire shape end-to-end; Claude reads the bytes by path from its `/workspace` mount.

## Why

- The container can read `/workspace` but not the host clipboard. A file under the project dir is already mounted into the container, so a path reference is the simplest transport that needs zero changes to Claude Code itself.
- Inlining base64 image blocks OOM-killed the in-container process (exit 137) at payloads near Anthropic's documented 5 MB cap: the stream-json parser buffers the whole user message before sending upstream. File-mounting sidesteps the parser-buffer blowup entirely.
- One transport (text-only) keeps plan-mode prefixing, structured submit, and the one-slot queue coherent. No second block-typed transport to gate capabilities in two places.

## Wire shape

- The wire content block is **text-only**: `WireContentBlock` has a single `Text { text }` variant — no `Image` variant, no `ImageSource`/`Base64` type anywhere. Defined in `desktop/src-tauri/src/chat.rs` (`WireContentBlock`, `build_user_message`, `text_only`). TS mirror is `WireContentBlock = WireTextBlock` in `desktop/src/src/app/models/chat.ts`.
- The user envelope stays `{"type":"user","message":{"role":"user","content":[…]}}` with no `parent_tool_use_id` field (that tag is output-side, for tool-use correlation). The test `build_user_message_produces_correct_json_structure` (`chat.rs:2554-2556`) pins its absence.
- `build_user_message_snapshot_wire_format` pins the text-only envelope and asserts no `"image"` block and no inline base64 ever appears — it is a regression guard against re-introducing the OOM path, not a `media_type` check (there is no `media_type` field on the wire).

## State tree (history)

- The patch-stream state tree (ADR-042) does carry an image marker — `MessageBlock::Image { media_type, alt }` in `crates/speedwave-runtime/src/stream/state_tree.rs` — but **metadata only, no bytes**. TS mirror is `MessageBlock` in `chat.ts`; the Rust enum is the SSOT and any variant change starts there.
- After a Desktop reload the live blob URL is dead, so history renders a placeholder pill instead of the thumbnail. Bytes are not re-hydrated from Claude Code's session JSONL (ADR-046 forbids mutating that file; the transcript shape across model versions is unstable). A host-side image store is future work.

## Desktop save + preprocessing

- The pasted/dropped bytes are saved by the `save_pasted_image` Tauri command in `desktop/src-tauri/src/paste_cmd.rs` (validates magic bytes against the declared media type, host-side 10 MB cap, writes under `<project>/.speedwave/pastes/`, returns the `/workspace/...` container path).
- The renderer downscales first via `desktop/src/src/app/services/image-preprocessor.service.ts` (pica Lanczos resampler in a Web Worker). Per-model native long edges follow Anthropic's published values: Opus 2576 px, Sonnet/Haiku 1568 px; a second resize at 1568 px runs if the first attempt still exceeds the per-image cap. The post-resample cap is `MAX_IMAGE_BYTES = 3 MB` (below Anthropic's 5 MB, to leave parser headroom); over it surfaces `ERROR_TOO_LARGE` as a composer toast. JPEG/WebP re-encode at q=0.92; PNG re-encodes lossless to keep transparency; GIF passes through.

## Queue stays text-only

- The one-slot queue (ADR-045) carries `QueuedMessage.text: String` only, capped by `MAX_QUEUED_LEN = 1_000_000` (`desktop/src-tauri/src/queue_cmd.rs`). Image attachments are mutually exclusive with queuing: while a turn is streaming, the composer's `canSubmit()` returns false for any input carrying attachments and `submit()` refuses to enqueue them (`desktop/src/src/app/chat/composer/composer.component.ts`), surfacing "Poczekaj na zakończenie odpowiedzi przed wysłaniem obrazka." Text-only submits still queue through the existing path.

## No client-side capability gate

- KISS — paste/drop/picker is not blocked on the active model. A model that ignores images (text-only snapshot, local model without vision, BYOK provider) surfaces a clear server-side error block in the chat rather than being pre-empted by a client guess. The `ANTHROPIC_MODELS` SSOT (`crates/speedwave-runtime/src/defaults.rs`) carries no `supports_vision` field. Per-provider vision discovery is non-trivial (Ollama, LM Studio, llama.cpp each expose it differently) and deferred.

## CLI parity

- `speedwave run` spawns the host-side `PasteWatcher` (`crates/speedwave-cli/src/paste_watcher.rs`): it polls `arboard` every `POLL_MS = 250` ms and, on an image change, writes `<project>/.speedwave/pastes/clip.png` (chmod 0600 on Unix). `arboard` is cross-platform and short-circuits when the clipboard is unchanged; the watcher exits with `speedwave run`.
- Inside the container, `containers/osc52-copy.sh` (ADR-052) is symlinked as exactly five names — `pbcopy`, `xclip`, `xsel`, `wl-copy`, `clip.exe` (`containers/Containerfile.claude`) — and serves `clip.png` on read so the TUI's own paste path gets the bytes without changing Claude Code. `SPEEDWAVE_CLIP_FILE` overrides the read path (default `/workspace/.speedwave/pastes/clip.png`), used by the bats suite and as a debug escape hatch.

## Rejected alternatives

- **Inline base64 `image` blocks on the wire** (the original design). OOM-killed the in-container parser near 5 MB payloads; file-mount avoids buffering the whole expansion. There is deliberately no open `Image`/`ImageSource` extension point on the wire enum.
- **Always JPEG q=0.85 for every input.** Saves a branch but damages PNG transparency and degrades OCR on dense screenshots. Per-format choice keeps quality and size where each matters.
- **Client-side per-provider `supports_vision` matrix** blocking paste for non-vision models. Goes stale on every new local model; the Anthropic catalog has no non-vision 4.x entries; the API already returns a clear error block. Letting the user try beats guessing.
- **Queue carrying image attachments.** Would force the `QueuedMessage` shape and `MAX_QUEUED_LEN` to change with no compelling UX gain (queuing an image mid-stream is rarely wanted). Mutual exclusion is simpler.
- **Anthropic Files API (`files-api-2025-04-14`).** Beta header that saves bandwidth, not tokens; without a re-reference UX it is pure overhead. Path-based file-mount is simpler and ships today.
- **Restart-session payload resend.** ADR-046 forbids Speedwave resending payloads; retry is native session resume from Claude's own JSONL transcript. We carry no state for retries.
