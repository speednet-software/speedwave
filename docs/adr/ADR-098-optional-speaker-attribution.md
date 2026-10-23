# ADR-098: Optional Speaker Attribution with Nemotron-3 Diarization

> **Status:** Accepted
> **Date:** 2026-10-19
> **Amends:** [ADR-075](ADR-075-remove-speaker-diarization.md) (removal of speaker diarization). Builds on [ADR-056](ADR-056-host-side-audio-transcription.md), [ADR-085](ADR-085-windows-vulkan-transcription.md) and [ADR-093](ADR-093-portable-ggml-cpu-baseline.md).

## Context

ADR-075 removed speaker diarization for three reasons: crosstalk confused the clustering, a remote voice that reached the microphone through the laptop speakers was counted as a second speaker, and the sherpa-onnx dependency chain (a second model set, onnxruntime and the Windows CRT workaround of ADR-061) cost more than the labels were worth.

Two things changed since then:

- Paired captures record the meeting audio (`System`) and the microphone (`Mic`) on separate channels (ADR-056 Amendment 9), so diarization can run on the meeting channel alone. The echo case of ADR-075 does not reach it: whatever the microphone picks up stays labelled "You".
- NVIDIA released Nemotron-3 Diarization, an end-to-end model that predicts speaker activity per 10 ms frame for up to eight speakers from 16 kHz mono audio, under OpenMDW-1.1, which allows use and redistribution without a field-of-use limit[^1][^2]. A draft pull request to whisper.cpp adds an inference implementation on ggml, the library Speedwave already links for Whisper[^3].

SPEED-727 measured it in three rounds against sherpa-onnx with the ERes2NetV2 embedding, the only alternative that fits the licence and dependency constraints (round 3 on 2026-10-16, Jira SPEED-727). The decision set was 8 AMI test meetings drawn with a fixed seed, the first 900 s of each, scored by the share of Whisper segments given the right speaker[^4][^5]. Nemotron reached 82.8% (95% CI 78.1 to 86.1), ERes2NetV2 with a tuned threshold 78.5%; Nemotron won 6 of 8 meetings with one tie. On Polish synthetic meetings built from unseen Multilingual LibriSpeech speakers it scored 97.8 to 100% against 76 to 83%[^6]. A quiet participant (3 to 5 utterances) was given to someone else in 1 of 16 utterances against 6 of 16. On two real Speedwave recordings without a reference it found 3 and 2 speakers, the numbers the person who recorded them gave, with no hint. On an Apple M4 Pro it ran at a real-time factor of 0.024 on Metal and 0.138 to 0.156 on the CPU, with a peak of 161 to 261 MB of memory. VoxConverse was kept out of the decision because the model card lists its dev and test sets among the training data[^1][^7].

