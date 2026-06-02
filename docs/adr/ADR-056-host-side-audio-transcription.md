# ADR-056: Host-Side Audio Capture and Local Meeting Transcription

> **Status:** Accepted — validation spikes 0A/0B/0C passed and the feature is implemented behind the `audio-transcription` Cargo feature.
> **Context:** Record a meeting (Slack / Teams / Meet / any app), transcribe it locally with speaker labels, then optionally hand the transcript to Claude — a host capability that cannot live in Claude's token-free container.

## Decision

Build "Meeting transcription" as a **built-in, opt-in Desktop module**, off by default, enabled only via a top-level user setting. All non-UI logic lives in `crates/speedwave-runtime/src/transcription/` behind a Cargo feature `audio-transcription`; the Tauri command layer is thin; the UI is a new top-level Angular tab. Transcription uses whisper.cpp (via `whisper-rs`), diarization uses sherpa-onnx; audio inference is fully local — only the final transcript text leaves the machine, and only when the user explicitly sends it to Claude.

The supporting sub-decisions:

- **Not a plugin.** Plugins are containers with no host-audio path (ADR-051). Host audio + microphone is privacy-sensitive and must be visibly opt-in and signed by Speedwave. The module follows the existing host-side precedent (a `speedwave-runtime` SSOT layer, thin Tauri commands, and on macOS a bundled signed native CLI like `calendar-cli`, ADR-049).
- **macOS capture = CoreAudio process taps (macOS 14.4+), not ScreenCaptureKit.** Apple recommends Core Audio taps for audio-only capture; ScreenCaptureKit has audio-only defects on macOS 15. The feature floor is macOS 14.4+ (runtime-gated via `if #available`); older macOS gets a clean "14.4+ required" message and the rest of the app still works.
- **macOS permissions.** Microphone uses the public `AVCaptureDevice.requestAccess(for: .audio)` (shows a prompt). The system-audio consent prompt has no public trigger, so the native CLI uses the private TCC API (`TCCAccessRequest`, service `kTCCServiceAudioCapture`) behind a `dlopen`/`dlsym`-guarded path that degrades gracefully; a System-Settings deep-link plus silence-detection is the fallback if it reports denied.
- **Windows capture = WASAPI loopback.** Per-process loopback on build 20348+; system-wide loopback as the universal fallback on older builds, with the UI hiding the process picker accordingly.
- **Transcription engine** = whisper.cpp (MIT) via `whisper-rs`; acceleration backends are compile-time, so the runtime reports which backends were compiled in. v1 ships CPU (all platforms) + Metal (macOS); CUDA/Vulkan deferred.
- **Diarization** = sherpa-onnx (Apache-2.0, official Rust crate). Speaker labels are explicitly **provisional** — unstable under crosstalk, re-clustered in the offline pass; the UI never presents them as certain identification.
- **PL/EN strategy** = forced language (never auto-detected), two tiers: a fast live model plus a higher-quality `large-v3` offline re-pass after recording stops. The promise is "local best-effort live + higher-quality offline final pass", not "perfect Polish/English".
- **Model store** = download-on-demand, SHA256-verified, streamed to disk, into `<data_dir>/models/`. Hugging Face and GitHub `302`-redirect downloads to signed CDN URLs, so the downloader uses a redirect-host allowlist rather than `redirect::Policy::none()`. Otherwise it reuses the ADR-041 host-HTTP hardening.
- **Live-transcript transport** = an append-only event stream with a monotonic `seq` plus snapshot recovery, reusing the _delivery semantics_ of `MsgStore::history_plus_stream()` (ADR-043) — not the full JSON-patch protocol (ADR-042).
- **Mixed capture (system loopback + microphone) is the product default** — both streams are summed to one 16 kHz mono stream before the engine sees them, so the transcription driver is platform-agnostic.
- **Opt-in toggle** = a field on the top-level user config only, default off, **not** resolvable from a repo `.speedwave.json` (same spirit as why repo config cannot override `provider`/`base_url` in ADR-040/ADR-041).
- **Audio retention** = WAV kept by default with manual "delete transcript" / "discard audio" controls; no automatic expiry in v1 (YAGNI).

## Why

- The container threat model is untouched: Claude's container learns nothing about audio; the transcript reaches Claude only through the normal chat path as user-supplied text.
- Audio inference is local — no audio leaves the machine for transcription or diarization.
- Heavy lifting is delegated, not reimplemented: transcription = `whisper-rs`, diarization = sherpa-onnx, Windows capture = `cpal`, downloader = `reqwest` + the existing host-HTTP hardening, child-process lifecycle = the `mcp_os_process.rs` discipline.
- The `AudioCapture` trait split mirrors the `ContainerRuntime` → `LimaRuntime`/`WslRuntime` shape (Open/Closed: a new platform is a new impl). Originally scoped to also include Linux; Linux was dropped per ADR-059.

