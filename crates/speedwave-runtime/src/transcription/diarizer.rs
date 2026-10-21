//! Speaker diarization of the meeting channel (ADR-097): the `Diarizer` trait, the
//! Nemotron-3 engine over the vendored whisper.cpp code, and attribution to segments.

use std::cmp::Reverse;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::Path;
use std::ptr::NonNull;
use std::sync::atomic::AtomicBool;
use std::sync::Once;
use std::time::Duration;

use super::accel::{decode_threads, GpuClass};
use super::transcriber::{abort_when_cancelled, DecodeCancel, Segment, TranscriptSource};

const LOG_TARGET: &str = "transcription::diarization";

const FRAME_MS: u64 = 10;

const GGML_LOG_LEVEL_INFO: c_int = 2;
const GGML_LOG_LEVEL_WARN: c_int = 3;
const GGML_LOG_LEVEL_ERROR: c_int = 4;

mod ffi {
    use std::ffi::{c_char, c_int, c_void};

    #[repr(C)]
    pub(super) struct Context {
        _private: [u8; 0],
    }

    #[repr(C)]
    pub(super) struct Segments {
        _private: [u8; 0],
    }

    #[repr(C)]
    #[derive(Debug, Clone, Copy)]
    pub(super) struct ContextParams {
        pub(super) n_threads: c_int,
        pub(super) use_gpu: bool,
        pub(super) gpu_device: c_int,
        pub(super) flash_attn: bool,
    }

    #[repr(C)]
    #[derive(Debug, Clone, Copy)]
    pub(super) struct Params {
        pub(super) start_threshold: f32,
        pub(super) stop_threshold: f32,
        pub(super) start_pad_ms: c_int,
        pub(super) end_pad_ms: c_int,
        pub(super) min_speech_duration_ms: c_int,
        pub(super) min_silence_duration_ms: c_int,
    }

    pub(super) type LogCallback =
        unsafe extern "C" fn(level: c_int, text: *const c_char, user_data: *mut c_void);

    pub(super) type AbortCallback = unsafe extern "C" fn(data: *mut c_void) -> bool;

    #[expect(
        unsafe_code,
        reason = "whisper diarization FFI boundary; every block has a SAFETY comment"
    )]
    unsafe extern "C" {
        pub(super) fn whisper_diar_default_context_params() -> ContextParams;
        pub(super) fn whisper_diar_init_from_file_with_params(
            path_model: *const c_char,
            params: ContextParams,
        ) -> *mut Context;
        pub(super) fn whisper_diar_detect_speakers(
            ctx: *mut Context,
            samples: *const f32,
            n_samples: i64,
            abort_callback: Option<AbortCallback>,
            abort_callback_data: *mut c_void,
        ) -> bool;
        pub(super) fn whisper_diar_default_params() -> Params;
        pub(super) fn whisper_diar_segments_from_probs(
            ctx: *const Context,
            params: Params,
        ) -> *mut Segments;
        pub(super) fn whisper_diar_segments_n_segments(segments: *const Segments) -> c_int;
        pub(super) fn whisper_diar_segments_get_segment_t0(
            segments: *const Segments,
            i: c_int,
        ) -> i64;
        pub(super) fn whisper_diar_segments_get_segment_t1(
            segments: *const Segments,
            i: c_int,
        ) -> i64;
        pub(super) fn whisper_diar_segments_get_speaker(
            segments: *const Segments,
            i: c_int,
        ) -> c_int;
        pub(super) fn whisper_diar_free_segments(segments: *mut Segments);
        pub(super) fn whisper_diar_free(ctx: *mut Context);
        pub(super) fn speedwave_diar_log_set(callback: Option<LogCallback>, user_data: *mut c_void);
        #[cfg(test)]
        pub(super) fn speedwave_diar_abi_sizes(context_params: *mut usize, params: *mut usize);
    }
}

