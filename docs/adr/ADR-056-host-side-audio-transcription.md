# ADR-056: Host-Side Audio Capture and Local Meeting Transcription

## Status

Proposed (2026-05-11). **Three validation spikes (0A build/link ML, 0B host audio capture, 0C model catalog) gate acceptance** — see [Spike findings](#spike-findings). This ADR is not Accepted until all three spikes pass; if a spike surfaces a blocker, the relevant decision below is revised before any implementation begins.

## Context

Speedwave's core threat model puts Claude in a hardened, token-free container with no host device access — no microphone, no audio output, no camera (see [security model](../architecture/security.md), [containers](../architecture/containers.md)). A requested feature — _record a meeting (Slack / Teams / Meet / any app), transcribe it live with speaker labels, locally, then optionally hand the transcript to Claude_ — therefore **cannot** be a containerized MCP worker or a plugin: plugins are containers ([ADR-051](ADR-051-plugin-signature-runtime-verification.md), CLAUDE.md plugin contract), and a container has no path to host audio. Capturing system audio plus the user's microphone is also a privacy-sensitive host capability that must be visibly opt-in and shipped/signed by Speedwave, not pulled in as a third-party plugin.

The natural home is therefore the **host side** — the Tauri/Desktop process and bundled native helpers — alongside the existing `mcp-os` host worker and the native macOS CLIs (`calendar-cli`, `mail-cli`, `notes-cli`, `reminders-cli`).

There is no single cross-platform API for "capture the system's audio output". macOS, Windows, and Linux each expose a different mechanism with different OS-version floors, permission models, and per-process vs system-wide granularity. Whisper (the obvious local speech-to-text engine) does **not** do speaker diarization — that is a separate model. And "high-quality Polish transcription" rules out the small Whisper models for the _live_ path on CPU, so the live and final-quality transcription strategies must differ.

This ADR records the architectural decisions for building this as a **built-in, opt-in Desktop module**.

## Decision

Build "Meeting transcription" as a **built-in Desktop module**, off by default, enabled via a top-level user setting. All non-UI logic lives in `crates/speedwave-runtime/` behind a Cargo feature `audio-transcription`; the Tauri command layer (`desktop/src-tauri/src/transcription_cmd.rs`) is thin; the UI is a new top-level Angular tab. The fourteen sub-decisions:

### 1. Built-in Desktop module, not a plugin

Plugins are containers with no host audio access ([ADR-051](ADR-051-plugin-signature-runtime-verification.md), CLAUDE.md "Plugins" contract). Host audio + microphone capture is privacy-sensitive and must be visibly opt-in and signed by Speedwave. This module follows the existing host-side precedent: a `speedwave-runtime` SSOT layer (like `ContainerRuntime`), thin Tauri commands (like `system_settings_cmd.rs`), and — on macOS — a bundled signed native CLI (like `calendar-cli`, [ADR-049](ADR-049-tcc-sub-identifiers-and-applevents-gate.md)).[^1]

### 2. macOS capture = CoreAudio process taps (macOS 14.4+), not ScreenCaptureKit

macOS provides `AudioHardwareCreateProcessTap` + `AudioHardwareCreateAggregateDevice` (introduced macOS 14.2, usable in practice from 14.4) for capturing audio from a chosen process (Slack, Teams, a browser) or the whole system. Apple's guidance is to use a Core Audio tap rather than ScreenCaptureKit when capturing audio only.[^2][^3] ScreenCaptureKit has known audio-only defects on macOS 15 (`SCStreamErrorDomain -3805`, missing callbacks in audio-only mode).[^4] **Baseline for this feature is macOS 14.4+** — the rest of Speedwave keeps its current floor. Swift Package granularity is `.macOS(.v14)`, so 14.4 is enforced at runtime via `if #available(macOS 14.4, *)`; older macOS gets a clean "macOS 14.4+ required" message and the feature is unavailable there (the Desktop app otherwise works). Reference implementations exist and will be adapted (not reimplemented from scratch): `insidegui/AudioCap` (the tap + aggregate-device setup),[^5] and `AudioTee` (a Swift CLI streaming system audio to stdout as 16 kHz mono in ~200 ms chunks for ASR — essentially this use case).[^6]

### 3. macOS permissions = `NSAudioCaptureUsageDescription` + `NSMicrophoneUsageDescription`; no private TCC API

Process taps require `NSAudioCaptureUsageDescription`; capturing the user's own microphone requires `NSMicrophoneUsageDescription`. Neither requires Screen Recording.[^5] There is **no public API to check audio-recording permission status pre-emptively** — `AudioCap` resorts to a private TCC API for that.[^5] Speedwave's `audio-capture-cli` will **not** use the private API: the system prompts the user at the moment recording starts, which is acceptable (Speedwave ships as a notarized `.dmg`, not a sandboxed App Store app). As with the other native CLIs ([ADR-049](ADR-049-tcc-sub-identifiers-and-applevents-gate.md)), the CLI embeds its own `Info.plist` into the Mach-O (`-sectcreate __TEXT __info_plist`) and uses the sub-identifier `pl.speedwave.desktop.audio-capture`, so TCC binds the permission row to the right identifier and `tccutil reset` works.

### 4. Windows capture = WASAPI loopback; per-process only on build 20348+; system-wide as the universal fallback

Windows offers per-process loopback via `ActivateAudioInterfaceAsync` with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` and `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { TargetProcessId, ProcessLoopbackMode }` (include-tree = "this app and children", exclude-tree = "everything except"). **The minimum is Windows 10 Build 20348** — not the 20H1/19041 build sometimes quoted.[^7][^8] Microsoft publishes an `ApplicationLoopback` C++ sample.[^9] On builds **below 20348, per-process loopback is unavailable** — the feature falls back to system-wide loopback via `AUDCLNT_STREAMFLAGS_LOOPBACK` (available since Windows 7),[^10] and the UI offers only "System-wide audio" with a tooltip explaining the requirement. Implementation goes through the `cpal` crate where it covers loopback;[^11] a thin `windows-sys` shim is used only if `cpal` does not expose per-process loopback (see decision 10). The runtime exposes `capabilities().supports_per_process` so the UI knows whether to offer a process picker.

### 5. Linux capture = PipeWire monitor sources, with PulseAudio `.monitor` fallback; shell out, don't touch ALSA

Linux audio capture depends on the running sound server. PipeWire (current distros) exposes monitor sources per node, recorded with `pw-record`;[^12] PulseAudio (older systems) exposes `<sink>.monitor` sources, recorded with `parec`.[^13] The implementation detects which server is running and **shells out** to `pw-record` / `parec` (KISS — the monitor-source dance through `cpal`/ALSA is fiddly and these CLIs are ubiquitous on the target distros). Per-app capture on PipeWire is straightforward (target a per-app stream node); on PulseAudio it requires moving a sink-input, which is fiddly — spike 0B decides whether per-app ships in v1 on PulseAudio or is PipeWire-only initially.

### 6. Transcription engine = whisper.cpp via `whisper-rs`; backends are compile-time; v1 ships CPU + Metal only

The engine is whisper.cpp (MIT) accessed through the `whisper-rs` crate (so we link `libwhisper` and avoid a sidecar process).[^14][^15] **whisper.cpp's acceleration backends — Metal, CUDA, Vulkan, CPU — are compile-time feature flags, not runtime detection**: the binary is built against a specific backend.[^15] **v1 ships CPU (all platforms) + Metal (macOS)**. CUDA/Vulkan are deferred — they require a separate CI toolchain, separate build artifacts, and likely separate installers or feature-gated downloads; this is a follow-up, not a v1 promise. The runtime's `accel.rs` reports _which backends were compiled into this binary_, not what the host hardware could theoretically support. Rejected: faster-whisper, whisperX (Python + PyTorch — not bundlable as a self-contained app).

### 7. Speaker diarization = sherpa-onnx; labels are explicitly provisional

Whisper does not identify speakers; its `tinydiarize` option only emits `[SPEAKER_TURN]` markers (turn detection, not "who"), which is insufficient.[^16] Diarization is done with sherpa-onnx (Apache-2.0, k2-fsa): speaker segmentation + speaker embedding + clustering, ONNX runtime, zero Python; it can use pyannote segmentation models in ONNX form.[^17][^18] **The exact Rust binding — the official `sherpa-onnx` crate vs the third-party `sherpa-rs` crate — is decided by spike 0A** (the official crate appears more current; the spike confirms or refutes).[^19][^20] **Product-wise, speaker labels are "provisional"**: the live path is delayed and unstable under crosstalk, and the final offline pass re-clusters the whole recording with full context — cluster IDs are not stable across runs. The UI communicates this (a ⚠️ tooltip on speaker chips, a "labels are approximate" footer in the exported markdown, a "speaker labels were refined" note if the final pass changes them). It does not present diarization as certain identification. Rejected: pyannote.audio, whisperX (Python + PyTorch).

### 8. Polish/English strategy = forced language, two tiers; product promise is "best-effort live + higher-quality offline pass"

The UI has an explicit PL/EN toggle; the language is **forced** (`--language pl` / `--language en`), never auto-detected — forced language beats auto-detection on Whisper. Two tiers: the **live** path uses a fast model (`small` on CPU; `large-v3-turbo` only if the binary was compiled with Metal and the host is Apple Silicon — see decision 6); after recording stops, a **higher-quality offline pass** re-transcribes the whole recording with full `large-v3` (no latency pressure; if the user only downloaded `small`, the UI offers to fetch `large-v3` or skip the pass). `large-v3-turbo` is a distilled `large-v3` (decoder reduced from 32 to 4 layers, ~6–8× faster, quality within ~1–2% of `large-v3` for most languages but with an uneven drop on some — e.g. Thai, Cantonese; Polish is generally in the "OK, roughly large-v2 level" group).[^21][^22] **Public Polish WER benchmarks for `large-v3-turbo` are sparse** — recorded as a known risk; `medium` is in the catalog as a middle ground. The product promise is **"local best-effort live transcription + higher-quality offline final pass"**, not "perfect Polish/English". The UI and docs say so.

### 9. Model store = download-on-demand, SHA256-verified, streamed to disk, redirect-allowlisted

Whisper models (75 MiB `tiny` … 2.9 GiB `large-v3`) and the diarization models are **downloaded on demand**, not bundled, into `<data_dir>/models/whisper/` and `<data_dir>/models/diarization/` (directories `0o700`, files `0o600`). Exact URLs, SHA256 hashes, sizes, and licenses are an SSOT const in `speedwave-runtime` (`model_catalog.rs`), mirroring the `NERDCTL_FULL_SHA256_*` pattern in `consts.rs`. The downloader **does not copy `redirect::Policy::none()` from [ADR-041](ADR-041-local-llm-model-discovery.md)** — Hugging Face redirects model downloads to a CDN (and may use signed URLs), so a `none` policy would break it; instead it uses `redirect::Policy::custom` with an **allowlist of redirect hosts** (`huggingface.co` plus the HF CDN hosts — the exact list is discovered and frozen by spike 0C).[^23][^24] Files are **streamed to disk while a SHA256 is computed on the fly** (not buffered in memory — these files are too large), written to a temp file in the same directory, and atomically renamed on success (the `tempdir_in` pattern used for plugin staging); on hash mismatch or interruption the temp file is removed and an error is returned. There is a per-model size cap from the catalog plus a global ceiling with headroom (~5 GiB, not a fixed 3 GiB). Progress events mirror the plugin-install-progress pattern ([ADR-047](ADR-047-plugin-install-progress-events.md)) and carry a `seq` (decision 11). **Model downloads use the network** — the UI says so before the first download. Otherwise hardening follows [ADR-041](ADR-041-local-llm-model-discovery.md) (request timeout; `Content-Type`-bounded where relevant) and reuses `desktop/src-tauri/src/http_util.rs` / `url_validation.rs` rather than re-implementing.

### 10. `unsafe_code = "deny"` interaction

The workspace and the desktop crate both set `unsafe_code = "deny"` (`Cargo.toml`, `desktop/src-tauri/Cargo.toml`). `whisper-rs`, the chosen sherpa crate, `cpal`, `hound`, and `reqwest` expose **safe** Rust APIs (their `unsafe` is internal), so this module writes **zero** `unsafe` and needs no `#[allow(unsafe_code)]`. The only potential exception is a `windows-sys` shim for `ActivateAudioInterfaceAsync` _if_ `cpal` does not cover per-process loopback (decision 4); that shim, if needed, gets the `#[allow(unsafe_code)]`-with-justifying-comment treatment already established at `desktop/src-tauri/src/fs_perms.rs:136`.[^25] All transcription dependencies stay in `speedwave-runtime` behind the `audio-transcription` feature, so the CLI crate stays lean.

### 11. Live-transcript transport = an append-only event stream with `seq` + snapshot recovery (not the JSON-patch protocol, not a plain broadcast)

A plain `tokio::sync::broadcast` would **lose events** if the frontend subscribes after recording has already started. The transport therefore copies the _delivery semantics_ of `MsgStore::history_plus_stream()` ([ADR-043](ADR-043-msgstore-history-plus-stream.md), `subscribe_cmd.rs`): `subscribe_transcript(session_id)` returns **a snapshot of the current session state plus the event name**; every `TranscriptEvent` carries a monotonic `seq`; the Angular reducer is **idempotent** (ignores `seq` ≤ last applied) and on re-subscribe replays from the snapshot. The `TranscriptEvent` enum — `SegmentAppended{seq,segment}`, `SegmentsReplaced{seq,from_index,segments}` (sliding-window re-decode), `SpeakerAssigned{seq,segment_index,speaker}`, `StatusChanged{seq,status}`, `FinalizeProgress{seq,done_ms,total_ms}`, `Finished{seq}` — is far simpler than reusing `patch_emitter.rs` (882 lines) and `MsgStoreRegistry`, because a transcript is append-mostly with coarse "replace last N segments" operations rather than fine-grained RFC 6902 patches; but the _delivery_ (history + live, monotonic seq) is the same proven pattern. The full JSON-patch protocol ([ADR-042](ADR-042-json-patch-stream-protocol.md)) was considered and only its delivery semantics adopted.

### 12. Capture child-process lifecycle mirrors `mcp_os_process.rs`

The OS-CLI-based capture paths (the macOS `audio-capture-cli`; the Linux `pw-record` / `parec` child) reuse the discipline of `desktop/src-tauri/src/mcp_os_process.rs`: `Stdio::piped()`; a PID file written immediately (under `<data_dir>/transcripts/<id>/capture.pid`); `kill_stale_by_pid_file` on respawn; background threads draining **both** stdout and stderr (drain both or a full pipe buffer SIGPIPEs the child); `env_clear()` plus selective re-injection; `write_restricted_file` for any token. The Windows `cpal`-in-process path is a Rust thread, not a child process, so that branch is simpler.

### 13. Opt-in toggle = top-level user config only, off by default, no repo/project override

The enable toggle is a field on the **top-level user config** (`crates/speedwave-runtime/src/config.rs`, ~line 183), default off — **not** on `IntegrationsConfig`, **not** resolvable from a repo `.speedwave.json`. `resolve_project_config` does not read it; it is exposed via a separate getter (`user_config.transcription()`). A repo `.speedwave.json` setting `transcription.enabled = true` is **ignored** (a checked-in repo file must not be able to turn on host audio recording — this is a privacy-sensitive host capability, not project configuration; same spirit as why repo config cannot override `provider`/`base_url` in [ADR-040](ADR-040-remove-litellm-direct-provider-injection.md)/[ADR-041](ADR-041-local-llm-model-discovery.md)). The "Meeting transcription" tab is always visible in the nav but shows an "Enable in Settings →" empty state until the toggle is on (mirroring how the Chat tab shows an inline "auth required" block rather than hiding itself).

### 14. Audio retention + third-party licenses

Recorded audio lives at `<data_dir>/transcripts/<id>/audio.wav` (`0o600`). **Retention policy**: by default the WAV is kept after the final pass (re-transcription may be wanted), but the UI provides (a) "delete transcript" (removes the whole directory), (b) "discard audio, keep transcript" after the final pass (smaller disk footprint; `audio_path → None`; re-transcription then impossible), and (c) a "models use X GB on disk" line. There is **no automatic retention/expiry in v1** — the user deletes manually; this is a deliberate decision, not an oversight. **Licenses** added to `desktop/src-tauri/THIRD-PARTY-LICENSES/` (lowercase-hyphen naming, matching `lima-LICENSE`): `whisper-cpp-LICENSE` (MIT), `sherpa-onnx-LICENSE` (Apache-2.0), `onnxruntime-LICENSE` (MIT), `whisper-models-LICENSE` (the OpenAI Whisper weights are MIT).[^14][^17][^21] **The pyannote segmentation ONNX model's license is checked by spike 0C** — if it is gated / non-redistributable on Hugging Face, Speedwave does not bundle it: it is downloaded on demand from the original source, its license is surfaced in-app, and a note to that effect goes in `THIRD-PARTY-LICENSES/diarization-models-LICENSE`.

## Spike findings

> **To be filled in after spikes 0A, 0B, 0C.** Until then this ADR stays _Proposed_.

### 0A — build/link ML on macOS / Windows / Linux

_Pending._ Records: whether `whisper-rs` + the chosen sherpa crate compile and link on all three OSes in a reproducible CI build; whether onnxruntime is buildable from source via the crate's build script or requires a prebuilt shared library (which would change decision 9's bundling shape — shared `.dylib`/`.so`/`.dll` in `bundle.resources` plus signing, instead of static linking); the CI toolchain required (`cmake`, Metal SDK on the macOS runner, MSVC build tools on Windows); the `cargo build` time impact; whether `unsafe_code = "deny"` passes unchanged; the chosen sherpa crate; observed diarization quality/latency on real Polish audio. **If the build fails on any platform, the affected decision (6, 7, or 9) is revised before Phase 1.**