## Where it lives in code

- **Runtime SSOT (feature-gated)** — `crates/speedwave-runtime/src/transcription/` (`mod.rs`, `audio.rs`, `audio_macos.rs`, `audio_windows.rs`, `mix.rs`, `transcriber.rs`, `diarizer.rs`, `transcript_driver.rs`, `transcript_store.rs`, `transcript.rs`).
- **Compiled backend reporting** — `crates/speedwave-runtime/src/transcription/accel.rs` (`compiled_backends()`, `recommended_live_model()`).
- **Model catalog SSOT** — `crates/speedwave-runtime/src/transcription/model_catalog.rs`; the default speaker-embedding model is `3dspeaker_speech_campplus_sv_en_voxceleb_16k` (Apache-2.0, 29,596,978 bytes ≈ 29.6 MiB), with `nemo_en_titanet_small` (CC-BY-4.0, ≈ 40 MiB) kept as a non-default fallback. The segmentation model is k2-fsa's `sherpa-onnx-pyannote-segmentation-3-0` (MIT, ≈ 7 MiB).
- **Download/verify** — `crates/speedwave-runtime/src/transcription/model_store.rs` (streamed download, on-the-fly SHA256, atomic rename, redirect-host allowlist).
- **Opt-in config** — `crates/speedwave-runtime/src/config.rs` (top-level `TranscriptionConfig`, read via `transcription_enabled()`; not resolved from repo config).
- **Feature wiring** — `crates/speedwave-runtime/Cargo.toml` (`audio-transcription` feature) and `desktop/src-tauri/Cargo.toml` (Desktop enables it).
- **Tauri command layer** — `desktop/src-tauri/src/transcription_cmd.rs`.
- **macOS capture CLI** — `native/macos/audio-capture/` (embedded `Info.plist` with `NSAudioCaptureUsageDescription` + `NSMicrophoneUsageDescription` via the `-sectcreate __TEXT __info_plist` linker flag). It is signed by `scripts/sign-bundled-binaries.sh`, which calls `codesign --sign` _without_ an explicit `--identifier` — the signing identifier comes from the embedded `CFBundleIdentifier`, and the script then verifies that identifier equals `pl.speedwave.desktop.audio-capture` (so TCC binds the row to the right identifier, per ADR-049). Bundle membership is the `tauri.macos.conf.json` ↔ `sign-bundled-binaries.sh` SSOT-alignment pair.

## Rejected alternatives

- **ScreenCaptureKit for macOS audio** — has a public consent API but requires the heavyweight Screen Recording permission and has audio-only defects on macOS 15; Core Audio taps were chosen instead.
- **A containerized MCP worker / plugin** — impossible: containers have no host-audio path, and the "credential" here is host device access, not an isolatable service token.
- **A BlackHole/Loopback virtual audio driver on macOS** — needs a third-party kext/DriverKit install; incompatible with "single installable app" and a notarization nightmare. At most a documented "advanced" note.
- **Python diarization (faster-whisper, whisperX, pyannote.audio)** — Python + PyTorch + large gated models, not bundlable as a self-contained app. sherpa-onnx gives ONNX-only, zero-Python diarization at an acceptable "provisional labels" quality. (The pyannote _model_ is used as an MIT-licensed ONNX conversion; the pyannote _Python library_ is not.)
- **`sherpa-onnx-reverb-diarization-v1`** — non-commercial licence, unusable in a commercial product.
- **The third-party `sherpa-rs` crate** — the official `sherpa-onnx` crate is more current and exposes the full diarization pipeline directly with a cleaner default feature set.
- **CUDA/Vulkan GPU acceleration in v1** — compile-time backends mean separate CI toolchains and build artifacts; deferred (YAGNI), not rejected forever.
- **Reusing the JSON-patch protocol (ADR-042) for the live transcript** — overkill for an append-mostly transcript with coarse "replace last N segments" operations; only the history-plus-live delivery semantics were adopted.

## Known limitations

- macOS depends on a private TCC API for the system-audio consent prompt; it is `dlopen`-guarded and degrades to a manual System-Settings path if the symbol ever disappears.
- Polish transcription quality is bounded by Whisper itself (the ~25–30% conversational-PL WER floor is industry-wide), not by this integration; the UI carries an honest disclaimer.
- Speaker labels are provisional, not certain identification.
- `large-v3` is a multi-gigabyte on-demand download; the UI is explicit about disk/network cost before the first download.
- The Whisper GGML weights are SHA256-pinned and served over HTTPS from an allowlisted host; there is no independent published audit that the converted files are bit-identical to OpenAI's checkpoints — a build-from-source-in-CI conversion is a possible follow-up, not a v1 requirement.