/// One stretch of audio the model attributes to one speaker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpeakerTurn {
    /// Start offset from the start of the audio.
    pub start: Duration,
    /// End offset.
    pub end: Duration,
    /// The model's speaker index (0-based, not yet numbered for display).
    pub speaker: u32,
}

/// Diarizer errors.
#[derive(Debug, thiserror::Error)]
pub enum DiarizeError {
    /// The diarization model file couldn't be loaded.
    #[error("failed to load diarization model {model}: {detail}")]
    ModelLoad {
        /// Model file name.
        model: String,
        /// Underlying error.
        detail: String,
    },
    /// The model isn't downloaded.
    #[error("diarization model {0} is not downloaded")]
    ModelMissing(String),
    /// Diarization inference failed.
    #[error("diarization failed: {0}")]
    Inference(String),
    /// Unusable input PCM.
    #[error("invalid audio for diarization: {0}")]
    InvalidAudio(String),
}

/// A speaker-diarization engine over a whole 16 kHz mono buffer. One per offline pass.
pub trait Diarizer: Send {
    /// Speaker turns of `pcm` (16 kHz mono `f32`), ordered by start; a raised `cancel` ends
    /// the run early with an error.
    fn diarize(
        &mut self,
        pcm: &[f32],
        cancel: &DecodeCancel,
    ) -> Result<Vec<SpeakerTurn>, DiarizeError>;
}

/// Loads a diarizer on demand, so the offline pass holds its model only after Whisper is done.
pub type DiarizerLoader = Box<dyn FnOnce() -> Result<Box<dyn Diarizer>, DiarizeError> + Send>;

/// Nemotron-3 Diarization (Sortformer) through the vendored whisper.cpp code.
pub struct NemotronDiarizer {
    ctx: NonNull<ffi::Context>,
}

struct SegmentList(NonNull<ffi::Segments>);

// SAFETY: the context is owned by this value alone and used by one thread at a time (the
// offline pass); the vendored code keeps no thread-local state, so it may move between threads.
#[expect(
    unsafe_code,
    reason = "whisper diarization FFI boundary; every block has a SAFETY comment"
)]
unsafe impl Send for NemotronDiarizer {}

impl NemotronDiarizer {
    /// Loads the GGUF model at `model_path`, on the GPU unless `class` is `GpuClass::None`,
    /// with `decode_threads()` CPU threads.
    pub fn load(model_path: &Path, class: GpuClass) -> Result<Self, DiarizeError> {
        Self::load_with_threads(model_path, class, decode_threads())
    }

    /// `load` with an explicit CPU thread count (at least 1).
    #[expect(
        unsafe_code,
        reason = "whisper diarization FFI boundary; every block has a SAFETY comment"
    )]
    pub fn load_with_threads(
        model_path: &Path,
        class: GpuClass,
        n_threads: i32,
    ) -> Result<Self, DiarizeError> {
        let label = model_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| model_path.display().to_string());
        if !model_path.is_file() {
            return Err(DiarizeError::ModelMissing(label));
        }
        if n_threads < 1 {
            return Err(DiarizeError::ModelLoad {
                model: label,
                detail: format!("thread count must be at least 1, got {n_threads}"),
            });
        }
        let path = model_path
            .to_str()
            .and_then(|p| CString::new(p).ok())
            .ok_or_else(|| DiarizeError::ModelLoad {
                model: label.clone(),
                detail: "model path is not valid UTF-8 or contains NUL".to_string(),
            })?;
        install_log_forwarding();

        // SAFETY: takes no arguments and returns a plain struct by value.
        let mut params = unsafe { ffi::whisper_diar_default_context_params() };
        params.n_threads = n_threads;
        params.use_gpu = class != GpuClass::None;

        // SAFETY: `path` is a NUL-terminated string alive for the call, which copies it; the
        // function returns null on every failure and catches every C++ exception.
        let raw = unsafe { ffi::whisper_diar_init_from_file_with_params(path.as_ptr(), params) };
        let ctx = NonNull::new(raw).ok_or_else(|| DiarizeError::ModelLoad {
            model: label,
            detail: format!("see the {LOG_TARGET} log"),
        })?;
        Ok(Self { ctx })
    }
}

