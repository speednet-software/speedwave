//! Host-side PII span detection: the Redact BERT token classifier on burn, no vendor runtime.

mod artifact;
mod backend;
mod error;
mod label;
mod model;
mod pipeline;
mod span;

pub use backend::{load_auto, Device, DevicePreference};
pub use error::{DetectError, LoadError};
pub use label::Label;
pub use span::{DetectOptions, Span, MAX_CONTENT};

/// A loaded detector, independent of the backend it runs on.
pub trait Detect: Send + Sync {
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
