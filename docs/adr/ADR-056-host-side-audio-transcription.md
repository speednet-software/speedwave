# ADR-056: Host-Side Audio Capture and Local Meeting Transcription

> **Status:** Accepted — validation spikes 0A/0B/0C passed and the feature is implemented behind the `audio-transcription` Cargo feature.
> **Context:** Record a meeting (Slack / Teams / Meet / any app), transcribe it locally, then optionally hand the transcript to Claude — a host capability that cannot live in Claude's token-free container.
>
> **Amendment:** Speaker diarization was later removed, and the sherpa-onnx dependency it relied on with it — see [ADR-075](ADR-075-remove-speaker-diarization.md). The diarization-specific content of this ADR was pruned in that change; the product ships a clean timestamped transcript with no speaker attribution. All Whisper transcription and audio-capture decisions below still apply.
>
> **Amendment 2:** The per-feature opt-in toggle and the model picker were removed. The tab stays beta-gated (ADR-058) but has no second on/off switch; the feature does nothing until the user presses Record, so the toggle only added friction. Configuration moved entirely into Settings → Meeting transcription, which offers a single auto-selected model — `large-v3` on builds with a GPU backend (the GPU keeps the live window real-time at full quality), `large-v3-turbo` on CPU-only builds — chosen by `accel::best_model_for_this_build()`. `default_language` / `default_live_model` / `keep_audio_after_finalize` are gone: language is picked per-recording, audio is always kept (deleted per-recording from the list). `TranscriptionConfig` and `transcription_enabled()` were dropped from the config.
>
> **Amendment 3:** Per-app (single-process) capture was removed. The macOS process-tap enumeration listed every audio-touching system daemon (`controlcenter`, `CoreSpeech`, `loginwindow`, `GPU`, …), making the picker unusable, and the whole-meeting / system / microphone sources cover the real use case. The `AudioSource::Process` variant, `ProcessSelector`, `CaptureCapabilities.supports_per_process`, the Swift CLI `--list` + `pid:`/`all-except:` sources, the Windows per-process WASAPI loopback (build-20348 gate), and all per-process validation were deleted. The source picker now shows exactly three entries: Whole meeting, System, Microphone.

## Decision

Build "Meeting transcription" as a **built-in Desktop module** behind the beta-features gate (ADR-058). All non-UI logic lives in `crates/speedwave-runtime/src/transcription/` behind a Cargo feature `audio-transcription`; the Tauri command layer is thin; the UI is a new top-level Angular tab. Transcription uses whisper.cpp (via `whisper-rs`); audio inference is fully local — only the final transcript text leaves the machine, and only when the user explicitly sends it to Claude.

The supporting sub-decisions:

- **Not a plugin.** Plugins are containers with no host-audio path (ADR-051). Host audio + microphone is privacy-sensitive and must be visibly opt-in and signed by Speedwave. The module follows the existing host-side precedent (a `speedwave-runtime` SSOT layer, thin Tauri commands, and on macOS a bundled signed native CLI like `calendar-cli`, ADR-049).
- **macOS capture = CoreAudio process taps (macOS 14.4+), not ScreenCaptureKit.** Apple recommends Core Audio taps for audio-only capture; ScreenCaptureKit has audio-only defects on macOS 15. The feature floor is macOS 14.4+ (runtime-gated via `if #available`); older macOS gets a clean "14.4+ required" message and the rest of the app still works.
- **macOS permissions.** Microphone uses the public `AVCaptureDevice.requestAccess(for: .audio)` (shows a prompt). The system-audio consent prompt has no public trigger, so the native CLI uses the private TCC API (`TCCAccessRequest`, service `kTCCServiceAudioCapture`) behind a `dlopen`/`dlsym`-guarded path that degrades gracefully; a System-Settings deep-link plus silence-detection is the fallback if it reports denied.
- **Windows capture = WASAPI loopback** (system-wide). Per-app (single-process) capture was removed — see Amendment 3.
- **Transcription engine** = whisper.cpp (MIT) via `whisper-rs`; acceleration backends are compile-time, so the runtime reports which backends were compiled in. v1 ships CPU (all platforms) + Metal (macOS); CUDA/Vulkan deferred.
- **PL/EN strategy** = forced language (never auto-detected, picked per-recording), with a live pass plus a higher-quality offline re-pass after recording stops. A single model is downloaded per the hardware (see Amendment 2); on GPU builds the live and offline passes share `large-v3`. The promise is "local best-effort live + higher-quality offline final pass", not "perfect Polish/English".
- **Model store** = download-on-demand, SHA256-verified, streamed to disk, into `<data_dir>/models/`. Hugging Face and GitHub `302`-redirect downloads to signed CDN URLs, so the downloader uses a redirect-host allowlist rather than `redirect::Policy::none()`. Otherwise it reuses the ADR-041 host-HTTP hardening.
- **Live-transcript transport** = an append-only event stream with a monotonic `seq` plus snapshot recovery, reusing the _delivery semantics_ of `MsgStore::history_plus_stream()` (ADR-043) — not the full JSON-patch protocol (ADR-042).
- **Mixed capture (system loopback + microphone) is the product default** — both streams are summed to one 16 kHz mono stream before the engine sees them, so the transcription driver is platform-agnostic.
- **No per-feature toggle** (Amendment 2). Access is governed by the beta gate (ADR-058); a checked-in repo `.speedwave.json` was never able to enable host-audio recording and still cannot (it carries no transcription field).
- **Audio retention** = WAV kept until the user deletes the recording. A single "delete" per recording removes the whole session (audio + transcript); no separate discard-audio control, no automatic expiry (YAGNI).

