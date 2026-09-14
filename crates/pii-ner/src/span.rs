//! Public value types: detected spans and detection options.

use std::num::NonZeroUsize;

use crate::label::Label;

/// Model window length in tokens, including `<s>` and `</s>`.
pub const SEQ_LEN: usize = 256;
/// Content tokens per window.
pub const MAX_CONTENT: usize = SEQ_LEN - 2;
/// Token overlap between consecutive windows.
pub const STRIDE: usize = 64;
/// Token distance between consecutive window starts.
pub const WINDOW_STEP: usize = MAX_CONTENT - STRIDE;
/// Default confidence a span needs to be reported.
pub const DEFAULT_MIN_SCORE: f32 = 0.6;
/// Tokens below this probability are treated as `O` before BIOES decoding.
pub const LOW_SCORE: f32 = 0.3;

/// A detected entity, with UTF-8 byte offsets into the input text (end exclusive).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Span {
    /// First byte of the entity.
    pub start: usize,
    /// One past the last byte of the entity.
    pub end: usize,
    /// Entity category.
    pub label: Label,
    /// Highest token probability inside the span, in `0..=1`.
    pub confidence: f32,
}

/// Knobs for one detection call.
#[derive(Debug, Clone)]
pub struct DetectOptions {
    /// Minimum span confidence to report; non-finite values fall back to the default.
    pub min_score: f32,
    /// Windows batched into one forward pass.
    pub batch_windows: NonZeroUsize,
}

impl DetectOptions {
    pub(crate) fn effective_min_score(&self) -> f32 {
        if self.min_score.is_finite() {
            self.min_score.clamp(0.0, 1.0)
        } else {
            DEFAULT_MIN_SCORE
        }
    }
}

impl Default for DetectOptions {
    fn default() -> Self {
        Self {
            min_score: DEFAULT_MIN_SCORE,
            batch_windows: NonZeroUsize::MIN.saturating_add(15),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_constants_match_the_vendor_pipeline() {
        assert_eq!(MAX_CONTENT, 254);
        assert_eq!(WINDOW_STEP, 190);
    }

    #[test]
    fn min_score_is_sanitized() {
        let mut opts = DetectOptions::default();
        assert_eq!(opts.effective_min_score(), DEFAULT_MIN_SCORE);
        opts.min_score = f32::NAN;
        assert_eq!(opts.effective_min_score(), DEFAULT_MIN_SCORE);
        opts.min_score = 7.0;
        assert_eq!(opts.effective_min_score(), 1.0);
        opts.min_score = -1.0;
        assert_eq!(opts.effective_min_score(), 0.0);
        assert_eq!(DetectOptions::default().batch_windows.get(), 16);
    }
}
