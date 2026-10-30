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
- Windows was measured on one x86_64 laptop whose Vulkan device is its integrated GPU. On the CPU with 8 threads: 6.3 s for 142.6 s of meeting audio (a real-time factor of 0.044, model load included), 2 speakers found and no segment left unlabelled; that run fell back to the CPU because the vendored code did not take an integrated GPU as a GPU device, which local change 9 fixed. A run after the fix picked Vulkan0 and labelled 4 speakers from 39 turns in 24.4 s on a longer recording; whether the integrated GPU beats the CPU for this model was not measured, nor was a long recording, so the Settings text gives no time on Windows. The Amendment of 2026-10-27 measured both.
- The microphone can pick up the meeting audio through the speakers; such a fragment is transcribed on the `Mic` channel as "You" (2.6 s at the start of that 142.6 s recording). Diarization never touches the `Mic` channel, so it cannot correct it. The Amendment of 2026-10-29 measured diarizing that channel.
- The vendored code is a copy of a draft. A whisper-rs-sys bump fails the build until the ggml headers and `UPSTREAM` are updated. When whisper-rs-sys ships whisper.cpp with diarization, the duplicate `whisper_diar_*` symbols fail the link, which is the signal to delete the copy; the Rust side stays as it is.

## Amendment (2026-10-27): an integrated GPU diarizes on the CPU

**Context.** SPEED-823 measured what the Windows limitation above left open. The host was one Dell Latitude 5421 (Intel Core i7-11850H, 8 cores, 16 GB, Intel UHD Graphics as its only GPU, driver 32.0.101.7088, on AC power in Best performance mode), running the `diarize` example at `dev` `239ff5bc` with the default thread count, two runs per case. The inputs were 16 kHz mono files cut from AMI[^4][^5]: 30 minutes of the meetings EN2002a and EN2002c, 15 minutes each, and 2 hours of eight meetings at 15 minutes each, padded with the start of EN2002a. During the GPU runs the 3D engine of the integrated GPU ran at about 92% through Vulkan.

| input  | device         | time, median of 2 | real-time factor | difference between runs | peak working set |
| ------ | -------------- | ----------------- | ---------------- | ----------------------- | ---------------- |
| 30 min | CPU            | 87.8 s            | 0.049            | 2.2%                    | 267 MB           |
| 30 min | integrated GPU | 119.9 s           | 0.067            | 0.04%                   | 314 MB           |
| 2 h    | CPU            | 367.8 s           | 0.051            | 0.4%                    | 620 MB           |
| 2 h    | integrated GPU | 482.5 s           | 0.067            | 0.5%                    | 667 MB           |

The integrated GPU was 37% slower at 30 minutes and 31% slower at 2 hours, and its peak working set was 47 MB higher. The two runs of each case gave identical turns. On the same files an Apple M4 Pro took 31.9 s and 134.1 s on the CPU and 6.0 s and 23.4 s on Metal, one run at `e533d769`, which has the same `crates/` as `239ff5bc`.

**Decision.**

- Diarization uses the GPU only when the host's class is `GpuClass::Discrete` (`transcription/diarizer.rs::context_params`): Metal on macOS, which always reports `Discrete` (`transcription/accel.rs::gpu_class`), and a discrete Vulkan device on Windows. `GpuClass::Integrated`, which also covers a virtual GPU (`transcription/gpu_probe.rs::classify_device_types`), diarizes on the CPU. Whisper keeps the GPU on every class but `None` (`transcription/transcriber.rs`).
- On Windows with an integrated GPU, the Settings cost line reads "Adds about 3 minutes per hour of recording." (`desktop/src/src/app/settings/transcription-section/transcription-section.component.ts::SPEAKER_COST_TEXT`), from the CPU's 2.93 to 3.07 minutes per hour above. The rule agreed before the measurement rounded up to whole minutes, which gives 4; 3 is closer to what was measured. A discrete GPU and a host without one keep a line with no time: neither was measured, and a Windows host without a GPU is usually an older machine or a VM that this laptop does not represent.

