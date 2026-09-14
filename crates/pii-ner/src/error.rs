//! Errors raised while loading the artifact or running detection.

use std::path::PathBuf;

/// Why an artifact could not be turned into a ready detector.
#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    /// A file under the artifact directory could not be read.
    #[error("cannot read {path}: {source}")]
    Io {
        /// The file that failed.
        path: PathBuf,
        /// The underlying I/O error.
        #[source]
        source: std::io::Error,
    },
    /// `manifest.json` is not valid for this crate.
    #[error("manifest.json is invalid: {0}")]
    Manifest(String),
    /// The artifact was produced for another format version.
    #[error("artifact format version {found} is not supported (expected {supported})")]
    UnsupportedFormatVersion {
        /// Version found in the manifest.
        found: u32,
        /// Version this crate reads.
        supported: u32,
    },
    /// A file's SHA-256 does not match the manifest.
    #[error("{file}: sha256 {actual} does not match manifest {expected}")]
    Checksum {
        /// Artifact-relative file name.
        file: String,
        /// Digest recorded in the manifest.
        expected: String,
        /// Digest of the file on disk.
        actual: String,
    },
    /// `tokenizer.json` could not be loaded.
    #[error("tokenizer.json could not be loaded: {0}")]
    Tokenizer(String),
    /// The safetensors container is malformed.
    #[error("weights file is malformed: {0}")]
    Safetensors(String),
    /// A tensor the model needs is absent from the weights file.
    #[error("weights file lacks tensor {0}")]
    MissingTensor(String),
    /// A tensor has a shape other than the one the model config implies.
    #[error("tensor {name} has shape {found:?}, expected {expected:?}")]
    TensorShape {
        /// Tensor key in the weights file.
        name: String,
        /// Shape implied by the manifest config.
        expected: Vec<usize>,
        /// Shape found in the weights file.
        found: Vec<usize>,
    },
    /// A tensor is stored with a dtype the loader does not accept for that key.
    #[error("tensor {name} has dtype {found}, expected {expected}")]
    TensorDtype {
        /// Tensor key in the weights file.
        name: String,
        /// Accepted dtype.
        expected: &'static str,
        /// Stored dtype.
        found: String,
    },
    /// The manifest label list is not a valid BIOES tag set over known labels.
    #[error("label set is invalid: {0}")]
    Labels(String),
    /// A config value is outside what the model code supports.
    #[error("model config is invalid: {0}")]
    Config(String),
    /// A GPU was requested but no usable adapter exists.
    #[error("no usable GPU adapter")]
    NoGpu,
}

/// Why a detection call failed.
#[derive(Debug, thiserror::Error)]
pub enum DetectError {
    /// The tokenizer rejected the input.
    #[error("tokenizer failed: {0}")]
    Tokenizer(String),
    /// The model produced output of an unexpected shape or dtype.
    #[error("model output could not be read: {0}")]
    Model(String),
    /// The tokenizer reported an offset that is not a char boundary of the input.
    #[error("token {token} has offsets {start}..{end} outside char boundaries")]
    Offsets {
        /// Token position in the encoding.
        token: usize,
        /// Reported start byte.
        start: usize,
        /// Reported end byte.
        end: usize,
    },
}