### 0B — host audio capture on macOS / Windows / Linux

_Pending._ Records: macOS — whether the TCC prompt appears for an ad-hoc-signed CLI with an embedded `__info_plist`, `posix_spawn` TCC behavior, whether taps capture app audio, aggregate-device teardown on `SIGTERM`; Windows — whether `cpal` loopback works out of the box, whether per-process loopback needs build 20348+ (confirmed), the `unsafe` cost, 16 kHz resampling; Linux — PipeWire-vs-PulseAudio detection reliability, whether `pw-record --target <monitor>` yields 16 kHz mono directly, per-app stream-node enumeration, the no-sound-server case. Also: the frozen stdout framing protocol (JSON header + length-prefixed chunks, ~200 ms). **If capture does not work on a platform, that platform's plan is revised (perhaps system-wide-only, perhaps deferred).**

### 0C — model catalog (legal + working download)

_Pending._ Records: the exact URL, SHA256, size, and license for each Whisper model (`tiny`/`small`/`medium`/`large-v3`/`large-v3-turbo`, plus `q5_0` variants) and each sherpa diarization model (segmentation + embedding); the pyannote segmentation model's license verdict (bundle vs download-on-demand-from-source + license-in-UI); the exact list of Hugging Face redirect hosts to allowlist (discovered via `curl -IL`); confirmation that `redirect::Policy::none()` would break the download and that streaming-hash works; whether `Content-Length` is present for progress. The resulting `model_catalog` table is ready to drop in as the SSOT const in Phase 1a. **If a required model is non-redistributable _and_ download-on-demand is also problematic, decision 7 is revised (a different model or a different diarization library).**

