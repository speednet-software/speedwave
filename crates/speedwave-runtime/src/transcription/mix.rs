//! Pairs two 16 kHz mono PCM streams (system + mic), shared by macOS/Windows (ADR-056 #15).
//! Buffers by absolute index, pops aligned channel pairs once both catch up or on `finish()`;
//! each source is boost-only levelled and clamped, never summed (Amendment 9).

use std::sync::Mutex;
use std::time::Duration;

use super::audio::{
    rms, AudioChunk, CaptureError, CaptureHealth, CaptureWarning, ZeroStreakDetector,
    CHUNK_DURATION, SAMPLE_RATE_HZ,
};

/// Target per-source loudness of active audio (−20 dBFS RMS) —
/// a far-field mic must not vanish under a loud system stream.
const LEVEL_TARGET_RMS: f32 = 0.1;

/// Chunks below this RMS (−50 dBFS) never adapt the level estimate: noise
/// floors and pauses must not drive the boost.
const LEVEL_ACTIVITY_FLOOR: f32 = 0.003;

/// Boost ceiling (+18 dB). Boost-only: a hot source is never attenuated.
const LEVEL_MAX_BOOST: f32 = 8.0;

/// Time constant of the active-RMS estimate, in seconds of active audio.
const LEVEL_EMA_SECS: f32 = 3.0;

/// Per-source boost-only levelling toward [`LEVEL_TARGET_RMS`].
#[derive(Debug, Default)]
struct LevelBalancer {
    /// EMA of the source's above-floor RMS; `None` until the first active chunk.
    active_rms: Option<f32>,
}

impl LevelBalancer {
    /// Feeds one chunk and returns the gain to apply to it. The gain holds
    /// through pauses (the estimate only moves on above-floor audio).
    fn gain(&mut self, samples: &[f32]) -> f32 {
        let level = rms(samples);
        if level > LEVEL_ACTIVITY_FLOOR {
            let alpha = (samples.len() as f32 / (SAMPLE_RATE_HZ as f32 * LEVEL_EMA_SECS)).min(1.0);
            self.active_rms = Some(match self.active_rms {
                None => level,
                Some(prev) => prev + alpha * (level - prev),
            });
        }
        match self.active_rms {
            Some(est) => (LEVEL_TARGET_RMS / est).clamp(1.0, LEVEL_MAX_BOOST),
            None => 1.0,
        }
    }
}

/// Hard cap on buffered samples per side — ~1 minute at 16 kHz. A larger declared offset
/// (e.g. a corrupt timestamp) is refused rather than driving an unbounded allocation.
const MAX_BUFFERED_SAMPLES: usize = SAMPLE_RATE_HZ as usize * 60;

/// How long `poll_paired_chunk` polls a stalled buffer before treating the
/// capture as dead and returning an error.
const STALL_GIVE_UP: Duration = Duration::from_secs(2);

/// One side lagging this far behind the other (5 s of samples) is treated as
/// dead: the mix keeps flowing from the healthy side instead of stalling.
const DEAD_GAP_SAMPLES: u64 = SAMPLE_RATE_HZ as u64 * 5;

/// Poll cadence for `poll_paired_chunk` (well under the ~200 ms chunk interval).
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Roughly one `CHUNK_DURATION` of samples — the target size of an emitted chunk.
pub const CHUNK_SAMPLES: usize = {
    let v = SAMPLE_RATE_HZ as u128 * CHUNK_DURATION.as_millis() / 1000;
    if v < 1 {
        1
    } else {
        v as usize
    }
};

/// Which of the two streams a pushed buffer belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MixSource {
    /// System loopback ("the other side").
    System,
    /// Microphone ("your side").
    Mic,
}

/// A bounded buffer that mixes two 16 kHz mono streams keyed by absolute sample
/// index. One per mixed capture; capped at `MAX_BUFFERED_SAMPLES` per side.
pub struct MixBuffer {
    /// System samples not yet popped, starting at sample index `base`.
    sys: Vec<f32>,
    /// Mic samples not yet popped, starting at sample index `base`.
    mic: Vec<f32>,
    /// Absolute sample index of `sys[0]` / `mic[0]` (samples already popped).
    base: u64,
    /// Highest absolute sample index the system stream has delivered (exclusive).
    sys_filled: u64,
    /// Highest absolute sample index the mic stream has delivered (exclusive).
    mic_filled: u64,
    /// `true` once a stream signals end-of-input — `pop` then drains whatever is
    /// left without waiting for the other side.
    finished: bool,
    /// Side currently treated as dead (lagging > [`DEAD_GAP_SAMPLES`]), if any.
    lagging: Option<MixSource>,
    /// Levelling state for the system side.
    sys_level: LevelBalancer,
    /// Levelling state for the mic side.
    mic_level: LevelBalancer,
    /// One-shot all-zeros detection for the system side (shared mechanism).
    zero: ZeroStreakDetector,
    /// Health transitions not yet drained by `take_health`.
    pending_health: Vec<CaptureHealth>,
}

