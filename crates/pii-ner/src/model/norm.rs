//! LayerNorm split into the plain normalization and the affine step, as laid out in the
//! exported graph: linear layers read the former, the residual stream carries the latter.

use burn::module::{Module, Param};
use burn::tensor::backend::Backend;
use burn::tensor::Tensor;

#[derive(Module, Debug)]
pub(crate) struct SplitLayerNorm<B: Backend> {
    pub(crate) gamma: Param<Tensor<B, 1>>,
    pub(crate) beta: Param<Tensor<B, 1>>,
    pub(crate) epsilon: f64,
}

/// Both views of one LayerNorm output.
pub(crate) struct Normed<B: Backend> {
    pub(crate) normalized: Tensor<B, 3>,
    pub(crate) residual: Tensor<B, 3>,
}

impl<B: Backend> SplitLayerNorm<B> {
    pub(crate) fn forward(&self, x: Tensor<B, 3>) -> Normed<B> {
        let hidden = x.dims()[2];
        let mean = x.clone().mean_dim(2);
        let variance = x.clone().var_bias(2);
        let normalized = (x - mean) / (variance + self.epsilon).sqrt();
        let gamma = self.gamma.val().reshape([1, 1, hidden]);
        let beta = self.beta.val().reshape([1, 1, hidden]);
        let residual = normalized.clone() * gamma + beta;
        Normed {
            normalized,
            residual,
        }
    }
}

#[cfg(test)]
mod tests {
    use burn::module::ParamId;
    use burn::tensor::TensorData;

    use super::*;
    use crate::backend::CpuBackend;

    type B = CpuBackend;

    fn norm(gamma: Vec<f32>, beta: Vec<f32>) -> SplitLayerNorm<B> {
        let device = Default::default();
        let len = gamma.len();
        SplitLayerNorm {
            gamma: Param::initialized(
                ParamId::new(),
                Tensor::from_data(TensorData::new(gamma, [len]), &device),
            ),
            beta: Param::initialized(
                ParamId::new(),
                Tensor::from_data(TensorData::new(beta, [len]), &device),
            ),
            epsilon: 1e-12,
        }
    }

    fn values(t: Tensor<B, 3>) -> Vec<f32> {
        t.into_data().iter::<f32>().collect()
    }

    #[test]
    fn normalized_view_ignores_gamma_and_beta() {
        let n = norm(vec![2.0, 2.0, 2.0, 2.0], vec![1.0, 1.0, 1.0, 1.0]);
        let x = Tensor::<B, 3>::from_data(
            TensorData::new(vec![1.0_f32, 2.0, 3.0, 4.0], [1, 1, 4]),
            &Default::default(),
        );
        let out = n.forward(x);
        let scale = 1.25_f32.sqrt();
        let expected: Vec<f32> = [-1.5, -0.5, 0.5, 1.5].iter().map(|v| v / scale).collect();
        for (got, want) in values(out.normalized).iter().zip(&expected) {
            assert!((got - want).abs() < 1e-5, "{got} vs {want}");
        }
        for (got, want) in values(out.residual).iter().zip(&expected) {
            assert!((got - (2.0 * want + 1.0)).abs() < 1e-5, "{got} vs {want}");
        }
    }

    #[test]
    fn rows_are_normalized_independently() {
        let n = norm(vec![1.0, 1.0], vec![0.0, 0.0]);
        let x = Tensor::<B, 3>::from_data(
            TensorData::new(vec![10.0_f32, 20.0, -3.0, 3.0], [1, 2, 2]),
            &Default::default(),
        );
        let out = values(n.forward(x).normalized);
        assert!((out[0] + 1.0).abs() < 1e-5 && (out[1] - 1.0).abs() < 1e-5);
        assert!((out[2] + 1.0).abs() < 1e-5 && (out[3] - 1.0).abs() < 1e-5);
    }
}
