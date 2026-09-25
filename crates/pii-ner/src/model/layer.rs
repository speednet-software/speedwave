//! One encoder layer: self-attention block plus the GELU feed-forward block.

use burn::module::Module;
use burn::nn::Linear;
use burn::tensor::activation::{gelu, gelu_approximate};
use burn::tensor::backend::Backend;
use burn::tensor::{Bool, Tensor};

use super::{Normed, SelfAttention, SplitLayerNorm};

#[derive(Module, Debug)]
pub(crate) struct BertLayer<B: Backend> {
    pub(crate) attention: SelfAttention<B>,
    pub(crate) intermediate: Linear<B>,
    pub(crate) output: Linear<B>,
    pub(crate) norm: SplitLayerNorm<B>,
    pub(crate) gelu_approximate: bool,
}

impl<B: Backend> BertLayer<B> {
    pub(crate) fn forward(&self, input: Normed<B>, mask_pad: Tensor<B, 2, Bool>) -> Normed<B> {
        let attended = self.attention.forward(input, mask_pad);
        let hidden = self.intermediate.forward(attended.normalized);
        let activated = if self.gelu_approximate {
            gelu_approximate(hidden)
        } else {
            gelu(hidden)
        };
        self.norm
            .forward(attended.residual + self.output.forward(activated))
    }
}