**Consequences.**

- The CPU time stands for an H-series laptop processor; a lower-power processor can take longer per hour.
- The 2-hour file measures time and memory, not labels on a long meeting. From about the 60th minute the model dropped most of the speech in some 15-minute blocks, on every device, in different blocks per device, while the first 45 minutes gave nearly the same turns on every device. The likely cause, not verified, is that eight separate meetings hold more distinct voices than the eight speakers the model tracks. Labels on a real 2-hour meeting of at most eight people were not measured.
- A laptop with both an integrated and a discrete GPU reports `Discrete`, and the vendored code takes the first device of type GPU or integrated GPU in ggml's order (`gpu_device` 0, `native/whisper-diarization/whisper-diarization.cpp`). Whether that is the discrete one on such a laptop was not checked.

## Amendment (2026-10-28): mono recordings of the meeting audio are diarized

**Context.** Decision 3 diarized only the `System` channel of a paired capture: a mono recording was never diarized. Three kinds of mono audio hold nothing but meeting audio. An imported file (ADR-056 Amendment 22) is averaged into one channel by `transcription/import.rs`, so a meeting recorded in another app has every participant on that channel. A recording of "Other people only" (`AudioSource::SystemWide`) is mono because it has no microphone channel. A part of a "Whole meeting" recording (`AudioSource::Mixed`) made on macOS without microphone access is mono too: the capture CLI then records the system audio alone (`native/macos/audio-capture/Sources/AudioCaptureCLI.swift`, "recording system audio only"); on Windows a "Whole meeting" recording opens the microphone or fails to start (`transcription/audio_windows.rs`), so it is always stereo. With the Settings switch on, none of them got labels and nothing told the user why (SPEED-898).

**Decision.**

