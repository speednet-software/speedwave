//! Host-side PII span detection: the Redact BERT token classifier on burn, no vendor runtime.

pub mod artifact;
mod backend;
mod error;
mod label;
mod model;
mod pipeline;
mod span;

pub use backend::{
    gpu_available, gpu_device, load_auto, CpuBackend, Device, DevicePreference, GpuBackend,
};
pub use error::{DetectError, LoadError};
pub use label::{Label, LabelParseError};
pub use pipeline::{Detector, TokenInfo, WindowPrediction};
pub use span::{
    DetectOptions, Span, DEFAULT_MIN_SCORE, LOW_SCORE, MAX_CONTENT, SEQ_LEN, STRIDE, WINDOW_STEP,
};

/// A loaded detector, independent of the backend it runs on.
pub trait Detect: Send + Sync {
    /// Spans in one text.
    fn detect(&self, text: &str, opts: &DetectOptions) -> Result<Vec<Span>, DetectError>;
    /// Spans per text, windows of all texts batched together.
    fn detect_batch(
        &self,
        texts: &[&str],
        opts: &DetectOptions,
    ) -> Result<Vec<Vec<Span>>, DetectError>;
    /// Device class the detector runs on.
    fn device(&self) -> Device;
    /// Model name, version and size.
    fn description(&self) -> &str;
}