impl Default for MixBuffer {
    fn default() -> Self {
        Self::new()
    }
}

/// The stall warning corresponding to a mix side.
fn stall_warning(side: MixSource) -> CaptureWarning {
    match side {
        MixSource::Mic => CaptureWarning::MicrophoneStalled,
        MixSource::System => CaptureWarning::SystemAudioStalled,
    }
}

impl MixBuffer {
    /// New empty buffer.
    pub fn new() -> Self {
        Self {
            sys: Vec::new(),
            mic: Vec::new(),
            base: 0,
            sys_filled: 0,
            mic_filled: 0,
            finished: false,
            lagging: None,
            sys_level: LevelBalancer::default(),
            mic_level: LevelBalancer::default(),
            zero: ZeroStreakDetector::default(),
            pending_health: Vec::new(),
        }
    }

    /// Converts an offset-from-start to an absolute sample index at 16 kHz.
    fn index_of(offset_ns: u64) -> u64 {
        offset_ns.saturating_mul(SAMPLE_RATE_HZ as u64) / 1_000_000_000
    }

    /// Pushes `samples` for `source`, starting at `offset_ns` from the recording start.
    /// Placed by index; before `base` or past `MAX_BUFFERED_SAMPLES` is dropped (watermark bumped).
    pub fn push(&mut self, source: MixSource, offset_ns: u64, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        let start = Self::index_of(offset_ns);
        let end = start.saturating_add(samples.len() as u64);
        // Index of the first sample we still keep.
        let keep_from = start.max(self.base);
        let skip = (keep_from - start) as usize;
        if skip >= samples.len() {
            // Entirely in the past, but advance watermark to avoid false stall detection.
            self.bump_filled(source, end);
            return;
        }
        let rel = (keep_from - self.base) as usize; // offset into sys/mic Vec
        let needed = rel + (samples.len() - skip);
        if needed > MAX_BUFFERED_SAMPLES {
            // Consumer too far behind or timestamp bogus; drop payload but record watermark.
            log::warn!(
                target: "transcription::mix",
                "{source:?} push at offset {offset_ns}ns would buffer {needed} samples (cap {MAX_BUFFERED_SAMPLES}) — dropped"
            );
            self.bump_filled(source, end);
            return;
        }
        // Feed the silence detector only the samples actually kept — a discarded (stale or
        // over-cap) push must not skew the all-zero streak either way.
        if source == MixSource::System {
            if let Some(t) = self.zero.feed(&samples[skip..]) {
                self.pending_health.push(t);
            }
        }
        // Past the drop checks: the balancer only ever adapts to audio that
        // actually lands in the mix.
        let gain = match source {
            MixSource::System => self.sys_level.gain(&samples[skip..]),
            MixSource::Mic => self.mic_level.gain(&samples[skip..]),
        };
        let buf = match source {
            MixSource::System => &mut self.sys,
            MixSource::Mic => &mut self.mic,
        };
        if buf.len() < needed {
            buf.resize(needed, 0.0);
        }
        for (i, &s) in samples[skip..].iter().enumerate() {
            buf[rel + i] += s * gain; // additive so overlapping pushes within a stream sum
        }
        self.bump_filled(source, end);
    }

    fn bump_filled(&mut self, source: MixSource, end: u64) {
        match source {
            MixSource::System => self.sys_filled = self.sys_filled.max(end),
            MixSource::Mic => self.mic_filled = self.mic_filled.max(end),
        }
        self.refresh_health();
    }

    /// Re-evaluates the lag state after a watermark change; queues one-shot
    /// transitions and logs them only (never per push).
    fn refresh_health(&mut self) {
        let gap = self.sys_filled.abs_diff(self.mic_filled);
        let lagging_side = if self.sys_filled < self.mic_filled {
            MixSource::System
        } else {
            MixSource::Mic
        };
        let now_lagging = (gap > DEAD_GAP_SAMPLES)
            .then_some(lagging_side)
            // A never-delivering system side is a quiet start (idle loopback), not a stall.
            .filter(|s| !(*s == MixSource::System && self.sys_filled == 0));
        if now_lagging == self.lagging {
            return;
        }
        if let Some(old) = self.lagging {
            log::info!(target: "transcription::mix", "stalled {old:?} side caught back up");
            self.pending_health
                .push(CaptureHealth::Cleared(stall_warning(old)));
        }
        if let Some(new) = now_lagging {
            log::warn!(target: "transcription::mix", "{new:?} stream stalled — continuing with the other side only");
            self.pending_health
                .push(CaptureHealth::Raised(stall_warning(new)));
        }
        self.lagging = now_lagging;
    }

