//! Mixing two 16 kHz mono PCM streams (system loopback + microphone) into one,
//! shared by the macOS / Windows / Linux capture backends (ADR-056 decision 15).
//!
//! The two sources don't arrive in lock-step — a muted mic delivers nothing, a
//! silent system delivers near-zero, and OS buffering means one can run ahead of
//! the other. `MixBuffer` accumulates samples per source by absolute sample
//! index (offset → index, at 16 kHz) and pops the next chunk once *both* have
//! reached that far, or — once `finish()` has been called — drains whatever is
//! left (so a quiet side never stalls the stream forever). Overlapping samples
//! are summed with a fixed 0.5/0.5 gain and clamped to `[-1.0, 1.0]`.

/// 16 kHz — the only rate this module works in.
const SAMPLE_RATE: u64 = 16_000;

/// Per-source gain applied before summing (so two full-scale signals can't clip
/// past ±1 on their own; the clamp catches the rest).
const MIX_GAIN: f32 = 0.5;

/// Which of the two streams a pushed buffer belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MixSource {
    /// System loopback ("the other side").
    System,
    /// Microphone ("your side").
    Mic,
}

/// Sums two same-length slices element-wise with `MIX_GAIN` on each, clamped to
/// `[-1.0, 1.0]`. The shorter slice is treated as zero-padded to the longer's
/// length. (Standalone so the per-OS backends and tests can use it directly.)
pub fn mix_two(a: &[f32], b: &[f32]) -> Vec<f32> {
    let n = a.len().max(b.len());
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0.0);
        let y = b.get(i).copied().unwrap_or(0.0);
        out.push((x * MIX_GAIN + y * MIX_GAIN).clamp(-1.0, 1.0));
    }
    out
}

/// A bounded buffer that mixes two 16 kHz mono streams keyed by absolute sample
/// index. One per mixed capture.
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
    /// Whether a mic stream exists at all — when `false`, `pop` only waits on the
    /// system stream (a system-only recording reuses this buffer trivially).
    has_mic: bool,
    /// `true` once a stream signals end-of-input — `pop` then drains whatever is
    /// left without waiting for the other side.
    finished: bool,
}

impl MixBuffer {
    /// New buffer. `has_mic = false` means "system only" (mic samples, if ever
    /// pushed, are ignored — they shouldn't be).
    pub fn new(has_mic: bool) -> Self {
        Self {
            sys: Vec::new(),
            mic: Vec::new(),
            base: 0,
            sys_filled: 0,
            mic_filled: 0,
            has_mic,
            finished: false,
        }
    }

    /// Converts an offset-from-start to an absolute sample index at 16 kHz.
    fn index_of(offset_ns: u64) -> u64 {
        offset_ns.saturating_mul(SAMPLE_RATE) / 1_000_000_000
    }

    /// Pushes `samples` for `source`, declared to start at `offset_ns` from the
    /// recording start. Samples before `base` (already popped) are dropped;
    /// samples are placed by index so a reordered or gapped delivery still lands
    /// correctly (gaps stay zero — they were initialised to 0.0).
    pub fn push(&mut self, source: MixSource, offset_ns: u64, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        let start = Self::index_of(offset_ns);
        let end = start + samples.len() as u64;
        // Index of the first sample we still keep.
        let keep_from = start.max(self.base);
        let skip = (keep_from - start) as usize;
        if skip >= samples.len() {
            // Entirely in the past — but still advance the "filled" watermark so
            // a late tiny buffer doesn't make us think the stream stalled.
            self.bump_filled(source, end);
            return;
        }
        let rel = (keep_from - self.base) as usize; // offset into sys/mic Vec
        let buf = match source {
            MixSource::System => &mut self.sys,
            MixSource::Mic => &mut self.mic,
        };
        let needed = rel + (samples.len() - skip);
        if buf.len() < needed {
            buf.resize(needed, 0.0);
        }
        for (i, &s) in samples[skip..].iter().enumerate() {
            buf[rel + i] += s; // additive so overlapping pushes within a stream sum
        }
        self.bump_filled(source, end);
    }