## Rejected alternatives

### A. ScreenCaptureKit for macOS audio capture

Rejected in favor of CoreAudio process taps (decision 2): Apple recommends taps for audio-only capture; ScreenCaptureKit additionally requires the heavyweight Screen Recording permission and has known audio-only defects on macOS 15.[^2][^4]

### B. A containerized MCP worker / plugin for transcription

Impossible: containers have no host audio access, and the credential-isolation model has nothing to isolate here — the "credential" is access to the user's microphone and screen audio, which is a host capability ([ADR-051](ADR-051-plugin-signature-runtime-verification.md), security model). Rejected (decision 1).

### C. A BlackHole/Loopback-style virtual audio driver on macOS

Requires the user to install a third-party kernel/DriverKit audio driver and manually route system audio through it — incompatible with "single installable app", not bundlable (kext/DriverKit signing and installation from a `.dmg` is a notarization nightmare), and worse UX than process taps. Rejected; at most a documented "advanced: if you already have BlackHole, point Speedwave at that device" note, not a built-in path.

### D. Python-based transcription/diarization (faster-whisper, whisperX, pyannote.audio)

Best-in-class diarization is pyannote.audio, but it (and whisperX, which wraps it) is Python + PyTorch + large gated models — not bundlable as a self-contained app and contrary to "shell out to existing tools" only in the sense that the "tool" would be a whole Python runtime. sherpa-onnx gives ONNX-only, zero-Python diarization at a quality cost that is acceptable for "provisional speaker labels" (decision 7). Rejected.