    /// Drains health transitions queued since the last call.
    pub fn take_health(&mut self) -> Vec<CaptureHealth> {
        std::mem::take(&mut self.pending_health)
    }

    /// Marks the input finished — subsequent `pop`s drain remaining samples
    /// without waiting for the other side, and `pop` returns `None` when empty.
    pub fn finish(&mut self) {
        self.finished = true;
    }

    /// Emittable index: the slower side's watermark, except a side lagging >
    /// [`DEAD_GAP_SAMPLES`] stops gating (dead mic/tap must not stall the mix).
    fn ready_until(&self) -> u64 {
        if self.finished {
            return self.base + self.sys.len().max(self.mic.len()) as u64;
        }
        let lo = self.sys_filled.min(self.mic_filled);
        let hi = self.sys_filled.max(self.mic_filled);
        lo.max(hi.saturating_sub(DEAD_GAP_SAMPLES))
    }

    /// Pops the next aligned channel pair of up to `max_samples`, or `None` if fewer than
    /// `min_samples` are ready (unless finished, then it returns the remainder). Both sides
    /// come back `take`-long (the shorter zero-padded) and clamped to ±1.
    pub fn pop_pair(
        &mut self,
        min_samples: usize,
        max_samples: usize,
    ) -> Option<(Vec<f32>, Vec<f32>)> {
        debug_assert!(
            min_samples <= max_samples,
            "min_samples must be ≤ max_samples"
        );
        let available = self.ready_until().saturating_sub(self.base) as usize;
        if available == 0 || (available < min_samples && !self.finished) {
            return None;
        }
        let take = available.min(max_samples);
        let pad = |buf: &[f32]| -> Vec<f32> {
            let mut out = Vec::with_capacity(take);
            for i in 0..take {
                out.push(buf.get(i).copied().unwrap_or(0.0).clamp(-1.0, 1.0));
            }
            out
        };
        let sys = pad(&self.sys[..take.min(self.sys.len())]);
        let mic = pad(&self.mic[..take.min(self.mic.len())]);
        let drop_sys = take.min(self.sys.len());
        self.sys.drain(..drop_sys);
        let drop_mic = take.min(self.mic.len());
        self.mic.drain(..drop_mic);
        self.base += take as u64;
        Some((sys, mic))
    }

    /// The current running offset in nanoseconds (start of the next chunk).
    pub fn offset_ns(&self) -> u64 {
        self.base.saturating_mul(1_000_000_000) / SAMPLE_RATE_HZ as u64
    }
}

/// The shared `AudioStream::next_chunk` body for a mixed capture fed from background threads.
/// Polls for a full chunk; drains the tail and errors after `STALL_GIVE_UP`, or `Ok(None)` on EOF.
pub fn poll_paired_chunk(buf: &Mutex<MixBuffer>) -> Result<Option<AudioChunk>, CaptureError> {
    let want = CHUNK_SAMPLES;
    let mut waited = Duration::ZERO;
    loop {
        match buf.lock() {
            Ok(mut b) => {
                let start_ns = b.offset_ns();
                // On stall, drain tail first so it isn't lost.
                let chunk = b.pop_pair(want, want).or_else(|| {
                    (waited >= STALL_GIVE_UP)
                        .then(|| b.pop_pair(1, want))
                        .flatten()
                });
                if let Some((sys, mic)) = chunk {
                    return Ok(Some(AudioChunk {
                        samples: sys,
                        mic: Some(mic),
                        offset: Duration::from_nanos(start_ns),
                    }));
                }
                // Empty + finished = clean end of stream.
                let drained_and_finished = b.is_finished_and_empty();
                drop(b);
                if drained_and_finished {
                    return Ok(None);
                }
            }
            Err(_) => {
                // Reader thread panicked; treat capture as dead.
                log::warn!(target: "transcription::mix", "mix buffer poisoned — capture stopped");
                return Err(CaptureError::Failed("mix buffer poisoned".to_string()));
            }
        }
        if waited >= STALL_GIVE_UP {
            return Err(CaptureError::Failed(
                "audio capture stalled — both streams stopped without a clean end-of-stream"
                    .to_string(),
            ));
        }
        std::thread::sleep(POLL_INTERVAL);
        waited += POLL_INTERVAL;
    }
}