- Every recording but one of the microphone alone holds meeting audio (`transcription/transcript_driver.rs::has_meeting_audio`, from the session's audio source, which `run_finalize` reads from the store). Its meeting lane is channel 0 of every part:

  | part                                                   | meeting lane                  | label after diarization                      |
  | ------------------------------------------------------ | ----------------------------- | -------------------------------------------- |
  | stereo part of `Mixed`                                 | channel 0 (`System`)          | `Meeting · Speaker N`; channel 1 stays "You" |
  | mono part of `Mixed` (macOS without microphone access) | the one channel               | `Speaker N`                                  |
  | mono part of `SystemWide` or `ImportedFile`            | the one channel               | `Speaker N`                                  |
  | any part of `Microphone`                               | none: the model is not loaded | none                                         |

- `label_speakers` stamps every segment but a `Mic` one, numbered across all parts. The segments of a mono part keep `source: null` in `transcript.json`; `TranscriptSource`, its TypeScript mirror, `lane_sources` and the live pass do not change. A diarized segment without a tag is labelled `Speaker N`, without the `Meeting ·` prefix, in the Markdown export (`transcription/transcript.rs::to_markdown`) and in the pane (`live-transcript.component.ts::speakerOf`); the note in the Markdown header says that a 'Meeting' line without a number, or a line without any label, has no recognised speaker.
- `import_transcription` takes the Settings switch as `speaker_mode`, like `stop_transcription` and `transcribe_transcript`.
- A recording of the microphone alone is still never diarized. When the switch is on, the pane of such a finished recording says that it gets no speaker labels, and the Settings text under the switch says which recordings get them. A pass handed a diarizer that it does not run logs why.

**Consequences.**

- Every measurement above ran on uncompressed audio: the meeting channel of Speedwave recordings and AMI Mix-Headset. An import can be compressed: the formats it accepts include M4A, MP4 and MP3 (`transcription/import.rs::IMPORT_EXTENSIONS`). Eight AMI meetings[^4][^5], 15 minutes each, went through the import and diarization path of the app in four versions, scored automatically against the AMI reference per Whisper segment, the unit the user sees:

  | version                       | segment agreement | difference to WAV (95% CI) | speaker count within ±1 | worst meeting |
  | ----------------------------- | ----------------- | -------------------------- | ----------------------- | ------------- |
  | WAV                           | 90.2%             |                            | 8/8                     | 83.6%         |
  | AAC-LC, 16 kHz, 48 kb/s       | 90.3%             | +0.0 pp (−1.2 to +1.1)     | 8/8                     | 83.8%         |
  | AAC-LC, 32 kHz, 52 kb/s       | 89.5%             | −0.8 pp (−1.5 to −0.1)     | 8/8                     | 82.1%         |
  | AAC-LC, 24 kb/s (stress test) | 90.5%             | +0.3 pp (−1.5 to +2.4)     | 8/8                     | 84.3%         |

  Every meeting in every version is above the 80% of decision 7. The speaker count was exact in 30 of the 32 runs and one too high in the other two. The 16 kHz version stands for a Teams recording and the 32 kHz one for a Zoom recording; the encoder used allows at most 48 kb/s at 16 kHz. The 32 kHz version is the only one whose interval excludes zero, and its −0.8 pp is smaller than the spread between meetings. These figures do not compare with the 82.83% of round 3, which scored the reference utterances rather than Whisper segments. The encoding reproduces the codec only, not any other processing a meeting app applies before it saves a recording. Two real meetings recorded by the author and diarized as mono, one of them with echo of the remote speakers, gave one sentence assigned to the wrong speaker and none.

- An import, like a recording, has no length limit, and the limits under Known limitations apply to it: memory grows with its length, and labels on a meeting longer than 45 minutes were not measured (2026-10-27 amendment). Nothing caps or warns about the length of an import.
- An app version older than this amendment shows the lines of a diarized mono part without labels, while its Markdown export still lists the speakers in the header and attaching it to a chat still adds the note on `Speaker N` labels (`transcription.service.ts::SPEAKER_LABELS_PROMPT`), since both follow `models_used.diarization`.
- A recording transcribed before this change gets labels on its mono parts on "Transcribe again" with the switch on.

## Amendment (2026-10-29): the microphone lane is not diarized

**Context.** Decision 3, as amended on 2026-10-28, diarizes only the meeting lane, so in a hybrid meeting everyone in the room around one laptop is "You" while the remote participants get `Speaker N` (SPEED-824). Diarizing the microphone lane meets the echo case of ADR-075: the meeting audio comes back through the speakers into the microphone and would be labelled as a person in the room. Two variants were measured against what ships, with the criteria written down and hashed before the run (the preregistration, SHA256 `83a48128…`, and its annex that replaced the recording of a meeting room with the synthetic recordings below, `292f92c6…`); both, the scripts and the results are kept with SPEED-824, outside the repository. Variant A diarizes the `Mic` channel on its own, with its own numbering, and drops a turn of which at least 80% overlaps the Whisper segments of the `System` channel. Variant B diarizes the sum of both channels, only to obtain the labels, and tags each segment by its own channel. "Do it" required, on the decision recording, at least 80% of the `Mic` segments with the right person (the threshold of decision 7), at most one false speaker made of echo, and a `System` lane within 2 pp of what ships.

No hybrid meeting was recorded. The decision recording is synthetic, built from six voices of the author's own Polish Speedwave recordings: three remote voices from the `System` channel of three sessions, and three room voices, the author's own `Mic` channel of a session in which that channel carries no echo (−6 dB) and two other people from the `System` channel of the same session (−12 dB low-passed at 4 kHz, −15 dB at 3.5 kHz, standing in for distance). Each voice is cut into chunks of 3 to 15 s along its Whisper segments; a generator with a fixed seed lays the chunks out with pauses of 0.2 to 1.2 s and an overlap of 0.3 to 1 s at a fifth of the speaker changes; the `System` channel leaks into the `Mic` channel delayed by 40 ms, low-passed at 3 kHz and attenuated. Three recordings: 15 minutes with the echo at −14 dB (the decision set), 10 minutes without echo (the control), and 10 minutes at −8 dB. The truth of a segment is the voice its channel carried for at least 30% of it, or `echo` for a `Mic` segment with no room voice and `System` speech over at least 30% of it; that rule gives the control without echo 6 `echo` segments. The Whisper segments come from the app's own offline pass on the stereo file (`large-v3`, "Transcribe again") at `dev` `d7d66986`; the turns of each channel from the `diarize` example on the Metal of an Apple M4 Pro; a label is mapped to one person by the assignment that maximises their overlap time.

| recording            | variant                  | `Mic` segments right | `System` segments right | false speakers from echo |
| -------------------- | ------------------------ | -------------------- | ----------------------- | ------------------------ |
| echo −14 dB (15 min) | ships today              | 46.4% (45/97)        | 96.4% (54/56)           | 0                        |
| echo −14 dB (15 min) | A, no overlap filter     | 89.7%                | 96.4%                   | 3                        |
| echo −14 dB (15 min) | A, overlap filter at 80% | 59.8%                | 96.4%                   | 2                        |
| echo −14 dB (15 min) | B                        | 96.9%                | 82.1%                   | 2                        |
| no echo (10 min)     | ships today              | 52.2% (24/46)        | 93.5% (29/31)           | 0                        |
| no echo (10 min)     | A, no overlap filter     | 97.8%                | 93.5%                   | 0                        |
| no echo (10 min)     | A, overlap filter at 80% | 69.6%                | 93.5%                   | 0                        |
| no echo (10 min)     | B                        | 93.5%                | 83.9%                   | 1                        |
| echo −8 dB (10 min)  | ships today              | 48.3% (29/60)        | 93.5% (29/31)           | 0                        |
| echo −8 dB (10 min)  | A, no overlap filter     | 98.3%                | 93.5%                   | 3                        |
| echo −8 dB (10 min)  | A, overlap filter at 80% | 65.0%                | 93.5%                   | 2                        |
| echo −8 dB (10 min)  | B                        | 98.3%                | 83.9%                   | 2                        |

A false speaker from echo is a label whose time on `echo` segments exceeds its time on the others; in variant B those are the remote participants' own labels, which covered their echo as intended. With echo, the `Mic` channel got six labels for three people: the echo of each remote participant became a speaker of its own (57 of the 58 echo segments in the decision set). The overlap filter at 80% removed 90% of those turns; at every threshold between 60% and 95% it also dropped 33 to 43% of the room people's segments on the decision set, 28 to 32% at −8 dB and 22 to 26% on the control without echo: a Whisper segment is longer than the speech in it, so the filter sees overlap where there is none. Variant B put the echo under the remote participants' labels, but the summed input cost the `System` lane 9.7 to 14.3 pp in every recording, and its "You" would be a guess (the dominant label of the `Mic` channel). Variant A is a second run of the model: a real-time factor of 0.0065 against 0.0033 on Metal.

The spike on the capture side is `spike/SPEED-824-macos-aec` at `9dd467f4`: one change in `native/macos/audio-capture/Sources/AudioCaptureCLI.swift::startMicEngine` that, with `SPEEDWAVE_MIC_AEC=1` in the environment, calls `setVoiceProcessingEnabled(true)` on the input node of the microphone engine before the tap is installed and sets that mode's ducking of other audio to its minimum. It was recorded on macOS 27.0.1 with the built-in microphone and speakers, with speech played by another process and nobody talking. The mode reported itself enabled, the input node then reported the device "MacBook Pro Speakers" with 9 channels instead of the default 1-channel aggregate, and the `Mic` channel of the recording held digital silence (no non-zero sample in 41 s), while without the mode it sat 1.4 dB under the `System` channel. So the mode did not cancel the echo; it removed the microphone. Apple documents that voice processing needs both IO nodes of the engine in that mode[^25]; the capture engine (`startMicEngine` in the same file) has a tap on the input node and nothing on the output node, and no other topology was tried. Windows was not measured.

**Decision.** The microphone lane stays "You"; decision 3 stands. No variant met the criteria on the decision recording: A failed the 80% threshold with the filter (59.8%, with 2 false speakers from echo on top) and the echo count without it (3), and B failed the `System` lane (−14.3 pp). Variant B is not reopened: summing the two channels before a model is the mono mix that ADR-056 Amendment 9 took out of the decode path because mixing two speech sources loses information, and this measurement shows the same loss on the `System` lane. Variant A without the overlap filter is reopened when one of these holds:

- an echo cancellation in the capture that keeps the microphone signal (another voice-processing topology on macOS, the VoiceProcessingIO audio unit directly[^26], or on Windows a capture stream of the communications category[^27] with `IAcousticEchoCancellationControl`, which Windows Build 22621 introduced[^28]): on the control without echo it met every criterion (97.8% of the `Mic` segments, no false speaker, `System` unchanged);
- an overlap filter on voice activity instead of Whisper segments, measured against the room people's segments it drops;
- a diarization model that keeps the echo of a remote participant with that participant's label on the summed input without the loss on the `System` lane.

**Consequences.**

- The measurement is synthetic: no room acoustics, a fixed echo delay, voices identified by the model's own labels in the source sessions, the three room voices from one session, a generator's turn-taking, one Mac. The decision set holds 97 `Mic` and 56 `System` segments, so one segment is about 1 pp on the `Mic` lane and 1.8 pp on the `System` lane. A real hybrid meeting with a far-field microphone remains unmeasured.
- The spike branch `spike/SPEED-824-macos-aec` is not merged. Enabling voice processing on the input node of the capture engine as it is today records silence on the `Mic` channel, so it must not be turned on without a topology that was measured to deliver audio.

## Amendment (2026-10-30): the user names the speakers

**Context.** Decision 5 numbered the speakers and gave no way to name them. The person who recorded a meeting knows who spoke but could not record it: the pane and the Markdown export read through numbers, and the chat prompt (`desktop/src/src/app/services/transcription.service.ts::SPEAKER_LABELS_PROMPT`) asked the model to guess names from the text, which a summary with a "who, what, by when" list depends on most (SPEED-900).

**Decision.**

- A name belongs to a speaker number of the transcript on screen and holds for every line of that speaker. The session stores it next to the title, in `TranscriptSession.named_speakers`, written by `TranscriptStore::rename_speaker` through the `rename_speaker` command (`transcription/transcript.rs`, `transcription/transcript_store.rs`, `desktop/src-tauri/src/transcription_cmd.rs`). Names are given once the transcription is over (`Done`, `Postponed` or `Failed`): during an offline pass the store refuses them (`TranscriptSession::check_speaker_name`), since the pass would number the speakers again and a name saved at its end could land on another person. The field is not named `speaker_names`: transcripts written before ADR-075 carry a field of that name in another shape, and they must keep loading.
- A name is normalised like a title and cut to 40 characters (`transcript.rs::normalize_speaker_name`); a blank name takes it away and the number shows again. A label the transcript already uses ("You", "Meeting", `Speaker N`) is refused as a name. Two labels given the same name, compared without case and outer whitespace (`same_speaker_name`), read as one person: the store keeps the spelling the other label already has, and the header of the export lists the name once. The labels themselves stay separate, so renaming either one splits them again.
- The pane names a speaker from the label on a line and from a row of speaker chips above the transcript (`meeting-transcription/speaker-legend/speaker-legend.component.ts`). Both open one dialog, which says how many lines the name changes and when it makes two labels one person in the transcript, exports and chats (with the advice to add a surname or a number for two people of one name), and saves only on Enter or Save, never on blur. A label is the speaker's name or `Speaker N`: the `Meeting · ` prefix of decision 5 and of the amendment of 2026-10-28 is gone from the pane and from the export, where a microphone line still reads "You" and a meeting line without a speaker "Meeting". Speakers 1 to 4 keep their colour dot (teal, violet, amber and rose: the fourth was green, which read as the first's teal); from the fifth on a circle carries the initial of the name, or the number. Labels that share a name stand next to each other in the row, each with its number (`#4`), light up together, and count as one speaker in the meta line ("4 speakers · 5 labels").
- A new offline pass numbers the speakers again, so `TranscriptSession::set_final_segments` moves the names to `previous_speaker_names`, each once, and `FinalSegmentsReady` carries them to an open pane, where the dialog offers them for one click. No name is carried over by guessing which new number is which person. A pass that is put off keeps the transcript and its names.
- The user's own name is one setting on this computer (Settings, "Your name", localStorage), not a name per recording. It replaces "You" in the export (`to_markdown`'s `your_name`, passed by `export_transcript` and `get_transcript_markdown`) and so in a transcript attached to a chat, while the pane keeps "You". The first export, copy or attach of a transcript with lines of the user asks for it, once on this computer; answering "Keep You" does not ask again.
- With at least one speaker named, the chat prompt lists the names as set by the user and to be treated as certain, tells the model not to guess a name for the labels left unnamed, and keeps the note that the labels are approximate. With none named it keeps the sentence it had: names only on evidence in the text, uncertain attributions flagged.

