//! Word, position and token-type embeddings followed by the split LayerNorm.

use burn::module::{Module, Param};
use burn::nn::Embedding;
use burn::tensor::backend::Backend;
use burn::tensor::{Int, Tensor};

use super::{Normed, SplitLayerNorm};

#[derive(Module, Debug)]
pub(crate) struct BertEmbeddings<B: Backend> {
    pub(crate) word: Embedding<B>,
    pub(crate) position: Param<Tensor<B, 2>>,
    pub(crate) token_type: Param<Tensor<B, 1>>,
    pub(crate) norm: SplitLayerNorm<B>,
}

impl<B: Backend> BertEmbeddings<B> {
    pub(crate) fn forward(&self, ids: Tensor<B, 2, Int>) -> Normed<B> {
        let [batch, seq] = ids.dims();
        let words = self.word.forward(ids);
        let hidden = words.dims()[2];
        let positions = self
            .position
            .val()
            .slice([0..seq])
            .unsqueeze::<3>()
            .expand([batch, seq, hidden]);
        let token_type = self
            .token_type
            .val()
            .reshape([1, 1, hidden])
            .expand([batch, seq, hidden]);
        self.norm.forward(words + positions + token_type)
    }
}
