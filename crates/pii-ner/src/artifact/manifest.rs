//! `manifest.json` as written by `tools/fetch_and_convert.py`.

use std::path::Path;

use crate::error::LoadError;

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct Manifest {
    pub artifact_format_version: u32,
    pub model: ModelInfo,
    pub files: Files,
    pub config: ModelConfig,
    pub labels: Vec<String>,
    pub pipeline: PipelineDefaults,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct ModelInfo {
    pub name: String,
    pub revision: String,
    pub version: String,
    pub source_tflite_sha256: String,
    pub param_count: u64,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct Files {
    pub weights: String,
    pub weights_sha256: String,
    pub tokenizer: String,
    pub tokenizer_sha256: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct ModelConfig {
    pub vocab_size: usize,
    pub hidden_size: usize,
    pub num_hidden_layers: usize,
    pub num_attention_heads: usize,
    pub head_dim: usize,
    pub intermediate_size: usize,
    pub max_seq_len: usize,
    pub layer_norm_eps: f64,
    pub attention_scale: f32,
    pub gelu_approximate: bool,
    pub num_labels: usize,
    pub pad_token_id: i32,
    pub cls_token_id: i32,
    pub sep_token_id: i32,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct PipelineDefaults {
    pub max_content: usize,
    pub stride: usize,
    pub min_score: f32,
    pub low_score: f32,
}

impl Manifest {
    pub(crate) fn load(path: &Path) -> Result<Self, LoadError> {
        let text = std::fs::read_to_string(path).map_err(|source| LoadError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        Self::parse(&text)
    }

    pub(crate) fn parse(text: &str) -> Result<Self, LoadError> {
        let manifest: Manifest =
            serde_json::from_str(text).map_err(|e| LoadError::Manifest(e.to_string()))?;
        manifest.validate()?;
        Ok(manifest)
    }

    fn validate(&self) -> Result<(), LoadError> {
        let cfg = &self.config;
        if cfg.num_attention_heads * cfg.head_dim != cfg.hidden_size {
            return Err(LoadError::Config(format!(
                "{} heads x {} does not equal hidden size {}",
                cfg.num_attention_heads, cfg.head_dim, cfg.hidden_size
            )));
        }
        if cfg.max_seq_len != crate::span::SEQ_LEN {
            return Err(LoadError::Config(format!(
                "max_seq_len {} differs from the compiled window {}",
                cfg.max_seq_len,
                crate::span::SEQ_LEN
            )));
        }
        if self.labels.len() != cfg.num_labels {
            return Err(LoadError::Labels(format!(
                "{} labels for {} classes",
                self.labels.len(),
                cfg.num_labels
            )));
        }
        if self.pipeline.max_content != crate::span::MAX_CONTENT
            || self.pipeline.stride != crate::span::STRIDE
        {
            return Err(LoadError::Config(format!(
                "pipeline window {}/{} differs from the compiled {}/{}",
                self.pipeline.max_content,
                self.pipeline.stride,
                crate::span::MAX_CONTENT,
                crate::span::STRIDE
            )));
        }
        if !(0.0..=1.0).contains(&self.pipeline.min_score)
            || !(0.0..=1.0).contains(&self.pipeline.low_score)
        {
            return Err(LoadError::Config(
                "pipeline thresholds must be in 0..=1".to_string(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn sample_manifest_json(
    labels: &[&str],
    hidden: usize,
    heads: usize,
    layers: usize,
    intermediate: usize,
    vocab: usize,
) -> String {
    let labels: Vec<String> = labels.iter().map(|l| format!("\"{l}\"")).collect();
    format!(
        r#"{{
  "artifact_format_version": 1,
  "model": {{"name": "test", "revision": "v0", "version": "0", "source_tflite_sha256": "{sha}", "source_tflite_size": 1, "param_count": 1}},
  "files": {{"weights": "w.safetensors", "weights_sha256": "", "tokenizer": "tokenizer.json", "tokenizer_sha256": ""}},
  "config": {{"vocab_size": {vocab}, "hidden_size": {hidden}, "num_hidden_layers": {layers}, "num_attention_heads": {heads},
             "head_dim": {head_dim}, "intermediate_size": {intermediate}, "max_seq_len": 256, "layer_norm_eps": 1e-12,
             "attention_scale": {scale}, "gelu_approximate": false, "num_labels": {n}, "pad_token_id": 1, "cls_token_id": 0, "sep_token_id": 2}},
  "labels": [{labels}],
  "pipeline": {{"max_content": 254, "stride": 64, "min_score": 0.6, "low_score": 0.3}}
}}"#,
        sha = super::SOURCE_TFLITE_SHA256,
        head_dim = hidden / heads,
        scale = 1.0 / ((hidden / heads) as f32).sqrt(),
        n = labels.len(),
        labels = labels.join(", ")
    )
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::*;

    #[test]
    fn parses_a_consistent_manifest() {
        let text =
            sample_manifest_json(&["O", "B-SSN", "I-SSN", "E-SSN", "S-SSN"], 8, 2, 1, 16, 12);
        let manifest = Manifest::parse(&text).unwrap();
        assert_eq!(manifest.config.head_dim, 4);
        assert_eq!(manifest.labels.len(), 5);
        assert_eq!(manifest.pipeline.stride, 64);
    }

    #[test]
    fn rejects_head_layout_and_label_count_mismatches() {
        let text = sample_manifest_json(&["O", "B-SSN"], 8, 2, 1, 16, 12)
            .replace("\"head_dim\": 4", "\"head_dim\": 3");
        assert!(matches!(Manifest::parse(&text), Err(LoadError::Config(_))));
        let text = sample_manifest_json(&["O", "B-SSN"], 8, 2, 1, 16, 12)
            .replace("\"num_labels\": 2", "\"num_labels\": 3");
        assert!(matches!(Manifest::parse(&text), Err(LoadError::Labels(_))));
        let text = sample_manifest_json(&["O"], 8, 2, 1, 16, 12)
            .replace("\"stride\": 64", "\"stride\": 32");
        assert!(matches!(Manifest::parse(&text), Err(LoadError::Config(_))));
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(matches!(Manifest::parse("{"), Err(LoadError::Manifest(_))));
    }
}