impl Diarizer for NemotronDiarizer {
    #[expect(
        unsafe_code,
        reason = "whisper diarization FFI boundary; every block has a SAFETY comment"
    )]
    fn diarize(
        &mut self,
        pcm: &[f32],
        cancel: &DecodeCancel,
    ) -> Result<Vec<SpeakerTurn>, DiarizeError> {
        validate_pcm(pcm)?;
        if pcm.is_empty() {
            return Ok(Vec::new());
        }
        let n_samples = i64::try_from(pcm.len())
            .map_err(|_| DiarizeError::InvalidAudio(format!("{} samples", pcm.len())))?;
        let flag: *const AtomicBool = cancel.flag();
        // SAFETY: `self.ctx` is a live context owned by `self`, `&mut self` rules out a
        // concurrent call, and `pcm` holds `n_samples` floats for the whole call.
        // `abort_when_cancelled` has the `ggml_abort_callback` signature and only reads the
        // `AtomicBool` behind its data pointer, the flag inside `cancel`, which this function
        // borrows until the call returns; the vendored code calls the hook only inside it.
        let detected = unsafe {
            ffi::whisper_diar_detect_speakers(
                self.ctx.as_ptr(),
                pcm.as_ptr(),
                n_samples,
                Some(abort_when_cancelled),
                flag.cast_mut().cast(),
            )
        };
        if !detected {
            return Err(DiarizeError::Inference(format!(
                "speaker detection failed or was stopped; see the {LOG_TARGET} log"
            )));
        }
        SegmentList::from_probs(self.ctx)?.turns()
    }
}

impl Drop for NemotronDiarizer {
    #[expect(
        unsafe_code,
        reason = "whisper diarization FFI boundary; every block has a SAFETY comment"
    )]
    fn drop(&mut self) {
        // SAFETY: `self.ctx` came from `whisper_diar_init_from_file_with_params` and is freed
        // exactly once, here.
        unsafe { ffi::whisper_diar_free(self.ctx.as_ptr()) }
    }
}

impl SegmentList {
    #[expect(
        unsafe_code,
        reason = "whisper diarization FFI boundary; every block has a SAFETY comment"
    )]
    fn from_probs(ctx: NonNull<ffi::Context>) -> Result<Self, DiarizeError> {
        // SAFETY: takes no arguments and returns a plain struct by value.
        let params = unsafe { ffi::whisper_diar_default_params() };
        // SAFETY: `ctx` is live; the function reads only the probabilities the context holds
        // (none before the first `whisper_diar_detect_speakers`, which gives an empty list),
        // returns null on failure and catches every C++ exception.
        let raw = unsafe { ffi::whisper_diar_segments_from_probs(ctx.as_ptr(), params) };
        NonNull::new(raw).map(Self).ok_or_else(|| {
            DiarizeError::Inference(format!(
                "building speaker segments failed; see the {LOG_TARGET} log"
            ))
        })
    }

    #[expect(
        unsafe_code,
        reason = "whisper diarization FFI boundary; every block has a SAFETY comment"
    )]
    fn turns(&self) -> Result<Vec<SpeakerTurn>, DiarizeError> {
        let list = self.0.as_ptr();
        // SAFETY: `list` is live until `self` drops.
        let n = unsafe { ffi::whisper_diar_segments_n_segments(list) };
        (0..n.max(0))
            .map(|i| {
                // SAFETY: `list` is live and `i` is within `0..n`.
                let (t0, t1, speaker) = unsafe {
                    (
                        ffi::whisper_diar_segments_get_segment_t0(list, i),
                        ffi::whisper_diar_segments_get_segment_t1(list, i),
                        ffi::whisper_diar_segments_get_speaker(list, i),
                    )
                };
                speaker_turn(t0, t1, speaker)
            })
            .collect()
    }
}