## Why

- The container threat model is untouched: Claude's container learns nothing about audio; the transcript reaches Claude only through the normal chat path as user-supplied text.
- Audio inference is local — no audio leaves the machine for transcription.
- Heavy lifting is delegated, not reimplemented: transcription = `whisper-rs`, Windows capture = `cpal`, downloader = `reqwest` + the existing host-HTTP hardening, child-process lifecycle = the `mcp_os_process.rs` discipline.
- The `AudioCapture` trait split mirrors the `ContainerRuntime` → `LimaRuntime`/`WslRuntime` shape (Open/Closed: a new platform is a new impl). Originally scoped to also include Linux; Linux was dropped per ADR-059.

## Where it lives in code

- **Runtime SSOT (feature-gated)** — `crates/speedwave-runtime/src/transcription/` (`mod.rs`, `audio.rs`, `audio_macos.rs`, `audio_windows.rs`, `mix.rs`, `transcriber.rs`, `transcript_driver.rs`, `transcript_store.rs`, `transcript.rs`).
- **Compiled backend reporting + model selection** — `crates/speedwave-runtime/src/transcription/accel.rs` (`compiled_backends()`, `recommended_live_model()`, `best_model_for_this_build()`).
- **Model catalog SSOT** — `crates/speedwave-runtime/src/transcription/model_catalog.rs` (the Whisper GGML model entries; see [ADR-075](ADR-075-remove-speaker-diarization.md) for the removal of the former speaker-embedding/segmentation entries).
- **Download/verify** — `crates/speedwave-runtime/src/transcription/model_store.rs` (streamed download, on-the-fly SHA256, atomic rename, redirect-host allowlist).
- **Settings UI** — `desktop/src/src/app/settings/transcription-section/` (acceleration label + single download/remove control, driven by the `recommended_transcription_model` command).
- **Feature wiring** — `crates/speedwave-runtime/Cargo.toml` (`audio-transcription` feature) and `desktop/src-tauri/Cargo.toml` (Desktop enables it).
- **Tauri command layer** — `desktop/src-tauri/src/transcription_cmd.rs`.
- **macOS capture CLI** — `native/macos/audio-capture/` (embedded `Info.plist` with `NSAudioCaptureUsageDescription` + `NSMicrophoneUsageDescription` via the `-sectcreate __TEXT __info_plist` linker flag). It is signed by `scripts/sign-bundled-binaries.sh`, which calls `codesign --sign` _without_ an explicit `--identifier` — the signing identifier comes from the embedded `CFBundleIdentifier`, and the script then verifies that identifier equals `pl.speedwave.desktop.audio-capture` (so TCC binds the row to the right identifier, per ADR-049). Bundle membership is the `tauri.macos.conf.json` ↔ `sign-bundled-binaries.sh` SSOT-alignment pair.

## Rejected alternatives

- **ScreenCaptureKit for macOS audio** — has a public consent API but requires the heavyweight Screen Recording permission and has audio-only defects on macOS 15; Core Audio taps were chosen instead.
- **A containerized MCP worker / plugin** — impossible: containers have no host-audio path, and the "credential" here is host device access, not an isolatable service token.
- **A BlackHole/Loopback virtual audio driver on macOS** — needs a third-party kext/DriverKit install; incompatible with "single installable app" and a notarization nightmare. At most a documented "advanced" note.
- **CUDA/Vulkan GPU acceleration in v1** — compile-time backends mean separate CI toolchains and build artifacts; deferred (YAGNI), not rejected forever.
- **Reusing the JSON-patch protocol (ADR-042) for the live transcript** — overkill for an append-mostly transcript with coarse "replace last N segments" operations; only the history-plus-live delivery semantics were adopted.

## Known limitations

- macOS depends on a private TCC API for the system-audio consent prompt; it is `dlopen`-guarded and degrades to a manual System-Settings path if the symbol ever disappears.
- Polish transcription quality is bounded by Whisper itself (the ~25–30% conversational-PL WER floor is industry-wide), not by this integration; the UI carries an honest disclaimer.
- `large-v3` is a multi-gigabyte on-demand download; the UI is explicit about disk/network cost before the first download.
- The Whisper GGML weights are SHA256-pinned and served over HTTPS from an allowlisted host; there is no independent published audit that the converted files are bit-identical to OpenAI's checkpoints — a build-from-source-in-CI conversion is a possible follow-up, not a v1 requirement.