    fn bump_filled(&mut self, source: MixSource, end: u64) {
        match source {
            MixSource::System => self.sys_filled = self.sys_filled.max(end),
            MixSource::Mic => self.mic_filled = self.mic_filled.max(end),
        }
    }

    /// Marks the input finished — subsequent `pop`s drain remaining samples
    /// without waiting for the other side, and `pop` returns `None` when empty.
    pub fn finish(&mut self) {
        self.finished = true;
    }

    /// Absolute sample index up to which both streams are ready (or, if finished,
    /// up to which we actually hold buffered samples — we never emit padding
    /// past real data, that would desync the running offset).
    fn ready_until(&self) -> u64 {
        if self.finished {
            return self.base + self.sys.len().max(self.mic.len()) as u64;
        }
        if self.has_mic {
            self.sys_filled.min(self.mic_filled)
        } else {
            self.sys_filled
        }
    }

    /// Pops the next mixed chunk of up to `max_samples`, or `None` if fewer than
    /// `min_samples` are ready (unless finished, in which case it returns
    /// whatever is left and then `None`). The returned chunk's first sample is at
    /// absolute index `base` *before* the call — the caller tracks the running
    /// offset itself.
    pub fn pop(&mut self, min_samples: usize, max_samples: usize) -> Option<Vec<f32>> {
        let ready = self.ready_until();
        let available = ready.saturating_sub(self.base) as usize;
        if available == 0 {
            return None;
        }
        if available < min_samples && !self.finished {
            return None;
        }
        let take = available.min(max_samples);
        // Build the mixed slice, zero-padding either side that's short.
        let sys_slice: &[f32] = self
            .sys
            .get(..take.min(self.sys.len()))
            .unwrap_or(&self.sys);
        let mic_slice: &[f32] = self
            .mic
            .get(..take.min(self.mic.len()))
            .unwrap_or(&self.mic);
        let mut out = Vec::with_capacity(take);
        for i in 0..take {
            let x = sys_slice.get(i).copied().unwrap_or(0.0);
            let y = if self.has_mic {
                mic_slice.get(i).copied().unwrap_or(0.0)
            } else {
                0.0
            };
            let mixed = if self.has_mic {
                (x * MIX_GAIN + y * MIX_GAIN).clamp(-1.0, 1.0)
            } else {
                x.clamp(-1.0, 1.0)
            };
            out.push(mixed);
        }
        // Advance: drop `take` from both buffers, bump base.
        let drop_sys = take.min(self.sys.len());
        self.sys.drain(..drop_sys);
        let drop_mic = take.min(self.mic.len());
        self.mic.drain(..drop_mic);
        self.base += take as u64;
        Some(out)
    }