impl Drop for SegmentList {
    #[expect(
        unsafe_code,
        reason = "whisper diarization FFI boundary; every block has a SAFETY comment"
    )]
    fn drop(&mut self) {
        // SAFETY: the list came from `whisper_diar_segments_from_probs` and is freed exactly
        // once, here.
        unsafe { ffi::whisper_diar_free_segments(self.0.as_ptr()) }
    }
}

pub(crate) fn label_speakers(segments: &mut [Segment], turns: &[SpeakerTurn]) {
    assign_speakers(segments, turns);
    number_speakers(segments);
}

fn assign_speakers(segments: &mut [Segment], turns: &[SpeakerTurn]) {
    for seg in segments
        .iter_mut()
        .filter(|s| s.source == Some(TranscriptSource::System))
    {
        let best = turns
            .iter()
            .filter_map(|turn| {
                let overlap = turn
                    .end
                    .min(seg.end)
                    .saturating_sub(turn.start.max(seg.start));
                (!overlap.is_zero()).then_some((overlap, Reverse(turn.speaker)))
            })
            .max();
        seg.speaker_id = best.map(|(_, Reverse(speaker))| speaker);
    }
}

fn number_speakers(segments: &mut [Segment]) {
    let mut order: Vec<usize> = (0..segments.len()).collect();
    order.sort_by_key(|&i| (segments[i].start, i));
    let mut numbers: Vec<(u32, u32)> = Vec::new();
    for i in order {
        let Some(raw) = segments[i].speaker_id else {
            continue;
        };
        let number = match numbers.iter().find(|(r, _)| *r == raw) {
            Some(&(_, n)) => n,
            None => {
                let n = numbers.len() as u32 + 1;
                numbers.push((raw, n));
                n
            }
        };
        segments[i].speaker_id = Some(number);
    }
}

fn install_log_forwarding() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        whisper_rs::install_logging_hooks();
        set_log_callback();
    });
}

#[expect(
    unsafe_code,
    reason = "whisper diarization FFI boundary; every block has a SAFETY comment"
)]
fn set_log_callback() {
    // SAFETY: `forward_log` matches `ggml_log_callback` and ignores its user data; it is set
    // once, before the first context exists, and stays valid for the whole process.
    unsafe { ffi::speedwave_diar_log_set(Some(forward_log), std::ptr::null_mut()) }
}

#[expect(
    unsafe_code,
    reason = "whisper diarization FFI boundary; every block has a SAFETY comment"
)]
unsafe extern "C" fn forward_log(level: c_int, text: *const c_char, _user_data: *mut c_void) {
    if text.is_null() {
        return;
    }
    // SAFETY: the vendored code passes a NUL-terminated buffer that outlives this call.
    let text = unsafe { CStr::from_ptr(text) }.to_string_lossy();
    let line = text.trim_end();
    if !line.is_empty() {
        log::log!(target: LOG_TARGET, log_level(level), "{line}");
    }
}

fn log_level(level: c_int) -> log::Level {
    match level {
        GGML_LOG_LEVEL_ERROR => log::Level::Error,
        GGML_LOG_LEVEL_WARN => log::Level::Warn,
        GGML_LOG_LEVEL_INFO => log::Level::Info,
        _ => log::Level::Debug,
    }
}

fn validate_pcm(pcm: &[f32]) -> Result<(), DiarizeError> {
    match pcm.iter().position(|s| !s.is_finite()) {
        Some(i) => Err(DiarizeError::InvalidAudio(format!(
            "non-finite sample at index {i}"
        ))),
        None => Ok(()),
    }
}

fn frames_to_duration(frames: i64) -> Result<Duration, DiarizeError> {
    u64::try_from(frames)
        .map(|f| Duration::from_millis(f.saturating_mul(FRAME_MS)))
        .map_err(|_| DiarizeError::Inference(format!("negative frame index {frames}")))
}

