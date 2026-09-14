//! Typed access to the tensors stored in the safetensors weights file.

use safetensors::tensor::{Dtype, SafeTensors, TensorView};

use super::quant::dequantize_rows;
use crate::error::LoadError;

pub(crate) struct Weights<'a> {
    tensors: SafeTensors<'a>,
}

impl<'a> Weights<'a> {
    pub(crate) fn parse(bytes: &'a [u8]) -> Result<Self, LoadError> {
        let tensors =
            SafeTensors::deserialize(bytes).map_err(|e| LoadError::Safetensors(e.to_string()))?;
        Ok(Self { tensors })
    }

    fn view(&self, name: &str, dtype: Dtype, shape: &[usize]) -> Result<TensorView<'a>, LoadError> {
        let view = self
            .tensors
            .tensor(name)
            .map_err(|_| LoadError::MissingTensor(name.to_string()))?;
        if view.dtype() != dtype {
            return Err(LoadError::TensorDtype {
                name: name.to_string(),
                expected: dtype_name(dtype),
                found: format!("{:?}", view.dtype()),
            });
        }
        if view.shape() != shape {
            return Err(LoadError::TensorShape {
                name: name.to_string(),
                expected: shape.to_vec(),
                found: view.shape().to_vec(),
            });
        }
        Ok(view)
    }

    /// Reads an F32 tensor of exactly `shape` into a row-major vector.
    pub(crate) fn f32(&self, name: &str, shape: &[usize]) -> Result<Vec<f32>, LoadError> {
        let view = self.view(name, Dtype::F32, shape)?;
        view.data()
            .chunks_exact(4)
            .map(|chunk| {
                <[u8; 4]>::try_from(chunk)
                    .map(f32::from_le_bytes)
                    .map_err(|_| LoadError::Safetensors(format!("{name}: truncated f32 data")))
            })
            .collect()
    }

    /// Reads `{base}.weight.int8` `[rows, cols]` plus `{base}.weight.scale` `[rows]` and dequantizes.
    pub(crate) fn dequant(
        &self,
        base: &str,
        rows: usize,
        cols: usize,
    ) -> Result<Vec<f32>, LoadError> {
        let int8_name = format!("{base}.weight.int8");
        let view = self.view(&int8_name, Dtype::I8, &[rows, cols])?;
        let quantized: Vec<i8> = view.data().iter().map(|&b| b as i8).collect();
        let scales = self.f32(&format!("{base}.weight.scale"), &[rows])?;
        dequantize_rows(&quantized, &scales, rows, cols)
            .map_err(|e| LoadError::Safetensors(format!("{int8_name}: {e}")))
    }
}

fn dtype_name(dtype: Dtype) -> &'static str {
    match dtype {
        Dtype::F32 => "F32",
        Dtype::I8 => "I8",
        _ => "unsupported",
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::HashMap;

    use safetensors::tensor::{Dtype, TensorView};

    #[derive(Clone)]
    pub(crate) enum Stored {
        F32(Vec<usize>, Vec<f32>),
        I8(Vec<usize>, Vec<i8>),
    }

    #[expect(clippy::unwrap_used, reason = "test code")]
    pub(crate) fn serialize(tensors: &[(&str, Stored)]) -> Vec<u8> {
        let owned: Vec<(String, Dtype, Vec<usize>, Vec<u8>)> = tensors
            .iter()
            .map(|(name, stored)| match stored {
                Stored::F32(shape, values) => (
                    name.to_string(),
                    Dtype::F32,
                    shape.clone(),
                    values.iter().flat_map(|v| v.to_le_bytes()).collect(),
                ),
                Stored::I8(shape, values) => (
                    name.to_string(),
                    Dtype::I8,
                    shape.clone(),
                    values.iter().map(|&v| v as u8).collect(),
                ),
            })
            .collect();
        let views: Vec<(String, TensorView<'_>)> = owned
            .iter()
            .map(|(name, dtype, shape, data)| {
                (
                    name.clone(),
                    TensorView::new(*dtype, shape.clone(), data).unwrap(),
                )
            })
            .collect();
        let metadata: Option<HashMap<String, String>> = None;
        safetensors::tensor::serialize(views, metadata).unwrap()
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::test_support::{serialize, Stored};
    use super::*;

    #[test]
    fn reads_f32_and_dequantizes_int8_pairs() {
        let bytes = serialize(&[
            ("bias", Stored::F32(vec![2], vec![1.5, -2.0])),
            ("w.weight.int8", Stored::I8(vec![2, 2], vec![2, 4, -6, 8])),
            ("w.weight.scale", Stored::F32(vec![2], vec![0.5, 0.25])),
        ]);
        let weights = Weights::parse(&bytes).unwrap();
        assert_eq!(weights.f32("bias", &[2]).unwrap(), vec![1.5, -2.0]);
        assert_eq!(
            weights.dequant("w", 2, 2).unwrap(),
            vec![1.0, 2.0, -1.5, 2.0]
        );
    }

    #[test]
    fn reports_missing_shape_and_dtype_problems() {
        let bytes = serialize(&[("bias", Stored::F32(vec![2], vec![1.0, 2.0]))]);
        let weights = Weights::parse(&bytes).unwrap();
        assert!(matches!(
            weights.f32("nope", &[2]),
            Err(LoadError::MissingTensor(_))
        ));
        assert!(matches!(
            weights.f32("bias", &[3]),
            Err(LoadError::TensorShape { .. })
        ));
        assert!(matches!(
            weights.dequant("bias", 2, 1),
            Err(LoadError::MissingTensor(_))
        ));
        let bytes = serialize(&[
            ("x.weight.int8", Stored::F32(vec![1, 1], vec![1.0])),
            ("x.weight.scale", Stored::F32(vec![1], vec![1.0])),
        ]);
        let weights = Weights::parse(&bytes).unwrap();
        assert!(matches!(
            weights.dequant("x", 1, 1),
            Err(LoadError::TensorDtype { .. })
        ));
    }

    #[test]
    fn malformed_container_is_reported() {
        assert!(matches!(
            Weights::parse(b"not safetensors"),
            Err(LoadError::Safetensors(_))
        ));
    }
}
