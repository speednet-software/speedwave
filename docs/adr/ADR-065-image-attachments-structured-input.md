# ADR-065 — Image attachments via structured user input

## Status

Accepted (2026-05-23). Tracks SPEED-92.

## Context

Speedwave runs Claude Code inside an isolated container (Lima on macOS, WSL2
on Windows). The container has no access to the host clipboard or screen,
so the user cannot paste screenshots into Claude Code's TUI through the
existing transport[^1][^2]. Anthropic's Messages API accepts `image`
content blocks with base64-inlined bytes[^3] and Claude Code passes
`--input-format stream-json` user blocks through to the API unchanged[^4],
so the same wire shape works for our Desktop chat path.

Until v1.1.0 the entire chat-input pipeline was string-typed end-to-end:
`composer → ChatStateService.sendMessage(text: string) → Tauri
send_message(message: String) → ChatSession.send_message(&str) →
build_user_message(&str)`. Adding image attachments without restructuring
that path would create two parallel transports (one stringly-typed, one
block-typed) and split capability gating in two places.

## Decision

### 1. Wire kontrakt — `WireContentBlock`

`desktop/src-tauri/src/chat.rs::build_user_message` accepts
`&[WireContentBlock]` instead of `&str`. `WireContentBlock` is a serde
tagged enum (`#[serde(tag = "type", rename_all = "snake_case")]`) with
`Text { text }` and `Image { source: ImageSource }` variants. `ImageSource`
is itself a tagged enum currently holding only `Base64 { media_type, data }`
— the shape is open so a future `File { file_id }` variant (Anthropic
Files API beta `files-api-2025-04-14`[^5]) can land without a breaking
change.

The envelope stays exactly as it was —
`{"type":"user","message":{"role":"user","content":[…]}}` with no
`parent_tool_use_id` field. That field lives on the _output_ side of
stream-json for tool-use correlation; the existing tests at
`chat.rs:2313` documented its absence on user input and we preserve that
invariant.

### 2. `MessageBlock` SSOT lives in Rust

`crates/speedwave-runtime/src/stream/state_tree.rs::MessageBlock` is the
SSOT for the state-tree variant union (ADR-042 patch stream). The TS
`desktop/src/src/app/models/chat.ts::MessageBlock` is a mirror — every
variant change starts in Rust, then propagates to TS. Adding a TS variant
without the matching Rust variant would silently break deserialization on
the first patch that carries the new `kind`.

The new variant is `Image { media_type: String, alt: Option<String> }` —
**metadata only**. The state-tree intentionally does NOT carry attachment
bytes (see decision 6).

### 3. Queue stays text-only (mutual exclusion)

ADR-045 reserves one queued message per session. `QueuedMessage.text:
String` and `MAX_QUEUED_LEN = 1_000_000` were sized for text — a single
5 MB image's base64 payload already exceeds that cap by 5×, and extending
the queue to carry image bytes would force changes across
`stream/state_tree.rs::QueuedMessage`, `stream/patch.rs::set_pending_queue`,
`patch_emitter.rs`, the frontend mirror, and the persisted JSONL format.

Decision: **image attachments are mutually exclusive with queued state.**
While streaming, the composer disables Send for any input that carries
attachments and surfaces "Poczekaj na zakończenie odpowiedzi przed
wysłaniem obrazka". Text-only submits during streaming still queue
through the existing ADR-045 path. The decision is preserved as a
composer-side gate (`canSubmit()`) and a Send-time guard in `submit()`.

### 4. Smart preprocessing per format (pica)

`desktop/src/src/app/services/image-preprocessor.service.ts` uses
[pica](https://github.com/nodeca/pica) for Lanczos downscaling (off the
main thread via WebWorkers). Pipeline:

- **GIF**: pass-through (Anthropic processes only the first frame, but
  the user retains animation on disk).