fn speaker_turn(t0: i64, t1: i64, speaker: c_int) -> Result<SpeakerTurn, DiarizeError> {
    let speaker = u32::try_from(speaker)
        .map_err(|_| DiarizeError::Inference(format!("negative speaker index {speaker}")))?;
    Ok(SpeakerTurn {
        start: frames_to_duration(t0)?,
        end: frames_to_duration(t1)?,
        speaker,
    })
}

#[cfg(test)]
pub(crate) struct MockDiarizer {
    n_speakers: u32,
}

#[cfg(test)]
impl MockDiarizer {
    pub(crate) fn new(n_speakers: u32) -> Self {
        Self {
            n_speakers: n_speakers.max(1),
        }
    }
}

#[cfg(test)]
impl Diarizer for MockDiarizer {
    fn diarize(
        &mut self,
        pcm: &[f32],
        _cancel: &DecodeCancel,
    ) -> Result<Vec<SpeakerTurn>, DiarizeError> {
        if pcm.is_empty() {
            return Ok(Vec::new());
        }
        let total_ms = pcm.len() as u64 * 1000 / u64::from(super::audio::SAMPLE_RATE_HZ);
        let slice_ms = total_ms / u64::from(self.n_speakers);
        Ok((0..self.n_speakers)
            .map(|i| SpeakerTurn {
                start: Duration::from_millis(u64::from(i) * slice_ms),
                end: Duration::from_millis(if i + 1 == self.n_speakers {
                    total_ms
                } else {
                    u64::from(i + 1) * slice_ms
                }),
                speaker: i,
            })
            .collect())
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::*;

    fn seg(start_ms: u64, end_ms: u64, source: Option<TranscriptSource>) -> Segment {
        Segment {
            start: Duration::from_millis(start_ms),
            end: Duration::from_millis(end_ms),
            text: format!("[{start_ms}-{end_ms}]"),
            words: vec![],
            source,
            speaker_id: None,
        }
    }

    fn sys(start_ms: u64, end_ms: u64) -> Segment {
        seg(start_ms, end_ms, Some(TranscriptSource::System))
    }

    fn turn(start_ms: u64, end_ms: u64, speaker: u32) -> SpeakerTurn {
        SpeakerTurn {
            start: Duration::from_millis(start_ms),
            end: Duration::from_millis(end_ms),
            speaker,
        }
    }

    fn ids(segments: &[Segment]) -> Vec<Option<u32>> {
        segments.iter().map(|s| s.speaker_id).collect()
    }

    #[test]
    fn assign_speakers_picks_the_turn_with_the_most_overlap() {
        let mut segs = vec![sys(2000, 6000)];
        assign_speakers(&mut segs, &[turn(0, 3000, 0), turn(3000, 10_000, 1)]);
        assert_eq!(ids(&segs), vec![Some(1)]);
    }

    #[test]
    fn assign_speakers_leaves_a_segment_without_overlap_unlabelled() {
        let mut segs = vec![sys(20_000, 25_000), sys(5000, 6000)];
        assign_speakers(&mut segs, &[turn(0, 5000, 0)]);
        assert_eq!(ids(&segs), vec![None, None]);
    }

    #[test]
    fn assign_speakers_breaks_a_tie_by_the_smaller_speaker_in_any_turn_order() {
        let mut a = vec![sys(0, 2000)];
        assign_speakers(&mut a, &[turn(0, 1000, 3), turn(1000, 2000, 1)]);
        let mut b = vec![sys(0, 2000)];
        assign_speakers(&mut b, &[turn(1000, 2000, 1), turn(0, 1000, 3)]);
        assert_eq!(ids(&a), vec![Some(1)]);
        assert_eq!(ids(&b), vec![Some(1)]);
    }

    #[test]
    fn assign_speakers_sums_nothing_across_turns_and_takes_the_single_largest() {
        let mut segs = vec![sys(0, 10_000)];
        assign_speakers(
            &mut segs,
            &[turn(0, 2000, 0), turn(2000, 4000, 0), turn(4000, 7000, 1)],
        );
        assert_eq!(ids(&segs), vec![Some(1)]);
    }

    #[test]
    fn assign_speakers_skips_microphone_and_untagged_segments() {
        let mut segs = vec![
            seg(0, 2000, Some(TranscriptSource::Mic)),
            seg(0, 2000, None),
            sys(0, 2000),
        ];
        assign_speakers(&mut segs, &[turn(0, 2000, 4)]);
        assert_eq!(ids(&segs), vec![None, None, Some(4)]);
    }

    #[test]
    fn assign_speakers_handles_empty_inputs() {
        let mut none: Vec<Segment> = vec![];
        assign_speakers(&mut none, &[turn(0, 1000, 0)]);
        let mut segs = vec![sys(0, 1000)];
        assign_speakers(&mut segs, &[]);
        assert_eq!(ids(&segs), vec![None]);
    }

    #[test]
    fn label_speakers_assigns_the_model_speakers_and_numbers_them_by_first_appearance() {
        let mut segs = vec![
            sys(0, 1000),
            sys(1000, 2000),
            sys(2000, 3000),
            sys(3000, 4000),
        ];
        label_speakers(
            &mut segs,
            &[turn(0, 1000, 5), turn(1000, 2000, 2), turn(2000, 3000, 5)],
        );
        assert_eq!(ids(&segs), vec![Some(1), Some(2), Some(1), None]);
    }

    #[test]
    fn number_speakers_follows_first_appearance_in_time() {
        let mut segs = vec![
            sys(5000, 6000),
            sys(0, 1000),
            sys(2000, 3000),
            sys(7000, 8000),
        ];
        segs[0].speaker_id = Some(0);
        segs[1].speaker_id = Some(2);
        segs[2].speaker_id = Some(0);
        segs[3].speaker_id = Some(2);
        number_speakers(&mut segs);
        assert_eq!(ids(&segs), vec![Some(2), Some(1), Some(2), Some(1)]);
    }

    #[test]
    fn number_speakers_keeps_unlabelled_segments_and_breaks_equal_starts_by_position() {
        let mut segs = vec![sys(0, 1000), sys(0, 1000), sys(1000, 2000)];
        segs[0].speaker_id = Some(7);
        segs[1].speaker_id = Some(3);
        number_speakers(&mut segs);
        assert_eq!(ids(&segs), vec![Some(1), Some(2), None]);
        let mut empty: Vec<Segment> = vec![];
        number_speakers(&mut empty);
    }

    #[test]
    fn frames_are_ten_milliseconds() {
        assert_eq!(frames_to_duration(0).unwrap(), Duration::ZERO);
        assert_eq!(
            frames_to_duration(12_345).unwrap(),
            Duration::from_millis(123_450)
        );
        assert!(matches!(
            frames_to_duration(-1),
            Err(DiarizeError::Inference(_))
        ));
    }

    #[test]
    fn speaker_turn_rejects_a_negative_speaker() {
        assert_eq!(speaker_turn(100, 250, 2).unwrap(), turn(1000, 2500, 2));
        assert!(matches!(
            speaker_turn(0, 1, -1),
            Err(DiarizeError::Inference(_))
        ));
    }

    #[test]
    fn validate_pcm_rejects_non_finite_samples() {
        assert!(validate_pcm(&[]).is_ok());
        assert!(validate_pcm(&[0.0, -1.0, 1.0]).is_ok());
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert!(matches!(
                validate_pcm(&[0.0, bad]),
                Err(DiarizeError::InvalidAudio(msg)) if msg.contains("index 1")
            ));
        }
    }