    /// The current running offset in nanoseconds (start of the next chunk).
    pub fn offset_ns(&self) -> u64 {
        self.base.saturating_mul(1_000_000_000) / SAMPLE_RATE
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn mix_two_sums_with_half_gain() {
        let a = vec![1.0, 0.5, -0.5, 0.0];
        let b = vec![1.0, 0.5, 0.5, 0.0];
        // (1*0.5 + 1*0.5)=1.0 (clamped fine); (0.5*0.5+0.5*0.5)=0.5; (-0.25+0.25)=0.0; 0.
        assert_eq!(mix_two(&a, &b), vec![1.0, 0.5, 0.0, 0.0]);
    }

    #[test]
    fn mix_two_clamps_at_boundary() {
        // Boundary holds: 0.5·1 + 0.5·1 = 1.0, 0.5·(-1) + 0.5·(-1) = -1.0.
        assert_eq!(mix_two(&[1.0], &[1.0]), vec![1.0]);
        assert_eq!(mix_two(&[-1.0], &[-1.0]), vec![-1.0]);
    }

    #[test]
    fn mix_two_zero_pads_shorter_side() {
        assert_eq!(mix_two(&[1.0, 1.0, 1.0], &[1.0]), vec![1.0, 0.5, 0.5]);
        assert_eq!(mix_two(&[], &[0.4, 0.4]), vec![0.2, 0.2]);
    }

    #[test]
    fn pop_waits_for_both_streams_then_mixes() {
        let mut b = MixBuffer::new(true);
        // 16 samples = 1 ms at 16 kHz. Push 1 ms of system at offset 0.
        b.push(MixSource::System, 0, &[1.0; 16]);
        // Mic hasn't caught up — nothing ready.
        assert_eq!(b.pop(1, 1000), None);
        // Push 1 ms of mic.
        b.push(MixSource::Mic, 0, &[1.0; 16]);
        let chunk = b.pop(1, 1000).unwrap();
        assert_eq!(chunk.len(), 16);
        assert!(chunk.iter().all(|&s| (s - 1.0).abs() < 1e-6)); // 0.5+0.5
                                                                // Drained.
        assert_eq!(b.pop(1, 1000), None);
        assert_eq!(b.offset_ns(), 1_000_000); // 16 samples → 1 ms
    }

    #[test]
    fn pop_respects_min_and_max_samples() {
        let mut b = MixBuffer::new(false); // system only
        b.push(MixSource::System, 0, &[0.2; 100]);
        // min 200 → not enough, returns None.
        assert_eq!(b.pop(200, 1000), None);
        // min 50, max 30 → returns 30.
        let c = b.pop(50, 30).unwrap();
        assert_eq!(c.len(), 30);
        // Remaining 70.
        let c2 = b.pop(1, 1000).unwrap();
        assert_eq!(c2.len(), 70);
    }

    #[test]
    fn finish_drains_remaining_without_waiting_for_the_other_side() {
        let mut b = MixBuffer::new(true);
        b.push(MixSource::System, 0, &[0.5; 10]);
        // Mic never arrives; without finish, nothing pops.
        assert_eq!(b.pop(1, 1000), None);
        b.finish();
        let c = b.pop(1, 1000).unwrap();
        assert_eq!(c.len(), 10);
        // Mic side was empty → just system * 0.5.
        assert!(c.iter().all(|&s| (s - 0.25).abs() < 1e-6));
        assert_eq!(b.pop(1, 1000), None);
    }

    #[test]
    fn push_in_the_past_is_dropped_but_bumps_watermark() {
        let mut b = MixBuffer::new(false);
        b.push(MixSource::System, 0, &[1.0; 32]); // 2 ms
        let _ = b.pop(1, 32).unwrap(); // pop the first 32, base now 32
                                       // A late buffer for offset 0 (all in the past) — dropped, but the
                                       // watermark advances so a stall isn't inferred.
        b.push(MixSource::System, 0, &[9.9; 16]);
        // Nothing new available (watermark didn't go past base+previous).
        assert_eq!(b.pop(1, 1000), None);
        // A fresh in-future buffer pops normally.
        b.push(MixSource::System, 2_000_000, &[0.4; 16]); // offset 2 ms = index 32
        let c = b.pop(1, 1000).unwrap();
        assert_eq!(c.len(), 16);
        assert!(c.iter().all(|&s| (s - 0.4).abs() < 1e-6));
    }

    #[test]
    fn overlapping_pushes_within_a_stream_sum() {
        let mut b = MixBuffer::new(false);
        b.push(MixSource::System, 0, &[0.1; 16]);
        b.push(MixSource::System, 0, &[0.2; 16]); // same range → sums to 0.3
        let c = b.pop(1, 16).unwrap();
        assert!(c.iter().all(|&s| (s - 0.3).abs() < 1e-6));
    }

    #[test]
    fn offset_ns_tracks_popped_samples() {
        let mut b = MixBuffer::new(false);
        assert_eq!(b.offset_ns(), 0);
        b.push(MixSource::System, 0, &[0.0; 16_000]); // 1 second
        let _ = b.pop(1, 8_000).unwrap();
        assert_eq!(b.offset_ns(), 500_000_000); // 8000 / 16000 s = 0.5 s
    }
}