**Consequences.**

- A name does not correct a wrong label: a label that covers two people gives the lines of both the same name. Correcting the speaker of single lines, and names proposed by the model, are left out of this step.
- An app version older than this amendment ignores both fields and shows numbers, in the pane and in its export, and drops the names the next time it writes the session (a title change, a new pass).
- Names stay within one recording; nothing remembers participants across recordings.

[^1]: Nemotron-3 Diarization model card: governed by the OpenMDW License Agreement 1.1, "handles up to eight speakers", 16 kHz single-channel input, all evaluations include overlapping speech, AMI (train and development) and VoxConverse v0.3 (development and test) in the training data table: <https://huggingface.co/nvidia/Nemotron-3-Diarization>.

[^2]: OpenMDW License Agreement, version 1.1: <https://openmdw.ai/license/1-1/>.

[^3]: ggml-org/whisper.cpp PR #4095, "diar : add Nemotron 3 Diarization support", draft: <https://github.com/ggml-org/whisper.cpp/pull/4095>.

[^4]: AMI Meeting Corpus diarization setup (reference turns from the manual annotations, words only): <https://github.com/pyannote/AMI-diarization-setup>.

[^5]: AMI Meeting Corpus: <https://groups.inf.ed.ac.uk/ami/corpus/>.

[^6]: Multilingual LibriSpeech (SLR94), eight languages including Polish, CC BY 4.0: <https://www.openslr.org/94/>.