    #[test]
    fn ggml_log_levels_map_to_log_levels() {
        assert_eq!(log_level(GGML_LOG_LEVEL_ERROR), log::Level::Error);
        assert_eq!(log_level(GGML_LOG_LEVEL_WARN), log::Level::Warn);
        assert_eq!(log_level(GGML_LOG_LEVEL_INFO), log::Level::Info);
        assert_eq!(log_level(1), log::Level::Debug);
        assert_eq!(log_level(0), log::Level::Debug);
        assert_eq!(log_level(5), log::Level::Debug);
    }

    #[test]
    #[expect(
        unsafe_code,
        reason = "whisper diarization FFI boundary; every block has a SAFETY comment"
    )]
    fn rust_struct_layouts_match_the_c_api() {
        let (mut context_params, mut params) = (0usize, 0usize);
        // SAFETY: both pointers are valid, writable `usize` locals.
        unsafe { ffi::speedwave_diar_abi_sizes(&mut context_params, &mut params) };
        assert_eq!(context_params, std::mem::size_of::<ffi::ContextParams>());
        assert_eq!(params, std::mem::size_of::<ffi::Params>());
    }

    #[test]
    #[expect(
        unsafe_code,
        reason = "whisper diarization FFI boundary; every block has a SAFETY comment"
    )]
    fn c_defaults_read_through_the_rust_structs() {
        // SAFETY: both take no arguments and return plain structs by value.
        let (ctx, seg) = unsafe {
            (
                ffi::whisper_diar_default_context_params(),
                ffi::whisper_diar_default_params(),
            )
        };
        assert_eq!(ctx.n_threads, 4);
        assert!(!ctx.use_gpu);
        assert_eq!(ctx.gpu_device, 0);
        assert!(ctx.flash_attn);
        assert_eq!((seg.start_threshold, seg.stop_threshold), (0.641, 0.561));
        assert!(seg.min_speech_duration_ms >= 0 && seg.min_silence_duration_ms >= 0);
    }

    #[test]
    fn load_reports_a_missing_model() {
        let dir = tempfile::tempdir().unwrap();
        match NemotronDiarizer::load(&dir.path().join("absent.gguf"), GpuClass::None) {
            Err(DiarizeError::ModelMissing(name)) => assert_eq!(name, "absent.gguf"),
            Err(e) => panic!("expected ModelMissing, got {e}"),
            Ok(_) => panic!("expected ModelMissing, got a context"),
        }
    }

    #[test]
    fn load_reports_a_file_that_is_not_a_model() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-a-model.gguf");
        std::fs::write(&path, b"not a gguf file").unwrap();
        match NemotronDiarizer::load(&path, GpuClass::None) {
            Err(DiarizeError::ModelLoad { model, .. }) => assert_eq!(model, "not-a-model.gguf"),
            Err(e) => panic!("expected ModelLoad, got {e}"),
            Ok(_) => panic!("expected ModelLoad, got a context"),
        }
    }

    #[test]
    fn load_rejects_a_thread_count_below_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.gguf");
        std::fs::write(&path, b"x").unwrap();
        for n in [0, -4] {
            match NemotronDiarizer::load_with_threads(&path, GpuClass::None, n) {
                Err(DiarizeError::ModelLoad { detail, .. }) => {
                    assert!(detail.contains(&n.to_string()), "{detail}")
                }
                Err(e) => panic!("expected ModelLoad, got {e}"),
                Ok(_) => panic!("expected ModelLoad, got a context"),
            }
        }
    }

    #[test]
    fn mock_diarizer_splits_the_buffer_into_equal_turns() {
        let mut d = MockDiarizer::new(3);
        let cancel = DecodeCancel::default();
        let turns = d.diarize(&vec![0.0; 9 * 16_000], &cancel).unwrap();
        assert_eq!(
            turns,
            vec![turn(0, 3000, 0), turn(3000, 6000, 1), turn(6000, 9000, 2)]
        );
        assert!(d.diarize(&[], &cancel).unwrap().is_empty());
        assert_eq!(MockDiarizer::new(0).n_speakers, 1);
    }
}