- **Small enough** (≤2 MB and below the model's native long edge):
  pass-through.
- **PNG resampled**: re-encode as PNG to preserve transparency. PNG is
  lossless — the Canvas `toBlob` quality argument is ignored by spec.
- **JPEG / WebP resampled**: re-encode as JPEG q=0.92 (text OCR
  remains comfortable; q=0.85 degrades dense screenshots visibly).

Per-model native long edges follow Anthropic's published values[^3]:
Opus 4.7 = 2576 px, Sonnet 4.6 / Haiku 4.5 = 1568 px. A second resize
attempt at 1568 px runs if the first attempt still exceeds the per-image
cap; if that also fails, `ERROR_TOO_LARGE` surfaces to the composer toast.

The per-image cap is **3 MB binary** (`MAX_IMAGE_BYTES` in
`image-preprocessor.service.ts`), not the Anthropic-documented 5 MB[^3].
Rationale: Claude Code's stream-json parser buffers the entire user
message (envelope + text + base64 expansion + parser working memory)
before sending it upstream. Empirically, payloads with images near 5 MB
have OOM-killed the in-container process (exit code 137) on default
container memory budgets, even with `effective_claude_memory_gib()`
allocating ≥4 GiB. 3 MB leaves enough headroom for two attachments plus
text plus the parser's transient buffer. Lift the cap only with evidence
that the in-container memory budget is being raised to match — and an
ADR amendment.

### 5. No client-side capability gate

KISS — we do not block paste/drop/picker on the active model. Every
provider gets a chance to accept images; the backend reply path already
renders API errors as error blocks in the chat, so a mismatched model
(text-only Anthropic snapshot, local model without vision, BYOK provider
that ignores image blocks) surfaces a clear server-side message instead
of being preempted by a guess on the client.

Rationale: capability discovery is non-trivial across providers (Ollama
exposes `details.capabilities` per model in `/api/show`, LM Studio
surfaces a vision badge in `/api/v0/models`, llama.cpp depends on the
loaded gguf — none of them speak Anthropic's `supports_vision` shape).
Building a per-provider capability matrix that has to keep up with each
new local model is its own feature; rejecting all local providers
unconditionally is worse UX than letting the API answer. The
`AnthropicModel` SSOT therefore does not carry a `supports_vision`
field.

### 6. No persistence of attachment bytes

The state-tree carries only `{ media_type, alt }` for image blocks. The
displayable bytes live in the composer's `attachments` signal as a fresh
blob URL for the duration of the live session; on Desktop reload the
blob URL is dead and the history renders an `🖼 (alt)` placeholder
instead of the thumbnail.

Bytes are also not re-hydrated from Claude Code's session JSONL. ADR-046
forbids Speedwave from mutating that file, and the transcript shape
across model versions is unstable enough (some snapshot images as
`[Image #N]` placeholders) that any reader would be best-effort. A
dedicated host-side image store is future work; surfacing a placeholder
keeps v1 honest about the data we have.

### 7. CLI parity via host watcher + `xclip` read shim

`speedwave run` spawns `paste_watcher::PasteWatcher` (host-side, `arboard`
polling 250 ms) which writes `<project>/.speedwave/pastes/clip.png` (chmod
0600). Inside the container, `containers/osc52-copy.sh` — symlinked as
`xclip`/`xsel`/`wl-copy`/`wl-paste`/`pbcopy`/`clip.exe` — serves that file
on `-o`/`--out`/`--paste` reads so Claude Code TUI's own paste path
(`xclip -t image/png -o`) gets the bytes without changing claude.

`arboard` works cross-platform (macOS NSPasteboard, Windows OpenClipboard,
no event-driven backend needed); polling cost is negligible because
arboard short-circuits when the clipboard hasn't changed. The watcher
quits when `speedwave run` exits, so it's scoped to the user's session.

`SPEEDWAVE_CLIP_FILE` env var overrides the read-side path inside the
container (defaults to `/workspace/.speedwave/pastes/clip.png`) — used by
the bats test suite, surfaced here as a documented escape hatch for
operators debugging the read shim.

## Consequences

### Positive

- One transport for chat input — `WireContentBlock[]` end-to-end from
  composer to claude stdin. Plan-mode prefix, structured submit and
  queue stay coherent.
- No client-side capability gate — every provider gets a chance to
  accept images and the API surfaces a clear error if it can't.
- Snapshot test (`chat.rs::build_user_message_snapshot_wire_format`)
  pins the entire serialized envelope including `media_type`
  spelling, so a future refactor cannot silently flip to `mimeType` or
  reintroduce `parent_tool_use_id`.
- The Rust `MessageBlock::Image` variant carries no bytes, so the patch
  stream (ADR-042) stays small even for image-heavy turns.

### Negative

- History after Desktop reload shows a placeholder pill instead of the
  thumbnail. The original blob URL was the only owner of the bytes;
  re-creating it post-reload would require a host-side image store
  (out of scope for v1).
- CLI paste latency: `arboard` polling 250 ms (`POLL_MS` in
  `paste_watcher.rs`). A freshly-copied image is visible to Claude
  within one poll tick; faster intervals burn battery without
  user-visible gain.
- `pica` adds ~50 KB gzipped to the renderer bundle. The Lanczos
  resampler runs in a Web Worker, so the main thread stays
  responsive during paste of a 4K screenshot.

### Neutral

- Backwards-compat shims for the old stringly-typed `send_message` were
  not introduced — every call-site (composer, chat-state, transcription,
  Tauri command, snapshot tests) was migrated in one commit. Per
  CLAUDE.md "no backwards-compatibility shims when you can just change
  the code".
- `MAX_QUEUED_LEN` (1 MB) stays as-is. The mutual-exclusion decision
  removes any reason to grow it.

## Alternatives rejected

- **TS-only `MessageBlock::Image`**. Adding the variant only to the TS
  mirror would deserialize-fail in Rust on the first patch carrying
  `kind: "image"`. The state-tree SSOT is Rust (ADR-042).
- **Always JPEG q=0.85 for every input**. Saves a code branch but
  damages transparency (PNG sources) and OCR (q=0.85 degrades small
  text visibly). Per-format choice keeps quality where it matters and
  size where it matters.
- **Client-side capability matrix** (per-provider `supports_vision`
  flag in the SSOT, blocking paste/drop for non-vision models). KISS:
  the matrix becomes stale every time a new local model lands, the
  Anthropic catalog has no non-vision 4.x entries, and the API answer
  is already a clear error block in the chat. Letting the user try
  beats guessing on their behalf.
- **Queue carrying image blocks**. Forces `QueuedMessage` shape to
  change, breaks `MAX_QUEUED_LEN`, complicates ADR-045 semantics, and
  has no compelling UX gain (queuing a 5 MB image while still streaming
  the previous turn is rarely what the user wants).
- **Files API (`files-api-2025-04-14`)**[^5]. Beta header, saves
  bandwidth not tokens; without a re-reference UX (same screenshot
  across many turns) it's pure overhead. The `WireImageSource` tagged
  enum leaves space to land it later.
- **Restart-session payload resend**. ADR-046 explicitly forbids
  Speedwave resending the payload — retry is `claude --resume <id>
--resume-session-at <user_uuid>`, the model rebuilds from its own
  JSONL transcript. We carry no state for retries.

## References

[^1]: Claude Code "Work with images" — `https://code.claude.com/docs/en/common-workflows#work-with-images`

[^2]: Claude Code CLI reference — `https://code.claude.com/docs/en/cli-reference`

[^3]: Anthropic Vision API — `https://platform.claude.com/docs/en/build-with-claude/vision`

[^4]: Agent SDK streaming-input — `https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode`

[^5]: Anthropic Files API — `https://platform.claude.com/docs/en/build-with-claude/files`

[^6]: Local-LLM provider support varies — Ollama exposes image support per-model in `/api/show` `details.capabilities`; LM Studio surfaces it as a model badge; llama.cpp depends on the loaded gguf. Discovery is non-trivial and deferred.