[^7]: VoxConverse speaker diarisation dataset: <https://github.com/joonson/voxconverse>.

[^8]: The model file in the catalogue: <https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/f667ed73aee57d40cc39428eb768b4fd87a0a29e/Nemotron-3-Diarization.q8_0.gguf>.

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

[^25]: `AVAudioIONode.setVoiceProcessingEnabled(_:)`: <https://developer.apple.com/documentation/avfaudio/avaudioionode/setvoiceprocessingenabled(_:)>; quoted by an Apple engineer in Developer Forums thread 733733: "Voice processing requires both input and output nodes to be in the voice processing mode. Enabling this mode on either of the IO nodes automatically enables it on the other IO node.": <https://developer.apple.com/forums/thread/733733>.

[^26]: `kAudioUnitSubType_VoiceProcessingIO`, the Audio Toolbox voice-processing I/O unit: <https://developer.apple.com/documentation/audiotoolbox/kaudiounitsubtype_voiceprocessingio>.

[^27]: `AUDIO_STREAM_CATEGORY`, `AudioCategory_Communications` ("Real-time communications, such as VOIP or chat"), one of the three categories valid for a capture stream: <https://learn.microsoft.com/en-us/windows/win32/api/audiosessiontypes/ne-audiosessiontypes-audio_stream_category>.

[^28]: `IAcousticEchoCancellationControl`, "determining if an audio capture endpoint supports acoustic echo cancellation (AEC) and, if so, allows the client to set the audio render endpoint that should be used as the reference stream", minimum supported client Windows Build 22621: <https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nn-audioclient-iacousticechocancellationcontrol>.