### E. CUDA/Vulkan GPU acceleration in v1

whisper.cpp's GPU backends are compile-time, not runtime (decision 6) — shipping CUDA/Vulkan means a separate CI toolchain, separate build artifacts, and likely separate or feature-gated installers. Deferred to a follow-up; v1 ships CPU + Metal. Not "rejected forever", just out of v1 scope (YAGNI).

### F. Reusing `patch_emitter.rs` / the JSON-patch protocol for the live transcript

The 882-line `patch_emitter.rs` plus `MsgStoreRegistry` and the RFC 6902 machinery is overkill for an append-mostly transcript with coarse "replace last N segments" operations. Only the _delivery semantics_ of `MsgStore::history_plus_stream()` (history + live, monotonic seq, idempotent reducer) are adopted; the patch protocol itself is not (decision 11).

## Consequences

### Positive

- A self-contained, opt-in meeting-transcription feature that works on macOS / Windows / Linux, with everything in the SSOT layer (`speedwave-runtime`) and a thin Tauri command surface — consistent with the rest of the codebase.
- **The container threat model is untouched** — no v1 security invariant is relaxed; Claude's container learns nothing about audio; the transcript reaches Claude only through the normal chat path as user-supplied text.
- Audio inference is local — no audio leaves the machine for transcription or diarization.
- The `trait AudioCapture` → `WasapiAudioCapture` / `MacOsAudioCapture` / `LinuxAudioCapture` split mirrors `ContainerRuntime` → `LimaRuntime` / `NerdctlRuntime` / `WslRuntime` (Open/Closed; a new platform is a new impl).
- Heavy lifting is delegated, not reimplemented: transcription = `whisper-rs`, diarization = sherpa-onnx, Linux capture = `pw-record`/`parec`, macOS capture = adapted `AudioCap`/`AudioTee`, Windows capture = `cpal`, downloader = `reqwest` + the existing `http_util` hardening, process lifecycle = `mcp_os_process.rs`, live stream = the `history_plus_stream` delivery pattern.

