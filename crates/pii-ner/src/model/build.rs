//! Builds the burn modules from the dequantized artifact tensors.

use burn::module::{Param, ParamId};
use burn::nn::{Embedding, Linear};
use burn::tensor::backend::Backend;
use burn::tensor::{Tensor, TensorData};

use super::{
    BertConfig, BertEmbeddings, BertLayer, BertTokenClassifier, SelfAttention, SplitLayerNorm,
};
use crate::artifact::Weights;
use crate::error::LoadError;

pub(crate) fn build_model<B: Backend>(
    weights: &Weights<'_>,
    cfg: &BertConfig,
    device: &B::Device,
) -> Result<BertTokenClassifier<B>, LoadError> {
    let embeddings = BertEmbeddings {
        word: embedding(
            weights,
            "bert.embeddings.word_embeddings",
            cfg.vocab,
            cfg.hidden,
            device,
        )?,
        position: param(tensor2(
            weights.f32(
                "bert.embeddings.position_embeddings.weight",
                &[cfg.seq_len, cfg.hidden],
            )?,
            [cfg.seq_len, cfg.hidden],
            device,
        )),
        token_type: param(tensor1(
            weights.f32(
                "bert.embeddings.token_type_embeddings.weight",
                &[cfg.hidden],
            )?,
            device,
        )),
        norm: layer_norm(
            weights,
            "bert.embeddings.LayerNorm",
            cfg.hidden,
            cfg.layer_norm_eps,
            device,
        )?,
    };
    let mut layers = Vec::with_capacity(cfg.layers);
    for i in 0..cfg.layers {
        let prefix = format!("bert.encoder.layer.{i}");
        let attention = SelfAttention {
            query: linear(
                weights,
                &format!("{prefix}.attention.self.query"),
                cfg.hidden,
                cfg.hidden,
                device,
            )?,
            key: linear(
                weights,
                &format!("{prefix}.attention.self.key"),
                cfg.hidden,
                cfg.hidden,
                device,
            )?,
            value: linear(
                weights,
                &format!("{prefix}.attention.self.value"),
                cfg.hidden,
                cfg.hidden,
                device,
            )?,
            output: linear(
                weights,
                &format!("{prefix}.attention.output.dense"),
                cfg.hidden,
                cfg.hidden,
                device,
            )?,
            norm: layer_norm(
                weights,
                &format!("{prefix}.attention.output.LayerNorm"),
                cfg.hidden,
                cfg.layer_norm_eps,
                device,
            )?,
            heads: cfg.heads,
            head_dim: cfg.head_dim,
            scale: cfg.attention_scale,
        };
        layers.push(BertLayer {
            attention,
            intermediate: linear(
                weights,
                &format!("{prefix}.intermediate.dense"),
                cfg.intermediate,
                cfg.hidden,
                device,
            )?,
            output: linear(
                weights,
                &format!("{prefix}.output.dense"),
                cfg.hidden,
                cfg.intermediate,
                device,
            )?,
            norm: layer_norm(
                weights,
                &format!("{prefix}.output.LayerNorm"),
                cfg.hidden,
                cfg.layer_norm_eps,
                device,
            )?,
            gelu_approximate: cfg.gelu_approximate,
        });
    }
    let classifier = linear(weights, "classifier", cfg.num_labels, cfg.hidden, device)?;
    Ok(BertTokenClassifier {
        embeddings,
        layers,
        classifier,
    })
}

fn param<T: burn::module::Parameter>(value: T) -> Param<T> {
    Param::initialized(ParamId::new(), value)
}

fn tensor1<B: Backend>(values: Vec<f32>, device: &B::Device) -> Tensor<B, 1> {
    let len = values.len();
    Tensor::from_data(TensorData::new(values, [len]), device)
}

fn tensor2<B: Backend>(values: Vec<f32>, shape: [usize; 2], device: &B::Device) -> Tensor<B, 2> {
    Tensor::from_data(TensorData::new(values, shape), device)
}

