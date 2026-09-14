//! Multi-head self-attention with post-LayerNorm residual, BERT style.

use burn::module::Module;
use burn::nn::Linear;
use burn::tensor::activation::softmax;
use burn::tensor::backend::Backend;
use burn::tensor::{Bool, Tensor};

use super::{Normed, SplitLayerNorm};

const MASK_FILL: f32 = -1.0e9;

#[derive(Module, Debug)]
pub(crate) struct SelfAttention<B: Backend> {
    pub(crate) query: Linear<B>,
    pub(crate) key: Linear<B>,
    pub(crate) value: Linear<B>,
    pub(crate) output: Linear<B>,
    pub(crate) norm: SplitLayerNorm<B>,
    pub(crate) heads: usize,
    pub(crate) head_dim: usize,
    pub(crate) scale: f32,
}

impl<B: Backend> SelfAttention<B> {
    pub(crate) fn forward(&self, input: Normed<B>, mask_pad: Tensor<B, 2, Bool>) -> Normed<B> {
        let x = input.normalized;
        let [batch, seq, hidden] = x.dims();
        let heads = self.heads;
        let head_dim = self.head_dim;
        let split = |t: Tensor<B, 3>| t.reshape([batch, seq, heads, head_dim]).swap_dims(1, 2);
        let q = split(self.query.forward(x.clone()));
        let k = split(self.key.forward(x.clone()));
        let v = split(self.value.forward(x));
        let scores = q.matmul(k.swap_dims(2, 3)).mul_scalar(self.scale);
        let mask = mask_pad
            .reshape([batch, 1, 1, seq])
            .expand([batch, heads, seq, seq]);
        let probs = softmax(scores.mask_fill(mask, MASK_FILL), 3);
        let context = probs
            .matmul(v)
            .swap_dims(1, 2)
            .reshape([batch, seq, hidden]);
        self.norm
            .forward(input.residual + self.output.forward(context))
    }
}