The same model run through NeMo-Speech.cpp with its `v3-offline` preset, which keeps the streaming state machine but feeds it 21 s chunks instead of 1.04 s ones (the preset does not switch to full attention, which the model's position table limits to about 6.6 minutes of audio)[^16][^17], scored 82.96% on AMI-8 (+0.2 pp, 95% CI −0.2 to +0.7), found 3 speakers instead of 4 on the `syn-3` synthetic meeting and the same counts on both Speedwave recordings. The vendored code with that geometry scored 82.83% on AMI-8, at most 0.48 pp from the NeMo-Speech.cpp run on any meeting, found 3 and 2 speakers on the Speedwave recordings and 100% on `syn-3`. On a 45-minute Speedwave recording with four people in the meeting audio, judged from the content without a reference, the low-latency geometry spread one participant over three labels and the `v3-offline` geometry over two. On the same Apple M4 Pro the vendored code ran at a real-time factor of 0.0044 on Metal and 0.028 on the CPU, with a peak of 529 MB of memory on the CPU for that recording.

Telling the number of speakers in advance improved the AMI score by 0.1 pp, and merging small clusters made the quiet participant disappear in 16 of 16 utterances, so neither is part of the decision.

## Decision

1. **Engine.** Speedwave copies the diarization code of whisper.cpp PR #4095 (commit `1cd623724fd5b4c38e45dab36346b2352fd78bec`) into `crates/speedwave-runtime/native/whisper-diarization/` and compiles it with `cc` against the ggml headers of whisper.cpp 1.8.3[^18], the version whisper-rs-sys 0.15.0 builds and links[^19] (`build.rs`). No fork of whisper-rs-sys and no bump of whisper.cpp. `native/whisper-diarization/UPSTREAM` lists the source commit and every local change; `build.rs` refuses to build when whisper-rs-sys reports a different whisper.cpp version than the vendored headers. The copy carries no comments (engineering rules); `UPSTREAM` describes the pass that removed them, so a diff against the source stays possible. The copy never calls ggml's dynamic backend loader, which searches the executable's directory and the working directory for backend libraries and loads every match[^20] (local change 7), its chunk loop reads the offline pass's cancel flag through a ggml abort callback (local change 8), and its backend choice takes an integrated GPU as whisper.cpp 1.8.3 does, where the PR code takes only a discrete one[^21][^24] (local change 9).
2. **Model.** One model, `transcription/model_catalog.rs::DIARIZATION_MODEL`: `Nemotron-3-Diarization.q8_0.gguf`, 107 012 128 bytes, SHA256-pinned, downloaded on demand from Hugging Face through the existing model store and redirect allowlist[^8]. No model choice in the UI. The upstream default segmentation parameters (`whisper_diar_default_params`) stay, including the two activation thresholds, 0.641 and 0.561[^24]; `transcription/diarizer.rs` passes `whisper_diar_default_params()` unchanged. On the vendored build, scored as in round 3, the pair 0.55/0.47 moved the AMI-8 mean from 82.83% to 83.14% and VoxConverse from 93.87% to 93.68%. A wider sweep of start/stop pairs down to 0.4/0.3, run on the PR code with a newer ggml and scored by the product rule alone (the share of segments whose single largest-overlap turn maps to the right speaker), moved AMI-8 between 83.6% and 84.1% and lowered VoxConverse from 93.1% to 91.9%; the two scorings are not comparable with each other. The lower pairs labelled the gaps of 6 to 19 s that the defaults leave without a turn, but did not stop one person from getting two labels, so the upstream values stay; no cluster merging, no speaker-count field. The streaming geometry is the one of NeMo-Speech.cpp's `v3-offline` preset (speaker cache 264, no FIFO, chunks of 264 frames of 80 ms, cache update period 188, one frame of left and right context)[^16] instead of the low-latency default of the PR (FIFO 80, chunks of 13 frames, update period 40, no left context)[^24]; `native/whisper-diarization/UPSTREAM` lists it as local change 6.
3. **Scope.** Optional and off by default. It runs only in the offline pass (after Stop and on "Transcribe again"), only on the `System` channel of a paired capture. Microphone segments stay "You"; a mono recording, or one in which Whisper found no speech on the `System` channel, is never diarized, so the model is not loaded for it. No embeddings or voice profiles are kept on disk.
4. **Setting.** A global Settings switch ("Tell speakers apart in the meeting audio", localStorage), read when an offline pass starts and passed to `stop_transcription` and `transcribe_transcript` as `speaker_mode`. The session records the model key and the time diarization took (`ModelsUsed.diarization`, `TranscriptSession.diarization_secs`); a pass without the mode clears both.
5. **Labels.** `Speaker 1..N` by first appearance in time, on `Segment.speaker_id`. Each meeting segment gets the speaker whose turn overlaps it most. No names, no renaming.
6. **Failure.** A missing model or a model that does not load or fails to run leaves the transcript complete without labels and raises `speaker_model_missing` or `speaker_attribution_failed`; the session still ends `Done`.
7. **Acceptance.** Mean segment accuracy of at least 80% on AMI-8, and a build that reproduces the `v3-offline` run of round 3: the AMI-8 mean within 1 pp of 82.96% and every meeting within 2 pp, 3 and 2 speakers on the two Speedwave recordings, and 100% on the `syn-3` synthetic meeting. Both are met (82.83%, at most 0.48 pp per meeting). Speedwave's own recordings are a check, not a criterion: the person who recorded the 2-speaker one scored it blind, segment by segment, and gave this build 98.5%, the round 3 run of the PR code 99.2% and ERes2NetV2 70.5%.
8. **Eight speakers.** Larger meetings get merged labels; accepted as a known limit.

## Why

- **ADR-075, point by point.** The echo case is gone because only the meeting channel is diarized. The dependency weight is gone: no ONNX runtime, no second native library, no CRT workaround; the new code is two C++ files on the ggml already in the build. Crosstalk remains a limit, but the model is trained on overlapping speech and every evaluation in its card includes it[^1].
- **Vendoring instead of a fork.** Of the ggml and gguf functions the PR code calls, the ggml of whisper.cpp 1.8.3 lacks only one (`gguf_get_tensor_ne`)[^22][^23], which a local change replaces with the tensor shape from a no-alloc ggml context of the file. A fork of whisper-rs-sys would move Whisper to an unreleased whisper.cpp as well and need a transcription regression test; vendoring changes nothing for Whisper.
- **Offline geometry.** Diarization runs after Stop on the whole recording, so the 1 s latency of the streaming default buys nothing. Longer chunks give the model 21 s of new audio per step next to its speaker cache instead of about 1 s, which round 3 measured as equal on AMI and better at counting speakers on `syn-3`.
- **Off by default.** It adds time after each recording and a 102 MiB download, and its labels are numbers, not people.

## Rejected alternatives

- **sherpa-onnx with ERes2NetV2.** Lost by 4 to 8 pp on AMI and by about 18 pp on unseen Polish speakers in round 3, and brings back the dependency chain ADR-075 removed[^9].
- **pyannote community-1, directly or through the Rust `speakrs` crate.** CC-BY-4.0 behind a gated download[^10][^11]; it scored a DER of 30.61% against 14.72% for Nemotron on the Voice Arena benchmark of 139 English sessions[^12]. `speakrs` lists CoreML, CPU, CUDA and MIGraphX back ends and no Windows GPU path[^11].
- **DiariZen.** Second on the same benchmark, but its weights are CC BY-NC 4.0[^13].
- **Reverb diarization.** Weights under a custom licence behind an access form[^14].
- **WhisperX.** A Python tool built on pyannote; Speedwave ships no Python runtime[^15].
- **Waiting for the PR to land in a whisper-rs-sys release.** The PR is a draft with no date[^3]. The vendored copy is removed when a release carries it.

## Known limitations

- Up to eight speakers in the meeting audio.
- People talking over each other and very short replies can get the wrong label.
- One person can get two labels and one label can cover two people. On the 45-minute recording above one participant kept two labels.
- Labels depend on the hardware: on that recording Metal and the CPU gave the same label to 95.1% of the segments.
- Memory grows with the recording: the vendored code keeps the whole meeting channel as 32-bit samples, about 0.23 GB per hour. On the CPU of an Apple M4 Pro the `diarize` example took 151 s for a 2-hour recording (a real-time factor of 0.021) with a peak of 1.1 GB, and 1.56 GB for 3 hours; the diarization itself held about 0.6 GB of that at 2 hours, the rest is the WAV reader keeping two copies of the audio for a moment (SPEED-818 removed that second copy and reads the meeting channel only after Whisper is released; the figures above predate it). The 45-minute recording above peaked at 529 MB.
- "Transcribe again" can number the speakers differently.
- "Later" during diarization takes effect at the next chunk boundary, within 21 seconds of audio: about a tenth of a second on Metal and under a second on the CPU of an Apple M4 Pro at the measured real-time factors.
- Windows was measured on one x86_64 laptop whose Vulkan device is its integrated GPU. On the CPU with 8 threads: 6.3 s for 142.6 s of meeting audio (a real-time factor of 0.044, model load included), 2 speakers found and no segment left unlabelled; that run fell back to the CPU because the vendored code did not take an integrated GPU as a GPU device, which local change 9 fixed. A run after the fix picked Vulkan0 and labelled 4 speakers from 39 turns in 24.4 s on a longer recording; whether the integrated GPU beats the CPU for this model was not measured, nor was a long recording, so the Settings text gives no time on Windows.
- The microphone can pick up the meeting audio through the speakers; such a fragment is transcribed on the `Mic` channel as "You" (2.6 s at the start of that 142.6 s recording). Diarization never touches the `Mic` channel, so it cannot correct it.
- The vendored code is a copy of a draft. A whisper-rs-sys bump fails the build until the ggml headers and `UPSTREAM` are updated. When whisper-rs-sys ships whisper.cpp with diarization, the duplicate `whisper_diar_*` symbols fail the link, which is the signal to delete the copy; the Rust side stays as it is.

[^1]: Nemotron-3 Diarization model card: governed by the OpenMDW License Agreement 1.1, "handles up to eight speakers", 16 kHz single-channel input, all evaluations include overlapping speech, AMI (train and development) and VoxConverse v0.3 (development and test) in the training data table: <https://huggingface.co/nvidia/Nemotron-3-Diarization>.

[^2]: OpenMDW License Agreement, version 1.1: <https://openmdw.ai/license/1-1/>.

[^3]: ggml-org/whisper.cpp PR #4095, "diar : add Nemotron 3 Diarization support", draft: <https://github.com/ggml-org/whisper.cpp/pull/4095>.

[^4]: AMI Meeting Corpus diarization setup (reference turns from the manual annotations, words only): <https://github.com/pyannote/AMI-diarization-setup>.

[^5]: AMI Meeting Corpus: <https://groups.inf.ed.ac.uk/ami/corpus/>.

[^6]: Multilingual LibriSpeech (SLR94), eight languages including Polish, CC BY 4.0: <https://www.openslr.org/94/>.

[^7]: VoxConverse speaker diarisation dataset: <https://github.com/joonson/voxconverse>.

[^8]: The model file in the catalogue: <https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/main/Nemotron-3-Diarization.q8_0.gguf>.

[^9]: sherpa-onnx, Apache-2.0, with speaker diarization: <https://github.com/k2-fsa/sherpa-onnx>.

[^10]: pyannote speaker-diarization-community-1, CC-BY-4.0, gated: <https://huggingface.co/pyannote/speaker-diarization-community-1>.

[^11]: speakrs, a Rust implementation of the pyannote community-1 pipeline: <https://docs.rs/speakrs/latest/speakrs/>.

[^12]: Voice Arena diarization benchmark, 139 English sessions, DER at a 0 ms collar: <https://voicearena.com/diarization-bench>.

[^13]: DiariZen WavLM Large s80 MD, weights CC BY-NC 4.0: <https://huggingface.co/BUT-FIT/diarizen-wavlm-large-s80-md>.

[^14]: Reverb diarization v2, licence "other", gated: <https://huggingface.co/Revai/reverb-diarization-v2>.

[^15]: WhisperX, Python, speaker labels from pyannote-audio: <https://github.com/m-bain/whisperX>.

[^16]: NeMo-Speech.cpp, `DiarGeometry::v3_offline()` and `v3_streaming()` in `src/asr/diar/aosc_state.h`: <https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/src/asr/diar/aosc_state.h>.

[^17]: NeMo-Speech.cpp CLI documentation, diarization presets and the full-attention `--offline` path: <https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/cli.md>.

[^18]: whisper.cpp release v1.8.3 (2026-01-15), whose `ggml/include` headers are the vendored copy: <https://github.com/ggml-org/whisper.cpp/releases/tag/v1.8.3>.

[^19]: whisper-rs-sys 0.15.0 on crates.io (published 2026-03-12), the pinned build of whisper.cpp the runtime links: <https://crates.io/crates/whisper-rs-sys/0.15.0>.

[^20]: whisper.cpp v1.8.3, `ggml_backend_load_best` opens every file named after a backend in the backend directory, the executable's directory and the working directory to score it, and `ggml_backend_load_all_from_path` also loads `GGML_BACKEND_PATH`: <https://github.com/ggml-org/whisper.cpp/blob/v1.8.3/ggml/src/ggml-backend-reg.cpp#L522-L630>.

[^21]: whisper.cpp v1.8.3, `whisper_backend_init_gpu` takes a device of type `GGML_BACKEND_DEVICE_TYPE_GPU` or `GGML_BACKEND_DEVICE_TYPE_IGPU`: <https://github.com/ggml-org/whisper.cpp/blob/v1.8.3/src/whisper.cpp#L1302>.

[^22]: whisper.cpp v1.8.3 `gguf.h`, which declares `gguf_get_tensor_type` and `gguf_get_tensor_size` but no `gguf_get_tensor_ne`: <https://github.com/ggml-org/whisper.cpp/blob/v1.8.3/ggml/include/gguf.h#L120-L130>.

[^23]: PR #4095 at commit `1cd623724fd5`, `gguf.h` declaring `gguf_get_tensor_ne`: <https://github.com/danbev/whisper.cpp/blob/1cd623724fd5b4c38e45dab36346b2352fd78bec/ggml/include/gguf.h#L132>.

[^24]: PR #4095 at commit `1cd623724fd5`, `src/whisper-diarization.cpp`: the cache geometry `spkcache_len` 264, `fifo_len` 80, `chunk_len` 13, `spkcache_batch_len` 40 (lines 78 to 81), a chunk loop with one frame of right context and none on the left (lines 1408 to 1414), a backend choice that takes only `GGML_BACKEND_DEVICE_TYPE_GPU` after `ggml_backend_load_all` (lines 592 to 598), and the default thresholds 0.641 and 0.561 in `whisper_diar_default_params` (lines 1327 and 1328): <https://github.com/danbev/whisper.cpp/blob/1cd623724fd5b4c38e45dab36346b2352fd78bec/src/whisper-diarization.cpp>.