fn linear<B: Backend>(
    weights: &Weights<'_>,
    base: &str,
    out_features: usize,
    in_features: usize,
    device: &B::Device,
) -> Result<Linear<B>, LoadError> {
    let weight = tensor2(
        weights.dequant(base, out_features, in_features)?,
        [out_features, in_features],
        device,
    )
    .transpose();
    let bias = tensor1(
        weights.f32(&format!("{base}.bias"), &[out_features])?,
        device,
    );
    Ok(Linear {
        weight: param(weight),
        bias: Some(param(bias)),
    })
}

fn embedding<B: Backend>(
    weights: &Weights<'_>,
    base: &str,
    rows: usize,
    hidden: usize,
    device: &B::Device,
) -> Result<Embedding<B>, LoadError> {
    let table = tensor2(weights.dequant(base, rows, hidden)?, [rows, hidden], device);
    Ok(Embedding {
        weight: param(table),
    })
}

fn layer_norm<B: Backend>(
    weights: &Weights<'_>,
    base: &str,
    hidden: usize,
    eps: f64,
    device: &B::Device,
) -> Result<SplitLayerNorm<B>, LoadError> {
    let gamma = tensor1(weights.f32(&format!("{base}.weight"), &[hidden])?, device);
    let beta = tensor1(weights.f32(&format!("{base}.bias"), &[hidden])?, device);
    Ok(SplitLayerNorm {
        gamma: param(gamma),
        beta: param(beta),
        epsilon: eps,
    })
}

#[cfg(test)]
pub(crate) mod test_support {
    use crate::artifact::weights::test_support::Stored;

    use super::BertConfig;

    pub(crate) fn tiny_config(vocab: usize, num_labels: usize) -> BertConfig {
        BertConfig {
            hidden: 8,
            heads: 2,
            head_dim: 4,
            layers: 1,
            intermediate: 16,
            vocab,
            seq_len: crate::span::SEQ_LEN,
            num_labels,
            layer_norm_eps: 1e-12,
            attention_scale: 0.5,
            gelu_approximate: false,
            pad_id: 1,
            cls_id: 0,
            sep_id: 2,
        }
    }

    fn pattern(len: usize, seed: u32) -> Vec<f32> {
        (0..len)
            .map(|i| {
                let x = (i as u32).wrapping_mul(2_654_435_761).wrapping_add(seed) >> 16;
                ((x % 2000) as f32 - 1000.0) / 1000.0
            })
            .collect()
    }

    fn int8_pattern(len: usize, seed: u32) -> Vec<i8> {
        (0..len)
            .map(|i| {
                ((((i as u32).wrapping_mul(40_503).wrapping_add(seed) >> 8) % 200) as i32 - 100)
                    as i8
            })
            .collect()
    }

    fn linear(
        out: Vec<(&str, Stored)>,
        base: &str,
        rows: usize,
        cols: usize,
        seed: u32,
    ) -> Vec<(String, Stored)> {
        let mut result: Vec<(String, Stored)> =
            out.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        result.push((
            format!("{base}.weight.int8"),
            Stored::I8(vec![rows, cols], int8_pattern(rows * cols, seed)),
        ));
        result.push((
            format!("{base}.weight.scale"),
            Stored::F32(vec![rows], vec![0.02; rows]),
        ));
        result.push((
            format!("{base}.bias"),
            Stored::F32(vec![rows], pattern(rows, seed + 7)),
        ));
        result
    }

    fn norm(prefix: &str, hidden: usize, seed: u32) -> Vec<(String, Stored)> {
        let gamma: Vec<f32> = pattern(hidden, seed)
            .into_iter()
            .map(|v| 1.0 + v / 2.0)
            .collect();
        vec![
            (format!("{prefix}.weight"), Stored::F32(vec![hidden], gamma)),
            (
                format!("{prefix}.bias"),
                Stored::F32(vec![hidden], pattern(hidden, seed + 1)),
            ),
        ]
    }

