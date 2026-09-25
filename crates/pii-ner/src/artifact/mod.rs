//! The bundled model artifact: manifest, tokenizer and int8 weights.

pub(crate) mod manifest;
mod quant;
pub(crate) mod weights;

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

pub(crate) use manifest::{Manifest, ModelConfig};
pub(crate) use weights::Weights;

use crate::error::LoadError;

/// Artifact layout version this crate reads.
pub const ARTIFACT_FORMAT_VERSION: u32 = 1;
/// SHA-256 of the `redact.tflite` release the converter pins (`tools/pins.json`).
pub const SOURCE_TFLITE_SHA256: &str =
    "ee36727f07e3237569e71427bfe661463a82e526f7e97e92b0fa583cad16ed27";

/// A verified artifact directory with its manifest and weight bytes in memory.
pub(crate) struct Artifact {
    pub manifest: Manifest,
    pub tokenizer_path: PathBuf,
    weights: Vec<u8>,
}

impl Artifact {
    pub(crate) fn open(dir: &Path) -> Result<Self, LoadError> {
        let manifest = Manifest::load(&dir.join("manifest.json"))?;
        if manifest.artifact_format_version != ARTIFACT_FORMAT_VERSION {
            return Err(LoadError::UnsupportedFormatVersion {
                found: manifest.artifact_format_version,
                supported: ARTIFACT_FORMAT_VERSION,
            });
        }
        if manifest.model.source_tflite_sha256 != SOURCE_TFLITE_SHA256 {
            return Err(LoadError::Manifest(format!(
                "artifact was converted from an unexpected model ({})",
                manifest.model.source_tflite_sha256
            )));
        }
        let weights_path = dir.join(&manifest.files.weights);
        let weights = read(&weights_path)?;
        verify_sha256(
            &manifest.files.weights,
            &weights,
            &manifest.files.weights_sha256,
        )?;
        let tokenizer_path = dir.join(&manifest.files.tokenizer);
        let tokenizer = read(&tokenizer_path)?;
        verify_sha256(
            &manifest.files.tokenizer,
            &tokenizer,
            &manifest.files.tokenizer_sha256,
        )?;
        Ok(Self {
            manifest,
            tokenizer_path,
            weights,
        })
    }

    pub(crate) fn weights(&self) -> Result<Weights<'_>, LoadError> {
        Weights::parse(&self.weights)
    }
}

fn read(path: &Path) -> Result<Vec<u8>, LoadError> {
    std::fs::read(path).map_err(|source| LoadError::Io {
        path: path.to_path_buf(),
        source,
    })
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn verify_sha256(file: &str, bytes: &[u8], expected: &str) -> Result<(), LoadError> {
    let actual = sha256_hex(bytes);
    if actual != expected {
        return Err(LoadError::Checksum {
            file: file.to_string(),
            expected: expected.to_string(),
            actual,
        });
    }
    Ok(())
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::*;

    #[test]
    fn source_sha_matches_converter_pins() {
        let pins: serde_json::Value =
            serde_json::from_str(include_str!("../../tools/pins.json")).unwrap();
        assert_eq!(
            pins["files"]["redact.tflite"]["sha256"],
            SOURCE_TFLITE_SHA256
        );
    }

    #[test]
    fn sha256_hex_is_lowercase_and_64_chars() {
        let digest = sha256_hex(b"");
        assert_eq!(
            digest,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn open_rejects_missing_dir_with_io_error() {
        let err = Artifact::open(Path::new("/definitely/not/here"))
            .map(|_| ())
            .unwrap_err();
        assert!(matches!(err, LoadError::Io { .. }), "{err}");
    }
}