impl MixBuffer {
    /// `true` when `finish()` was called and no buffered samples remain — i.e.
    /// the stream has cleanly ended.
    fn is_finished_and_empty(&self) -> bool {
        self.finished && self.sys.is_empty() && self.mic.is_empty()
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, clippy::expect_used, reason = "test code")]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn chunk_samples_is_one_chunk_duration_at_16khz() {
        // 16 kHz × 200 ms = 3200 samples.
        assert_eq!(CHUNK_SAMPLES, 3_200);
    }

    #[test]
    fn pop_pair_waits_for_both_streams_then_pairs() {
        let mut b = MixBuffer::new();
        // 16 samples = 1 ms at 16 kHz. Push 1 ms of system at offset 0.
        b.push(MixSource::System, 0, &[1.0; 16]);
        // Mic hasn't caught up — nothing ready.
        assert_eq!(b.pop_pair(1, 1000), None);
        b.push(MixSource::Mic, 0, &[1.0; 16]);
        let (sys, mic) = b.pop_pair(1, 1000).unwrap();
        assert_eq!(sys.len(), 16);
        assert_eq!(mic.len(), 16);
        assert!(sys.iter().all(|&s| (s - 1.0).abs() < 1e-6));
        assert!(mic.iter().all(|&s| (s - 1.0).abs() < 1e-6));
        assert_eq!(b.pop_pair(1, 1000), None); // drained
        assert_eq!(b.offset_ns(), 1_000_000); // 16 samples → 1 ms
    }

    #[test]
    fn pop_pair_returns_channels_unmixed_and_clamped() {
        let mut b = MixBuffer::new();
        b.push(MixSource::System, 0, &[1.0, 0.5, -0.5, 0.0]);
        b.push(MixSource::Mic, 0, &[1.0, 0.5, 0.5, 0.0]);
        let (sys, mic) = b.pop_pair(1, 1000).unwrap();
        assert_eq!(sys, vec![1.0, 0.5, -0.5, 0.0]);
        assert_eq!(mic, vec![1.0, 0.5, 0.5, 0.0]);
        // Boundary clamp: -1.0 on each side stays -1.0.
        let mut b2 = MixBuffer::new();
        b2.push(MixSource::System, 0, &[-1.0]);
        b2.push(MixSource::Mic, 0, &[-1.0]);
        let (sys2, mic2) = b2.pop_pair(1, 1).unwrap();
        assert_eq!(sys2, vec![-1.0]);
        assert_eq!(mic2, vec![-1.0]);
    }

    #[test]
    fn pop_zero_pads_a_shorter_side() {
        let mut b = MixBuffer::new();
        // System 3 samples of 1.0, mic 1 sample of 1.0, then mic EOF.
        b.push(MixSource::System, 0, &[1.0; 3]);
        b.push(MixSource::Mic, 0, &[1.0]);
        b.finish();
        let (sys, mic) = b.pop_pair(1, 1000).unwrap();
        assert_eq!(sys, vec![1.0, 1.0, 1.0]);
        assert_eq!(mic, vec![1.0, 0.0, 0.0]);
    }

    #[test]
    fn pop_respects_min_and_max_samples() {
        let mut b = MixBuffer::new();
        b.push(MixSource::System, 0, &[0.2; 100]);
        b.push(MixSource::Mic, 0, &[0.0; 100]);
        assert_eq!(b.pop_pair(200, 1000), None); // min not met (only 100 available)
        let (sys, _mic) = b.pop_pair(30, 30).unwrap(); // min met, capped at 30
        assert_eq!(sys.len(), 30);
        let (sys2, _mic2) = b.pop_pair(1, 1000).unwrap();
        assert_eq!(sys2.len(), 70);
    }

    #[test]
    fn finish_drains_remaining_without_waiting_for_the_other_side() {
        let mut b = MixBuffer::new();
        b.push(MixSource::System, 0, &[0.5; 10]);
        assert_eq!(b.pop_pair(1, 1000), None); // mic never arrives → nothing pops
        b.finish();
        let (sys, mic) = b.pop_pair(1, 1000).unwrap();
        assert_eq!(sys.len(), 10);
        assert!(sys.iter().all(|&s| (s - 0.5).abs() < 1e-6));
        assert!(mic.iter().all(|&s| s == 0.0));
        assert_eq!(b.pop_pair(1, 1000), None);
        assert!(b.is_finished_and_empty());
    }

    #[test]
    fn push_in_the_past_is_dropped_but_bumps_watermark() {
        let mut b = MixBuffer::new();
        b.push(MixSource::System, 0, &[1.0; 32]);
        b.push(MixSource::Mic, 0, &[0.0; 32]);
        let _ = b.pop_pair(1, 32).unwrap(); // base now 32
                                            // Late buffer at offset 0 — dropped; watermark bumped.
        b.push(MixSource::System, 0, &[9.9; 16]);
        assert_eq!(b.pop_pair(1, 1000), None);
        // A fresh in-future buffer (offset 2 ms = index 32) pops normally.
        b.push(MixSource::System, 2_000_000, &[0.4; 16]);
        b.push(MixSource::Mic, 2_000_000, &[0.0; 16]);
        let (sys, _mic) = b.pop_pair(1, 1000).unwrap();
        assert_eq!(sys.len(), 16);
        // 0.4 RMS > LEVEL_TARGET_RMS (0.1) → gain 1.0.
        assert!(sys.iter().all(|&s| (s - 0.4).abs() < 1e-6));
    }

    #[test]
    fn push_over_the_cap_is_dropped() {
        let mut b = MixBuffer::new();
        // An offset of 1 hour ≫ the 1-minute cap → the payload is dropped.
        let one_hour_ns: u64 = 3600 * 1_000_000_000;
        b.push(MixSource::System, one_hour_ns, &[1.0; 16]);
        // Nothing buffered; the side's vec stays empty.
        b.finish();
        assert_eq!(b.pop_pair(1, 1000), None);
        // A within-cap push still works.
        let mut b2 = MixBuffer::new();
        b2.push(MixSource::System, 0, &[1.0; 16]);
        b2.push(MixSource::Mic, 0, &[0.0; 16]);
        assert_eq!(b2.pop_pair(1, 1000).unwrap().0.len(), 16);
    }

    #[test]
    fn dropped_pushes_do_not_adapt_the_level_estimate() {
        let mut b = MixBuffer::new();
        // A loud over-cap push is dropped — it must not seed the balancer.
        let one_hour_ns: u64 = 3600 * 1_000_000_000;
        b.push(MixSource::System, one_hour_ns, &[0.5; 16]);
        // The first kept chunk (quiet but active) seeds the estimate fresh and
        // gets the full boost, as if the dropped chunk never existed.
        b.push(MixSource::System, 0, &[0.01; 16]);
        b.push(MixSource::Mic, 0, &[0.0; 16]);
        let (sys, _mic) = b.pop_pair(1, 16).unwrap();
        // Estimate seeds at 0.01 → wants 10×, clamps to 8×; 0.01·8 = 0.08.
        assert!(sys.iter().all(|&s| (s - 0.08).abs() < 1e-6));
    }

    #[test]
    fn overlapping_pushes_within_a_stream_sum() {
        let mut b = MixBuffer::new();
        b.push(MixSource::System, 0, &[0.1; 16]);
        b.push(MixSource::System, 0, &[0.2; 16]); // same range → 0.3
        b.push(MixSource::Mic, 0, &[0.0; 16]);
        let (sys, _mic) = b.pop_pair(1, 16).unwrap();
        assert!(sys.iter().all(|&s| (s - 0.3).abs() < 1e-6));
    }

    #[test]
    fn offset_ns_tracks_popped_samples() {
        let mut b = MixBuffer::new();
        assert_eq!(b.offset_ns(), 0);
        b.push(MixSource::System, 0, &[0.0; 16_000]); // 1 s
        b.push(MixSource::Mic, 0, &[0.0; 16_000]);
        let _ = b.pop_pair(1, 8_000).unwrap();
        assert_eq!(b.offset_ns(), 500_000_000); // 8000 / 16000 s
    }

    #[test]
    fn a_dead_side_stops_gating_after_the_gap_and_warns_once() {
        let mut b = MixBuffer::new();
        // Mic never delivers; system pushes 6 s (> 5 s gap) of audio.
        let six_secs = SAMPLE_RATE_HZ as usize * 6;
        b.push(MixSource::System, 0, &vec![0.8; six_secs]);
        let (sys, mic) = b.pop_pair(1, six_secs).expect("mix flows without the mic");
        // ready = 6s − 5s gap = 1s; mic side pads as zeros.
        assert_eq!(sys.len(), SAMPLE_RATE_HZ as usize);
        assert!(sys.iter().all(|&s| (s - 0.8).abs() < 1e-6));
        assert!(mic.iter().all(|&s| s == 0.0));
        assert_eq!(
            b.take_health(),
            vec![CaptureHealth::Raised(CaptureWarning::MicrophoneStalled)]
        );
        assert_eq!(b.take_health(), vec![]); // drained — one-shot
    }

    #[test]
    fn a_dead_system_side_warns_with_the_system_variant() {
        let mut b = MixBuffer::new();
        // System delivered 1 s, then died; mic runs on to 7 s (gap > 5 s).
        b.push(MixSource::System, 0, &vec![0.8; SAMPLE_RATE_HZ as usize]);
        let seven_secs = SAMPLE_RATE_HZ as usize * 7;
        b.push(MixSource::Mic, 0, &vec![0.8; seven_secs]);
        assert!(b.pop_pair(1, seven_secs).is_some());
        assert_eq!(
            b.take_health(),
            vec![CaptureHealth::Raised(CaptureWarning::SystemAudioStalled)]
        );
    }

    #[test]
    fn a_system_side_that_never_started_is_a_quiet_start_not_a_stall() {
        let mut b = MixBuffer::new();
        // Idle Windows loopback: no system packets at all. Mix must flow from
        // the mic without a spurious SystemAudioStalled warning.
        let six_secs = SAMPLE_RATE_HZ as usize * 6;
        b.push(MixSource::Mic, 0, &vec![0.8; six_secs]);
        assert!(b.pop_pair(1, six_secs).is_some());
        assert_eq!(b.take_health(), vec![]);
    }

    #[test]
    fn a_revived_side_regates_and_mixes_again() {
        let mut b = MixBuffer::new();
        let six_secs = SAMPLE_RATE_HZ as usize * 6;
        b.push(MixSource::System, 0, &vec![0.8; six_secs]);
        let _ = b.pop_pair(1, six_secs).unwrap();
        let _ = b.take_health();
        // Mic revives at the current offset (6 s): gap closes, min-gating returns
        // and the stall banner is recovered.
        b.push(MixSource::Mic, 6_000_000_000, &[0.8; 16]);
        assert_eq!(
            b.take_health(),
            vec![CaptureHealth::Cleared(CaptureWarning::MicrophoneStalled)]
        );
        // 6s+16 samples on mic vs 6s on sys → gap 16 ≪ DEAD_GAP → gate = min.
        let (sys, mic) = b.pop_pair(1, usize::MAX).unwrap();
        // Drains up to sys_filled (6 s) minus already-popped base (1 s) = 5 s.
        assert_eq!(sys.len(), SAMPLE_RATE_HZ as usize * 5);
        assert!(sys.iter().all(|&s| (s - 0.8).abs() < 1e-6));
        assert!(mic.iter().all(|&s| s == 0.0));
        b.push(MixSource::System, 6_000_000_000, &[0.8; 16]);
        let (sys2, mic2) = b.pop_pair(1, usize::MAX).unwrap();
        assert_eq!(sys2.len(), 16);
        assert!(sys2.iter().all(|&s| (s - 0.8).abs() < 1e-6));
        assert!(mic2.iter().all(|&s| (s - 0.8).abs() < 1e-6));
    }

    #[test]
    fn all_zero_system_audio_warns_once_after_the_threshold() {
        let mut b = MixBuffer::new();
        let chunk = vec![0.0f32; SAMPLE_RATE_HZ as usize]; // 1 s
        for i in 0..16u64 {
            b.push(MixSource::System, i * 1_000_000_000, &chunk);
            b.push(MixSource::Mic, i * 1_000_000_000, &chunk);
            let _ = b.pop_pair(1, usize::MAX);
        }
        let w = b.take_health();
        assert_eq!(
            w,
            vec![CaptureHealth::Raised(CaptureWarning::SystemAudioSilent)]
        );
        // More zeros never re-trigger the one-shot.
        b.push(MixSource::System, 17_000_000_000, &chunk);
        assert_eq!(b.take_health(), vec![]);
    }

    #[test]
    fn nonzero_system_audio_never_warns_silent() {
        let mut b = MixBuffer::new();
        let mut chunk = vec![0.0f32; SAMPLE_RATE_HZ as usize];
        chunk[7] = 0.01; // any single non-zero sample counts as signal
        b.push(MixSource::System, 0, &chunk);
        let zeros = vec![0.0f32; SAMPLE_RATE_HZ as usize];
        for i in 1..17u64 {
            b.push(MixSource::System, i * 1_000_000_000, &zeros);
            b.push(MixSource::Mic, (i - 1) * 1_000_000_000, &zeros);
            let _ = b.pop_pair(1, usize::MAX);
        }
        assert_eq!(b.take_health(), vec![]);
    }

    #[test]
    fn a_stale_duplicate_zero_push_does_not_count_toward_the_silence_streak() {
        let mut b = MixBuffer::new();
        let chunk = vec![0.0f32; SAMPLE_RATE_HZ as usize]; // 1 s
        for i in 0..14u64 {
            b.push(MixSource::System, i * 1_000_000_000, &chunk);
            b.push(MixSource::Mic, i * 1_000_000_000, &chunk);
            let _ = b.pop_pair(1, usize::MAX);
        }
        // Re-push an already-popped (entirely stale) range many times — a re-anchor
        // or retry replaying old offsets must not advance the streak at all.
        for _ in 0..10 {
            b.push(MixSource::System, 0, &chunk);
        }
        assert_eq!(
            b.take_health(),
            vec![],
            "stale re-delivery must not fast-forward the 15 s silence threshold"
        );
    }

    #[test]
    fn a_quiet_source_is_boosted_toward_the_target() {
        let mut b = MixBuffer::new();
        // Mic speech at RMS 0.02 (under LEVEL_TARGET_RMS) → 5× boost.
        b.push(MixSource::Mic, 0, &[0.02; 1600]);
        b.push(MixSource::System, 0, &[0.0; 1600]);
        let (_sys, mic) = b.pop_pair(1, 1600).unwrap();
        // 0.02 × 5 (boost) = 0.1
        assert!(
            mic.iter().all(|&s| (s - 0.1).abs() < 1e-4),
            "got {:?}",
            &mic[..3]
        );
    }

    #[test]
    fn an_over_cap_dropped_nonzero_push_does_not_clear_an_active_silence_warning() {
        let mut b = MixBuffer::new();
        let chunk = vec![0.0f32; SAMPLE_RATE_HZ as usize]; // 1 s
        for i in 0..16u64 {
            b.push(MixSource::System, i * 1_000_000_000, &chunk);
            b.push(MixSource::Mic, i * 1_000_000_000, &chunk);
            let _ = b.pop_pair(1, usize::MAX);
        }
        assert_eq!(
            b.take_health(),
            vec![CaptureHealth::Raised(CaptureWarning::SystemAudioSilent)]
        );
        // A non-zero push that lands entirely past the buffering cap is dropped —
        // it must not be treated as "signal arrived" and clear the warning. (The
        // bogus watermark legitimately raises a mic-stall; only Cleared matters here.)
        let one_hour_ns: u64 = 3600 * 1_000_000_000;
        b.push(MixSource::System, one_hour_ns, &[1.0; 16]);
        let health = b.take_health();
        assert!(
            !health.contains(&CaptureHealth::Cleared(CaptureWarning::SystemAudioSilent)),
            "a discarded over-cap push must not clear the silence warning: {health:?}"
        );
    }

    #[test]
    fn a_quiet_system_side_is_boosted_too() {
        let mut b = MixBuffer::new();
        b.push(MixSource::System, 0, &[0.02; 1600]);
        b.push(MixSource::Mic, 0, &[0.0; 1600]);
        let (sys, _mic) = b.pop_pair(1, 1600).unwrap();
        assert!(
            sys.iter().all(|&s| (s - 0.1).abs() < 1e-4),
            "got {:?}",
            &sys[..3]
        );
    }

    #[test]
    fn boost_is_capped_at_the_maximum() {
        let mut b = MixBuffer::new();
        // RMS 0.005 wants a 20× boost — clamps to LEVEL_MAX_BOOST (8×).
        b.push(MixSource::Mic, 0, &[0.005; 1600]);
        b.push(MixSource::System, 0, &[0.0; 1600]);
        let (_sys, mic) = b.pop_pair(1, 1600).unwrap();
        // 0.005 × 8 = 0.04
        assert!(
            mic.iter().all(|&s| (s - 0.04).abs() < 1e-4),
            "got {:?}",
            &mic[..3]
        );
    }

    #[test]
    fn a_loud_source_is_never_attenuated() {
        let mut b = MixBuffer::new();
        b.push(MixSource::Mic, 0, &[0.4; 1600]);
        b.push(MixSource::System, 0, &[0.0; 1600]);
        let (_sys, mic) = b.pop_pair(1, 1600).unwrap();
        // Gain clamps at 1.0 from below: 0.4 × 1 = 0.4.
        assert!(
            mic.iter().all(|&s| (s - 0.4).abs() < 1e-4),
            "got {:?}",
            &mic[..3]
        );
    }

    #[test]
    fn noise_below_the_activity_floor_never_drives_the_boost() {
        let mut b = MixBuffer::new();
        // A -60 dBFS noise floor stays below LEVEL_ACTIVITY_FLOOR over many chunks.
        for i in 0..20u64 {
            b.push(MixSource::Mic, i * 100_000_000, &[0.001; 1600]);
            b.push(MixSource::System, i * 100_000_000, &[0.0; 1600]);
        }
        let (_sys, mic) = b.pop_pair(1, usize::MAX).unwrap();
        // No estimate formed → unity gain: 0.001.
        assert!(
            mic.iter().all(|&s| (s - 0.001).abs() < 1e-5),
            "got {:?}",
            &mic[..3]
        );
    }

    #[test]
    fn gain_holds_through_silence_between_utterances() {
        let mut b = MixBuffer::new();
        b.push(MixSource::Mic, 0, &[0.02; 1600]);
        b.push(MixSource::Mic, 100_000_000, &[0.0; 1600]); // pause
        b.push(MixSource::Mic, 200_000_000, &[0.02; 1600]); // same level again
        b.push(MixSource::System, 0, &[0.0; 4800]);
        let (_sys, mic) = b.pop_pair(1, usize::MAX).unwrap();
        // Both utterances get the held 5× boost; the pause stays zero.
        assert!(mic[..1600].iter().all(|&s| (s - 0.1).abs() < 1e-4));
        assert!(mic[1600..3200].iter().all(|&s| s.abs() < 1e-6));
        assert!(mic[3200..].iter().all(|&s| (s - 0.1).abs() < 1e-4));
    }

    #[test]
    fn the_estimate_adapts_when_the_source_gets_louder() {
        let mut b = MixBuffer::new();
        b.push(MixSource::Mic, 0, &[0.02; 16_000]); // 1 s at RMS 0.02 → est 0.02
        for i in 1..9u64 {
            // 8 s at RMS 0.1 pull the estimate up; gain decays toward 1×.
            b.push(MixSource::Mic, i * 1_000_000_000, &[0.1; 16_000]);
        }
        b.push(MixSource::System, 0, &[0.0; 16_000 * 9]);
        let (_sys, mic) = b.pop_pair(1, usize::MAX).unwrap();
        let first = mic[0]; // 0.02 × 5 = 0.1
        let last = mic[mic.len() - 1];
        assert!((first - 0.1).abs() < 1e-4, "first {first}");
        // After ~8 s of louder audio the boost has decayed close to unity:
        // 0.1 × gain with gain ≈ 1.03 → just above 0.1.
        assert!(last > 0.098 && last < 0.112, "last {last}");
    }

    #[test]
    fn poll_paired_chunk_returns_a_chunk_once_both_sides_are_ready() {
        let buf = Arc::new(Mutex::new(MixBuffer::new()));
        let want = CHUNK_SAMPLES;
        // A feeder thread pushes one full chunk on each side after a beat.
        let feeder = {
            let buf = Arc::clone(&buf);
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(30));
                let mut b = buf.lock().unwrap();
                b.push(MixSource::System, 0, &vec![1.0; want]);
                b.push(MixSource::Mic, 0, &vec![1.0; want]);
            })
        };
        let chunk = poll_paired_chunk(&buf)
            .unwrap()
            .expect("a chunk is delivered");
        assert_eq!(chunk.samples.len(), want);
        assert!(chunk.samples.iter().all(|&s| (s - 1.0).abs() < 1e-6));
        let mic = chunk.mic.expect("mic channel present");
        assert_eq!(mic.len(), want);
        assert!(mic.iter().all(|&s| (s - 1.0).abs() < 1e-6));
        feeder.join().unwrap();
    }

    #[test]
    fn poll_paired_chunk_returns_none_on_clean_eof() {
        let buf = Arc::new(Mutex::new(MixBuffer::new()));
        // No data ever pushed; one side immediately marks finished.
        buf.lock().unwrap().finish();
        // First poll: empty + finished → Ok(None) right away.
        assert!(poll_paired_chunk(&buf).unwrap().is_none());
    }

    #[test]
    fn poll_paired_chunk_drains_the_tail_then_errors_on_stall() {
        let buf = Arc::new(Mutex::new(MixBuffer::new()));
        // A sub-chunk tail, never finished, never more data: poll drains it once the stall
        // window elapses, then errors on the next poll (nothing left, no clean EOF).
        {
            let mut b = buf.lock().unwrap();
            b.push(MixSource::System, 0, &[1.0; 8]);
            b.push(MixSource::Mic, 0, &[1.0; 8]);
        }
        let tail = poll_paired_chunk(&buf)
            .unwrap()
            .expect("the tail is drained");
        assert_eq!(tail.samples.len(), 8);
        assert!(tail.samples.iter().all(|&s| (s - 1.0).abs() < 1e-6));
        let mic = tail.mic.expect("mic channel present");
        assert_eq!(mic.len(), 8);
        assert!(mic.iter().all(|&s| (s - 1.0).abs() < 1e-6));
        let err = poll_paired_chunk(&buf).unwrap_err();
        assert!(matches!(err, CaptureError::Failed(_)));
    }

    #[test]
    fn poll_paired_chunk_errors_on_a_poisoned_buffer() {
        let buf = Arc::new(Mutex::new(MixBuffer::new()));
        // Poison the mutex by panicking while holding the lock.
        let b2 = Arc::clone(&buf);
        let _ = thread::spawn(move || {
            let _g = b2.lock().unwrap();
            panic!("boom");
        })
        .join();
        let err = poll_paired_chunk(&buf).unwrap_err();
        assert!(matches!(err, CaptureError::Failed(_)));
    }
}