    /// A deterministic pseudo-random weight set matching `tiny_config`.
    pub(crate) fn tiny_weights(cfg: &BertConfig) -> Vec<(String, Stored)> {
        let mut all: Vec<(String, Stored)> = Vec::new();
        all.extend(
            linear(
                vec![],
                "bert.embeddings.word_embeddings",
                cfg.vocab,
                cfg.hidden,
                1,
            )
            .into_iter()
            .filter(|(k, _)| !k.ends_with(".bias")),
        );
        all.push((
            "bert.embeddings.position_embeddings.weight".into(),
            Stored::F32(
                vec![cfg.seq_len, cfg.hidden],
                pattern(cfg.seq_len * cfg.hidden, 3),
            ),
        ));
        all.push((
            "bert.embeddings.token_type_embeddings.weight".into(),
            Stored::F32(vec![cfg.hidden], pattern(cfg.hidden, 5)),
        ));
        all.extend(norm("bert.embeddings.LayerNorm", cfg.hidden, 41));
        for i in 0..cfg.layers {
            let p = format!("bert.encoder.layer.{i}");
            all.extend(linear(
                vec![],
                &format!("{p}.attention.self.query"),
                cfg.hidden,
                cfg.hidden,
                11 + i as u32,
            ));
            all.extend(linear(
                vec![],
                &format!("{p}.attention.self.key"),
                cfg.hidden,
                cfg.hidden,
                13 + i as u32,
            ));
            all.extend(linear(
                vec![],
                &format!("{p}.attention.self.value"),
                cfg.hidden,
                cfg.hidden,
                17 + i as u32,
            ));
            all.extend(linear(
                vec![],
                &format!("{p}.attention.output.dense"),
                cfg.hidden,
                cfg.hidden,
                19 + i as u32,
            ));
            all.extend(norm(
                &format!("{p}.attention.output.LayerNorm"),
                cfg.hidden,
                43 + i as u32,
            ));
            all.extend(linear(
                vec![],
                &format!("{p}.intermediate.dense"),
                cfg.intermediate,
                cfg.hidden,
                23 + i as u32,
            ));
            all.extend(linear(
                vec![],
                &format!("{p}.output.dense"),
                cfg.hidden,
                cfg.intermediate,
                29 + i as u32,
            ));
            all.extend(norm(
                &format!("{p}.output.LayerNorm"),
                cfg.hidden,
                47 + i as u32,
            ));
        }
        all.extend(linear(vec![], "classifier", cfg.num_labels, cfg.hidden, 31));
        all
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use burn::tensor::{Int, Tensor, TensorData};

    use super::test_support::{tiny_config, tiny_weights};
    use super::*;
    use crate::artifact::weights::test_support::serialize;
    use crate::backend::CpuBackend;

    type B = CpuBackend;

    fn model(cfg: &BertConfig) -> BertTokenClassifier<B> {
        let stored = tiny_weights(cfg);
        let refs: Vec<(&str, _)> = stored
            .iter()
            .map(|(k, v)| (k.as_str(), v.clone()))
            .collect();
        let bytes = serialize(&refs);
        let weights = Weights::parse(&bytes).unwrap();
        build_model::<B>(&weights, cfg, &Default::default()).unwrap()
    }

    fn inputs(rows: &[Vec<i32>]) -> (Tensor<B, 2, Int>, Tensor<B, 2, burn::tensor::Bool>) {
        let seq = rows[0].len();
        let ids: Vec<i32> = rows.iter().flatten().copied().collect();
        let mask: Vec<i32> = rows
            .iter()
            .flatten()
            .map(|&id| i32::from(id != 1))
            .collect();
        let device = Default::default();
        let ids = Tensor::<B, 2, Int>::from_data(TensorData::new(ids, [rows.len(), seq]), &device);
        let mask =
            Tensor::<B, 2, Int>::from_data(TensorData::new(mask, [rows.len(), seq]), &device);
        (ids, mask.equal_elem(0))
    }

    fn padded(real: &[i32]) -> Vec<i32> {
        let mut row = real.to_vec();
        row.resize(crate::span::SEQ_LEN, 1);
        row
    }

    #[test]
    fn logits_have_the_classifier_shape() {
        let cfg = tiny_config(16, 5);
        let m = model(&cfg);
        let (ids, mask) = inputs(&[padded(&[0, 4, 5, 2])]);
        assert_eq!(m.forward(ids, mask).dims(), [1, crate::span::SEQ_LEN, 5]);
    }

    #[test]
    fn padding_does_not_change_real_token_logits() {
        let cfg = tiny_config(16, 5);
        let m = model(&cfg);
        let (ids_a, mask_a) = inputs(&[padded(&[0, 4, 5, 6, 2])]);
        let mut longer = padded(&[0, 4, 5, 6, 2]);
        longer[5] = 7;
        longer[6] = 8;
        let (ids_b, mask_b) = inputs(&[longer]);
        let a = m.forward(ids_a, mask_a).into_data();
        let b = m.forward(ids_b, mask_b).into_data();
        let a: Vec<f32> = a.iter::<f32>().collect();
        let b: Vec<f32> = b.iter::<f32>().collect();
        for (x, y) in a.iter().zip(&b).take(5 * 5) {
            assert!((x - y).abs() < 1e-3, "{x} vs {y}");
        }
        assert!(a
            .iter()
            .zip(&b)
            .skip(5 * 5)
            .take(2 * 5)
            .any(|(x, y)| (x - y).abs() > 1e-6));
    }

    #[test]
    fn batching_matches_single_rows() {
        let cfg = tiny_config(16, 5);
        let m = model(&cfg);
        let row_a = padded(&[0, 4, 5, 2]);
        let row_b = padded(&[0, 9, 10, 11, 12, 2]);
        let (ids, mask) = inputs(&[row_a.clone(), row_b.clone()]);
        let (classes, probs) = m.predict(ids, mask);
        assert_eq!(classes.dims(), [2, crate::span::SEQ_LEN]);
        let batched: Vec<f32> = probs.into_data().iter::<f32>().collect();
        let (ids_b, mask_b) = inputs(&[row_b]);
        let single: Vec<f32> = m
            .predict(ids_b, mask_b)
            .1
            .into_data()
            .iter::<f32>()
            .collect();
        for (x, y) in batched
            .iter()
            .skip(crate::span::SEQ_LEN)
            .zip(&single)
            .take(6)
        {
            assert!((x - y).abs() < 1e-4, "{x} vs {y}");
        }
        assert!(single.iter().take(6).all(|p| (0.0..=1.0).contains(p)));
    }

    #[test]
    fn attention_scale_changes_the_output() {
        let cfg = tiny_config(16, 5);
        let mut scaled = cfg.clone();
        scaled.attention_scale = 0.05;
        let (ids, mask) = inputs(&[padded(&[0, 4, 5, 6, 7, 2])]);
        let a: Vec<f32> = model(&cfg)
            .forward(ids.clone(), mask.clone())
            .into_data()
            .iter::<f32>()
            .collect();
        let b: Vec<f32> = model(&scaled)
            .forward(ids, mask)
            .into_data()
            .iter::<f32>()
            .collect();
        assert!(a
            .iter()
            .zip(&b)
            .take(6 * 5)
            .any(|(x, y)| (x - y).abs() > 1e-5));
    }

    #[test]
    fn missing_tensor_is_reported_by_name() {
        let cfg = tiny_config(16, 5);
        let stored = tiny_weights(&cfg);
        let refs: Vec<(&str, _)> = stored
            .iter()
            .filter(|(k, _)| k != "classifier.bias")
            .map(|(k, v)| (k.as_str(), v.clone()))
            .collect();
        let bytes = serialize(&refs);
        let weights = Weights::parse(&bytes).unwrap();
        let err = build_model::<B>(&weights, &cfg, &Default::default()).unwrap_err();
        assert!(
            matches!(err, LoadError::MissingTensor(ref name) if name == "classifier.bias"),
            "{err}"
        );
    }
}
