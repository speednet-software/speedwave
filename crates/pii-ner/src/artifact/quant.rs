//! Per-row symmetric int8 dequantization.

/// Why an int8 tensor could not be dequantized.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum QuantError {
    #[error("expected {expected} quantized values, found {found}")]
    ValueCount { expected: usize, found: usize },
    #[error("expected {expected} row scales, found {found}")]
    ScaleCount { expected: usize, found: usize },
}

pub(crate) fn dequantize_rows(
    quantized: &[i8],
    scales: &[f32],
    rows: usize,
    cols: usize,
) -> Result<Vec<f32>, QuantError> {
    if quantized.len() != rows * cols {
        return Err(QuantError::ValueCount {
            expected: rows * cols,
            found: quantized.len(),
        });
    }
    if scales.len() != rows {
        return Err(QuantError::ScaleCount {
            expected: rows,
            found: scales.len(),
        });
    }
    let mut out = Vec::with_capacity(rows * cols);
    for (row, scale) in quantized.chunks_exact(cols.max(1)).zip(scales) {
        out.extend(row.iter().map(|&q| f32::from(q) * scale));
    }
    Ok(out)
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test code")]
mod tests {
    use super::*;

    #[test]
    fn scales_each_row_independently() {
        let out = dequantize_rows(&[1, -2, 3, 4], &[0.5, 2.0], 2, 2).unwrap();
        assert_eq!(out, vec![0.5, -1.0, 6.0, 8.0]);
    }

    #[test]
    fn zero_scale_yields_zeros_and_extremes_survive() {
        let out = dequantize_rows(&[127, -128], &[0.0, 1.0], 2, 1).unwrap();
        assert_eq!(out, vec![0.0, -128.0]);
    }

    #[test]
    fn length_mismatches_are_errors() {
        assert_eq!(
            dequantize_rows(&[1, 2, 3], &[1.0], 2, 2),
            Err(QuantError::ValueCount {
                expected: 4,
                found: 3
            })
        );
        assert_eq!(
            dequantize_rows(&[1, 2, 3, 4], &[1.0], 2, 2),
            Err(QuantError::ScaleCount {
                expected: 2,
                found: 1
            })
        );
    }
}