### Negative

- **This is a genuinely large subsystem** — not a "thin orchestration layer" in the way wrapping `nerdctl exec` is. Mitigations: three risk-proving spikes before any permanent code; every hard piece wraps an existing tool; Phase 1 is split into four PRs; phasing lands working increments (file-input transcription is useful before live capture exists).
- **New attack surface, host-side**: a model downloader making outbound HTTPS (mitigated by the redirect allowlist, streaming hash, size caps, and the ADR-041 hardening it reuses); the microphone and system-audio capture itself (mitigated by opt-in-off-by-default and the OS permission prompts); transcript files and audio recordings on disk (mitigated by `0o600`, the `~/.speedwave/transcripts/` location, the retention controls); on macOS the audio-capture permission, which is powerful (mitigated by the UI being explicit about what is being captured and why). All of this is the residual cost of the feature, accepted.
- **Audio leaves the machine on "Send to Claude"** — the transcript text is sent to whatever LLM provider the user has configured (Anthropic or a local LLM). "Local" is true only for inference; the UI and docs say so explicitly and the "Send to Claude" action has a confirm dialog.
- A new signed native macOS CLI (`audio-capture-cli`) is the single most infrastructure-heavy piece — new Swift package, embedded `Info.plist`, entitlements, universal `lipo` build, a CI matrix entry, a `SIGN_TARGETS` entry, bats tests. Mitigated by it being structurally identical to the four CLIs already in `native/macos/` ([ADR-049](ADR-049-tcc-sub-identifiers-and-applevents-gate.md)).
- macOS 14.4+ is required for this feature; older macOS users see a "macOS 14.4+ required" message (the rest of the app still works). Windows users below build 20348 get system-wide audio only, not per-app capture.
- Speaker diarization is provisional, not certain — live labels are unstable under crosstalk and the final pass may re-cluster. The UI is honest about this; it is not a guarantee.
- Polish transcription quality is best-effort, not perfect — `large-v3-turbo` Polish WER is not well benchmarked publicly; `medium` is the middle ground and the `large-v3` final pass is "as good as Whisper gets".
- `large-v3` is a 2.9 GiB on-demand download; the live path needs only `small` (75 MiB) on CPU or `large-v3-turbo` (~1.5 GiB) on Metal, and `q5_0` quantized variants are smaller, but the disk/network cost is real and the UI is explicit about it.

