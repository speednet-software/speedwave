//! The BERT token classifier assembled from burn `nn` building blocks.
//!
//! Every LayerNorm is split like in the exported graph: gamma and beta are folded into the
//! following linear layers, so those read the plain normalization while the residual stream
//! keeps the affine output; the classifier reads the plain normalization of the last layer.

mod attention;
pub(crate) mod build;
mod embeddings;
mod layer;
mod norm;

use burn::module::Module;
use burn::nn::Linear;
use burn::tensor::activation::softmax;
use burn::tensor::backend::Backend;
use burn::tensor::{Bool, Int, Tensor};

use crate::artifact::ModelConfig;
use crate::error::LoadError;
pub(crate) use attention::SelfAttention;
pub(crate) use build::build_model;
pub(crate) use embeddings::BertEmbeddings;
pub(crate) use layer::BertLayer;
pub(crate) use norm::{Normed, SplitLayerNorm};

/// Shape and numeric constants of the model, taken from the artifact manifest.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BertConfig {
    pub hidden: usize,
    pub heads: usize,
    pub head_dim: usize,
    pub layers: usize,
    pub intermediate: usize,
    pub vocab: usize,
    pub seq_len: usize,
    pub num_labels: usize,
    pub layer_norm_eps: f64,
    pub attention_scale: f32,
    pub gelu_approximate: bool,
    pub pad_id: i32,
    pub cls_id: i32,
    pub sep_id: i32,
}

impl BertConfig {
    pub(crate) fn from_manifest(cfg: &ModelConfig) -> Result<Self, LoadError> {
        if cfg.num_hidden_layers == 0 || cfg.hidden_size == 0 || cfg.num_labels == 0 {
            return Err(LoadError::Config(
                "layers, hidden size and labels must be non-zero".into(),
            ));
        }
        Ok(Self {
            hidden: cfg.hidden_size,
            heads: cfg.num_attention_heads,
            head_dim: cfg.head_dim,
            layers: cfg.num_hidden_layers,
            intermediate: cfg.intermediate_size,
            vocab: cfg.vocab_size,
            seq_len: cfg.max_seq_len,
            num_labels: cfg.num_labels,
            layer_norm_eps: cfg.layer_norm_eps,
            attention_scale: cfg.attention_scale,
            gelu_approximate: cfg.gelu_approximate,
            pad_id: cfg.pad_token_id,
            cls_id: cfg.cls_token_id,
            sep_id: cfg.sep_token_id,
        })
    }
}

/// Embeddings, encoder layers and the per-token classification head.
#[derive(Module, Debug)]
pub(crate) struct BertTokenClassifier<B: Backend> {
    embeddings: BertEmbeddings<B>,
    layers: Vec<BertLayer<B>>,
    classifier: Linear<B>,
}

impl<B: Backend> BertTokenClassifier<B> {
    /// Logits `[batch, seq, num_labels]`; `mask_pad` is true on padding positions.
    pub(crate) fn forward(
        &self,
        ids: Tensor<B, 2, Int>,
        mask_pad: Tensor<B, 2, Bool>,
    ) -> Tensor<B, 3> {
        let mut state = self.embeddings.forward(ids);
        for layer in &self.layers {
            state = layer.forward(state, mask_pad.clone());
        }
        self.classifier.forward(state.normalized)
    }

    /// Per-token best class and its softmax probability, both `[batch, seq]`.
    pub(crate) fn predict(
        &self,
        ids: Tensor<B, 2, Int>,
        mask_pad: Tensor<B, 2, Bool>,
    ) -> (Tensor<B, 2, Int>, Tensor<B, 2>) {
        let probs = softmax(self.forward(ids, mask_pad), 2);
        let [batch, seq, _] = probs.dims();
        let classes = probs.clone().argmax(2).reshape([batch, seq]);
        let best = probs.max_dim(2).reshape([batch, seq]);
        (classes, best)
    }
}
