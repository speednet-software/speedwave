# ADR-075: Remove Speaker Diarization — Clean Timestamped Transcript

**Status:** Accepted

**Date:** 2026-06-19

> Extends and amends [ADR-056](ADR-056-host-side-audio-transcription.md) (host-side audio capture + local transcription) and **supersedes** [ADR-061](ADR-061-windows-crt-runtime-alignment.md) (Windows CRT runtime alignment).

## Context

[ADR-056](ADR-056-host-side-audio-transcription.md) shipped meeting transcription with two distinct capabilities: speech-to-text (whisper.cpp via `whisper-rs`) and acoustic speaker diarization ("who spoke when") via the `sherpa-onnx` crate. Diarization was always the weaker half. ADR-056 itself flagged the speaker labels as **provisional** — re-clustered on the offline pass, never presented as certain identification — and the UI surfaced each label with a ⚠ marker.

In practice the labels were unreliable in exactly the scenario the feature targets:

- **Crosstalk** — overlapping speech confuses clustering; segments get mislabelled or split.
- **The "laptop-in-a-room" case** — when remote participants come through the speakers and are re-captured by the microphone alongside the local loopback, the same remote voice arrives on two acoustic paths with no acoustic-echo cancellation (AEC). Diarization then double-counts a single remote speaker as two clusters.

Diarization also carried disproportionate engineering weight: a second model set (segmentation + speaker-embedding ONNX models) downloaded and stored separately, a relabel-then-re-cluster flow that could lose a user's manual rename when the offline pass shifted cluster boundaries, and the whole `sherpa-onnx` native-dependency chain — which on Windows forced the CRT-link-mode workaround that ADR-061 exists solely to solve.

## Decision

**Remove speaker diarization from meeting transcription entirely.** The product ships a clean, timestamped transcript with no "who spoke" attribution. If speaker attribution is needed, it is left to the consumer of the transcript — for example, Claude can infer turns when it summarizes the transcript text, using the timestamps and conversational content rather than unreliable acoustic clustering.

This removes a whole axis of complexity at once: the relabel-loss bug, the echo/AEC problem, and the second model set all disappear.

### Consequence — full sherpa-onnx removal

`sherpa-onnx` was used **only** for diarization. With diarization gone it has no remaining consumer, so the entire support chain is removed:

- the `sherpa-onnx` crate dependency in `crates/speedwave-runtime/Cargo.toml`;
- the `.sherpa-onnx-version` SSOT file and its CLAUDE.md SSOT-alignment chain;
- the MD-Release CRT-alignment prefetch scripts (`scripts/lib/fetch-sherpa-onnx-md.sh`, `scripts/dev-fetch-sherpa-cache.sh`) and the `download-sherpa-onnx` CI composite action;
- the `tar` and `bzip2` crate dependencies, which existed only to unpack the sherpa diarization `.tar.bz2` archives;
- the bundled `sherpa-onnx-LICENSE` (Apache-2.0[^1]) and `onnxruntime-LICENSE` (MIT[^2]) files, and the speaker-diarization-models section of `transcription-models-LICENSE`;
- the `diarizer.rs` runtime module, the Tauri `relabel_speaker` command, and the `expected_speakers` parameter.

Because sherpa-onnx was the only library that forced the `/MT`-vs-`/MD` C-runtime mismatch on Windows MSVC builds,[^3] removing it **supersedes** [ADR-061](ADR-061-windows-crt-runtime-alignment.md): with no `/MT` prebuilt in the link, the remaining native dependency (`whisper-rs`/`whisper-rs-sys`, which builds whisper.cpp from source via cmake-rs and follows the platform-default dynamic CRT) needs no alignment workaround. The prefetch step and `SHERPA_ONNX_LIB_DIR` override are gone.

### What stays

- **whisper.cpp / `whisper-rs`** — speech-to-text is the core of the feature and is unaffected.[^4]
- **`cpal`** — Windows WASAPI loopback capture; unrelated to diarization.[^5]
- All audio-capture, permission, model-download, and live-transcript-transport decisions from ADR-056.

## Consequences

- **Simpler product surface.** No speaker chips, no rename UI, no provisional-label disclaimer, no diarization model downloads. The model manager lists Whisper GGML models only.
- **Smaller dependency and bundle footprint.** Two native libraries (`sherpa-onnx`, plus the `onnxruntime` it pulled in) and two archive-unpacking crates (`tar`, `bzip2`) leave the tree.
- **Windows builds simplify.** The CRT-alignment prefetch is removed from every Windows build path; ADR-061's failure mode can no longer occur.
- **Backward compatibility.** Existing `transcript.json` files written by the previous version may carry `speaker`, `speaker_names`, or `expected_speakers` fields. These still load: serde ignores unknown fields on deserialization,[^6] so an old transcript opens as a plain timestamped transcript with the stale speaker data silently dropped. No migration is required.
- **No "who spoke" in-product.** Users who relied on the (provisional) labels lose them. This is an accepted trade — the labels were explicitly unreliable, and Claude can reconstruct turns from the transcript when asked.

## Alternatives considered

- **Keep diarization but add acoustic-echo cancellation.** AEC would address the laptop-in-a-room double-counting but not crosstalk, and it adds another signal-processing stage and tuning surface. The labels would remain provisional; the complexity-vs-value balance does not justify it.
- **Swap sherpa-onnx for a different diarization engine.** Any acoustic diarizer faces the same crosstalk/echo limits and re-introduces a second model set and native dependency. The problem is acoustic diarization itself, not the specific library.
- **Defer attribution to the LLM but still ship sherpa as a hint.** Keeping sherpa "just for a hint" retains the entire dependency chain and the Windows CRT workaround for marginal value. Rejected on KISS/YAGNI grounds.

[^1]: https://github.com/k2-fsa/sherpa-onnx - `sherpa-onnx`, Apache-2.0-licensed, was the diarization engine; the removed `sherpa-onnx-LICENSE` bundled its license text.

[^2]: https://github.com/microsoft/onnxruntime/blob/main/LICENSE - ONNX Runtime, MIT-licensed, was pulled in as a `sherpa-onnx` dependency; the removed `onnxruntime-LICENSE` bundled its license text.

[^3]: https://learn.microsoft.com/en-us/cpp/error-messages/tool-errors/linker-tools-error-lnk2038 - Microsoft Learn: LNK2038 "mismatch detected for 'RuntimeLibrary'", the link error produced by mixing `/MT` and `/MD` C-runtime objects (the failure ADR-061 worked around).

[^4]: https://github.com/tazz4843/whisper-rs - `whisper-rs`, MIT-licensed Rust bindings for whisper.cpp; retained as the transcription engine.

[^5]: https://github.com/RustAudio/cpal - `cpal`, cross-platform audio I/O library (dual-licensed Apache-2.0 OR MIT); retained for Windows WASAPI loopback capture.

[^6]: https://serde.rs/container-attrs.html#deny_unknown_fields - serde container attributes: by default unknown fields are ignored during deserialization (only `#[serde(deny_unknown_fields)]` rejects them), so older transcripts with `speaker`/`speaker_names`/`expected_speakers` still deserialize.