### Neutral

- "KISS — prefer existing tools over reimplementing" (CLAUDE.md) is honored in the _parts_ (every hard piece wraps a tool) but the _whole_ is a subsystem; this ADR records that as a deliberate, eyes-open trade-off, justified by the feature request and bounded by phasing and spikes.
- The model catalog is an SSOT const like `ANTHROPIC_MODELS` — bumping a model is editing one const; the frontend reads it via a Tauri command and does not hard-code model strings.
- No automatic audio retention in v1 (YAGNI) — the user deletes manually, with an optional "discard audio after the final pass".

## Known Limitations

- DNS rebinding on the model-download host is the same accepted residual risk as for other host-originated URLs ([ADR-041](ADR-041-local-llm-model-discovery.md) §Negative) — except the model-download URLs are not user-supplied (they are the SSOT catalog), which is strictly safer.
- If a Hugging Face CDN host changes (the redirect allowlist is a frozen list), a model download will fail with a clear "model URL changed — report this" error rather than silently following an unknown redirect; the catalog/allowlist is then updated in a patch.
- The live transcript's "replace last N segments" coarseness means the on-screen text can shift slightly as the sliding window re-decodes a tail; the final pass replaces it wholesale anyway.
- On PulseAudio, per-app capture may not ship in v1 (decision 5 / spike 0B) — PipeWire users get it; PulseAudio users may get system-wide only initially.

## Verification

- This ADR is reviewed for the footnote requirement (every factual claim has a source URL) and added to `docs/adr/README.md`.
- Spikes 0A, 0B, 0C each produce findings appended to [Spike findings](#spike-findings); on all three passing, the ADR moves to **Accepted**. On any spike surfacing a blocker, the relevant decision is revised here first.
- Subsequent phases verify the decisions in practice: the runtime layer (`make test-rust`, `make test-transcription`), the Tauri commands (`make test-rust`), the Angular tab (`make test-angular`), the macOS CLI (`make test-swift`), the bundle integrity (`make test-desktop` bats), and the full quality gate (`make check-all`).

## Sources

[^1]: ADR-049 — TCC sub-identifiers and unified AppleEvents permission gate for native macOS CLIs (the embedded-`Info.plist` + sub-identifier + signing pattern this feature's macOS CLI follows): `./ADR-049-tcc-sub-identifiers-and-applevents-gate.md`; ADR-051 — Plugin signature as a runtime invariant (plugins are containers): `./ADR-051-plugin-signature-runtime-verification.md`; Speedwave security model: `../architecture/security.md`; container topology: `../architecture/containers.md`

[^2]: Apple Developer Documentation — "Capturing system audio with Core Audio taps" (`AudioHardwareCreateProcessTap`, `CATapDescription`, `AudioHardwareCreateAggregateDevice`; guidance to use a Core Audio tap rather than ScreenCaptureKit when capturing audio only): <https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps>

[^3]: Apple Developer Forums — "Is it possible to get only audio from ScreenCaptureKit?" / "How can I capture audio samples outside of ScreenCaptureKit?" (Apple engineers pointing to Core Audio taps for audio-only capture): <https://developer.apple.com/forums/thread/718279>; <https://developer.apple.com/forums/thread/756428>

[^4]: pyobjc issue #647 — "Failed to Capture System Audio with ScreenCaptureKit on macOS 15 (`SCStreamErrorDomain -3805` or No Callbacks)": <https://github.com/ronaldoussoren/pyobjc/issues/647>

[^5]: insidegui/AudioCap — sample code for recording system audio on macOS 14.4+ (uses `AudioHardwareCreateProcessTap` + `AudioHardwareCreateAggregateDevice`, `NSAudioCaptureUsageDescription`; notes that the permission _check_ requires a private TCC API and provides a build flag to disable that private-API use): <https://github.com/insidegui/AudioCap>

[^6]: AudioTee — Swift command-line tool streaming macOS system audio to stdout via Core Audio taps (mono, 200 ms chunks, 16 kHz resampling for ASR; requires macOS 14.2+): <https://stronglytyped.uk/articles/audiotee-capture-system-audio-output-macos>; repository: <https://github.com/nsubstance-uk/AudioTee>

[^7]: Microsoft Learn — `ActivateAudioInterfaceAsync` (mmdeviceapi.h): the per-process loopback activation via `AUDIOCLIENT_ACTIVATION_PARAMS` is documented with a minimum of **Windows 10 Build 20348**: <https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-activateaudiointerfaceasync>

[^8]: Microsoft Learn — `AUDIOCLIENT_ACTIVATION_TYPE` and `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS` (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, `TargetProcessId`, `ProcessLoopbackMode` include-tree/exclude-tree): <https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-audioclient_activation_type>; <https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params>

[^9]: Microsoft — "Application Loopback API Capture Sample" (C++ sample demonstrating the process-loopback capture scenario): <https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/>

[^10]: Microsoft Learn — "Loopback Recording" (`AUDCLNT_STREAMFLAGS_LOOPBACK`, available since Windows 7): <https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording>

[^11]: `cpal` — cross-platform audio I/O library for Rust (WASAPI on Windows, including loopback support): <https://docs.rs/cpal/latest/cpal/>; repository: <https://github.com/RustAudio/cpal>

[^12]: PipeWire — `pw-record` (record audio from a target node, including a sink's monitor node): <https://docs.pipewire.org/page_man_pw-cat_1.html>

[^13]: PulseAudio — monitor sources (`<sink_name>.monitor`) and `parec`: <https://www.freedesktop.org/wiki/Software/PulseAudio/Documentation/User/Modules/#module-loopback> ; `parec`/`pacat` man page: <https://manpages.ubuntu.com/manpages/noble/en/man1/pacat.1.html>

[^14]: whisper.cpp — port of OpenAI's Whisper in C/C++ (MIT license; model size table; `whisper-stream` real-time example; word-level timestamps via `-ml 1`; `tinydiarize` `[SPEAKER_TURN]` markers): <https://github.com/ggml-org/whisper.cpp>

[^15]: `whisper-rs` — Rust bindings for whisper.cpp; acceleration backends (`metal`, `cuda`, `vulkan`, OpenBLAS, …) are Cargo feature flags selected at build time: <https://docs.rs/whisper-rs/latest/whisper_rs/>; repository: <https://github.com/tazz4843/whisper-rs>

[^16]: whisper.cpp — `tinydiarize` (emits `[SPEAKER_TURN]` turn-change markers, not speaker identity): <https://github.com/ggml-org/whisper.cpp#speaker-segmentation-via-tinydiarize-experimental> ; tinydiarize project: <https://github.com/akashmjn/tinydiarize>

[^17]: sherpa-onnx — speech-to-text, text-to-speech, speaker diarization, VAD using onnxruntime, no Python required (Apache-2.0): <https://github.com/k2-fsa/sherpa-onnx>; speaker-diarization docs: <https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html>

[^18]: sherpa-onnx — pre-trained speaker-diarization models (segmentation + embedding), including pyannote-segmentation ONNX exports: <https://github.com/k2-fsa/sherpa-onnx/releases> (speaker-segmentation and speaker-embedding model archives); model docs: <https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/models.html>

[^19]: `sherpa-onnx` Rust crate — official Rust API for sherpa-onnx (RAII-owned types over the C API): <https://docs.rs/sherpa-onnx>

[^20]: `sherpa-rs` — third-party Rust bindings to sherpa-onnx (includes speaker-diarization support): <https://github.com/thewh1teagle/sherpa-rs>

[^21]: OpenAI Whisper — model card and supported languages (incl. Polish); the `turbo`/`large-v3-turbo` model is a distilled `large-v3` with the decoder reduced from 32 to 4 layers (~6–8× faster, minor quality loss, uneven across languages — larger drop on Thai/Cantonese): <https://github.com/openai/whisper>; `large-v3-turbo` model card: <https://huggingface.co/openai/whisper-large-v3-turbo>; `turbo` release discussion (per-language degradation): <https://github.com/openai/whisper/discussions/2363>

[^22]: Whisper Large V3 Turbo — analysis of quality vs. speed trade-off ("as good as large-v2 but ~6× faster"; per-language variance): <https://medium.com/@bnjmn_marie/whisper-large-v3-turbo-as-good-as-large-v2-but-6x-faster-97f0803fa933>

[^23]: reqwest — `redirect::Policy` (`Policy::none`, `Policy::limited`, `Policy::custom`): <https://docs.rs/reqwest/latest/reqwest/redirect/enum.Policy.html>; ADR-041 — the host-HTTP hardening (`redirect::Policy::none()`, timeouts, body cap) this downloader reuses _except_ for the redirect policy: `./ADR-041-local-llm-model-discovery.md`

[^24]: Hugging Face Hub — file downloads (`/resolve/<revision>/<path>`) issue HTTP redirects to a CDN (`cdn-lfs*.huggingface.co`); documentation of the download/`hf_hub_download` mechanism and CDN: <https://huggingface.co/docs/huggingface_hub/guides/download>; ggml-org/whisper.cpp model repository (the `resolve/main/ggml-*.bin` URLs): <https://huggingface.co/ggml-org/whisper.cpp>

[^25]: `desktop/src-tauri/src/fs_perms.rs:136` in this repository — the established `#[allow(unsafe_code)]`-with-justifying-comment pattern for a single platform syscall; ADR-013 — mcp-os host-process implementation (the `mcp_os_process.rs` lifecycle pattern this feature's capture children follow): `./ADR-013-mcp-os-host-process.md`; ADR-042 — JSON-patch stream protocol (considered, only delivery semantics adopted): `./ADR-042-json-patch-stream-protocol.md`; ADR-043 — MsgStore history + live stream (the `history_plus_stream` delivery pattern reused): `./ADR-043-msgstore-history-plus-stream.md`; ADR-047 — plugin install progress events (the progress-event pattern the model downloader mirrors): `./ADR-047-plugin-install-progress-events.md`
